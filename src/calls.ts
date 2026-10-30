import type { DirectCall, ClientOp } from "@distopic/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.ts";
import { one, run } from "./db.ts";
import { badRequest, forbidden } from "./errors.ts";
import { sendToUser, connectionsOf, type Connection } from "./events.ts";
import { areFriends } from "./activity.ts";
import { newId } from "./ids.ts";
import { parse } from "./validate.ts";

const calls = new Map<string, { call: DirectCall; timer?: ReturnType<typeof setTimeout>; callerConnectionId: number; calleeConnectionId?: number }>();
// Call media goes peer to peer; only signaling needs the server. On a restart or
// an update the old process hands answered calls to the next one through the
// database, so they keep going. Connection ids are per process: adopted calls
// match devices by id instead (-1 never matches a connection).
const HANDOFF_KEY = "handoff.calls";
const HANDOFF_MAX_AGE_MS = 120_000;
export function handOffCalls() {
  const active = [...calls.values()].filter(({ call }) => call.status === "active").map(({ call }) => call);
  if (active.length) run("INSERT INTO instance_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", HANDOFF_KEY, JSON.stringify({ at: Date.now(), calls: active }));
  for (const { timer } of calls.values()) clearTimeout(timer);
  calls.clear();
}
function adoptHandedOffCalls() {
  const row = one<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", HANDOFF_KEY);
  if (!row) return;
  run("DELETE FROM instance_settings WHERE key = ?", HANDOFF_KEY);
  const saved = JSON.parse(row.value) as { at: number; calls: DirectCall[] };
  if (Date.now() - saved.at > HANDOFF_MAX_AGE_MS) return;
  for (const call of saved.calls) if (!calls.has(call.id)) calls.set(call.id, { call, callerConnectionId: -1, calleeConnectionId: -1 });
}
const lastInvite = new Map<string, number>();
const device = z.string().min(1).max(64);
const signalSchema = z.object({
  description: z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(40_000) }).optional(),
  candidate: z.object({ candidate: z.string().max(4096), sdpMid: z.string().max(64).nullable().optional(), sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional() }).optional(),
}).refine((value) => !!value.description !== !!value.candidate);
function publish(call: DirectCall) { for (const id of [call.callerId, call.calleeId]) sendToUser(id, { t: "CALL_UPDATE", d: call }); }
function finish(id: string, reason: string) {
  const entry = calls.get(id);
  if (!entry) return;
  clearTimeout(entry.timer); calls.delete(id);
  publish({ ...entry.call, status: "ended", reason });
}
export function clearCalls(userId: string, connectionId?: number) {
  adoptHandedOffCalls();
  for (const [id, entry] of calls) if (entry.callerConnectionId === connectionId || entry.calleeConnectionId === connectionId || (!connectionsOf(userId).size && [entry.call.callerId, entry.call.calleeId].includes(userId))) finish(id, "A pessoa se desconectou.");
}
export function endCallsBetween(a: string, b: string) {
  for (const [id, { call }] of calls) if ([call.callerId, call.calleeId].includes(a) && [call.callerId, call.calleeId].includes(b)) finish(id, "A amizade foi encerrada.");
}
export function callRoutes(app: FastifyInstance) {
  app.post("/calls", async (req) => {
    const callerId = requireUser(req);
    const { userId: calleeId, video, deviceId } = parse(z.object({ userId: z.string().min(1), video: z.boolean(), deviceId: device }), req.body);
    if (callerId === calleeId || !areFriends(callerId, calleeId)) throw forbidden("Apenas amigos podem iniciar chamadas privadas.");
    const callerConnection = [...connectionsOf(callerId)].find((connection) => connection.deviceId === deviceId);
    if (!callerConnection) throw badRequest("Conecte a sessão antes de ligar.");
    if (!connectionsOf(calleeId).size) throw badRequest("Seu amigo está offline.");
    if (![...connectionsOf(calleeId)].some((connection) => connection.features.has("directCalls"))) throw badRequest("Seu amigo precisa atualizar o Annoy para receber chamadas privadas.");
    if (Date.now() - (lastInvite.get(callerId) ?? 0) < 3000) throw badRequest("Aguarde antes de ligar novamente.");
    if ([...calls.values()].some(({ call }) => [call.callerId, call.calleeId].some((id) => id === callerId || id === calleeId))) throw badRequest("Uma das pessoas já está em uma chamada privada.");
    let iceServers: NonNullable<DirectCall["iceServers"]> = [{ urls: "stun:stun.l.google.com:19302" }];
    if (process.env.ANNOY_CALL_ICE_SERVERS) iceServers = parse(z.array(z.object({ urls: z.union([z.string().max(512), z.array(z.string().max(512)).max(8)]), username: z.string().max(512).optional(), credential: z.string().max(512).optional() })).max(8), JSON.parse(process.env.ANNOY_CALL_ICE_SERVERS));
    const call: DirectCall = { id: newId(), callerId, calleeId, video, status: "ringing", callerDeviceId: deviceId, iceServers };
    lastInvite.set(callerId, Date.now());
    const timer = setTimeout(() => finish(call.id, "A chamada não foi atendida."), 45_000); timer.unref();
    calls.set(call.id, { call, timer, callerConnectionId: callerConnection.id }); publish(call); return call;
  });
  app.addHook("onClose", async () => { lastInvite.clear(); });
}
export function handleCall(conn: Connection, message: Extract<ClientOp, { op: "call" }>) {
  if (!calls.has(String(message.callId))) adoptHandedOffCalls();
  const entry = calls.get(String(message.callId));
  if (!entry || !conn.userId || ![entry.call.callerId, entry.call.calleeId].includes(conn.userId)) return;
  const call = entry.call;
  if (!areFriends(call.callerId, call.calleeId)) return finish(call.id, "A amizade foi encerrada.");
  const deviceId = device.safeParse(message.deviceId);
  if (!deviceId.success) return;
  if (conn.deviceId !== deviceId.data) return;
  if (message.action === "accept" && conn.userId === call.calleeId && call.status === "ringing") {
    if (conn.deviceId !== deviceId.data) return;
    clearTimeout(entry.timer); entry.calleeConnectionId = conn.id; call.status = "active"; call.calleeDeviceId = deviceId.data; publish(call); return;
  }
  const expected = conn.userId === call.callerId ? call.callerDeviceId : call.calleeDeviceId;
  if (call.status === "active" && deviceId.data !== expected) return;
  if (message.action === "reject" && conn.userId === call.calleeId && call.status === "ringing") return finish(call.id, "Chamada recusada.");
  if (message.action === "end") return finish(call.id, "Chamada encerrada.");
  if (message.action === "signal" && call.status === "active") {
    const signal = signalSchema.safeParse(message.signal);
    if (signal.success) sendToUser(conn.userId === call.callerId ? call.calleeId : call.callerId, { t: "CALL_SIGNAL", d: { callId: call.id, signal: signal.data } });
  }
}
