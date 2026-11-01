// Delivery service for end-to-end encrypted call media (SFrame, RFC 9605, keyed by an
// MLS group per call, RFC 9420). The server never holds media keys: it relays
// KeyPackages, commits and Welcomes, and orders commits so every member applies the
// same epoch sequence. Clients verify every device binding against their own pinned
// device directory, so a server that forges membership is detected, not trusted.
import type { GatewayEvent, VoiceMediaBinding, VoiceMediaProtection } from "@distopic/protocol";
import { HttpError, badRequest, forbidden } from "./errors.ts";
import type { Connection } from "./events.ts";

const MAX_WIRE = 1_400_000; // base64 of the 1 MiB MLS wire limit
const MAX_MEMBERS = 256;
/** A designated committer that does not answer hands the turn to the next member. */
const COMMIT_TIMEOUT_MS = 8_000;

interface Present {
  conn: Connection;
  userId: string;
}

interface Member extends Present {
  binding: VoiceMediaBinding;
}

interface Call {
  protection: VoiceMediaProtection;
  /** Random id chosen by the first device; null until it creates the MLS group. */
  callId: string | null;
  epoch: number;
  present: Map<number, Present>;
  /** Join order. The first member commits pending changes. */
  members: Map<number, Member>;
  adds: Map<number, { binding: VoiceMediaBinding; keyPackage: string }>;
  removes: Map<number, VoiceMediaBinding>;
  timer: ReturnType<typeof setTimeout> | null;
}

const calls = new Map<string, Call>();

export function isMediaProtection(value: unknown): value is VoiceMediaProtection {
  return value === "sframe" || value === "transport_only_acknowledged";
}

/** Called by a voice backend once a peer is admitted to the channel. */
export function mediaJoin(channelId: string, conn: Connection, protection: VoiceMediaProtection): { protection: VoiceMediaProtection; callId: string | null; epoch: number } {
  let call = calls.get(channelId);
  if (call && call.present.size > 0 && call.protection !== protection) {
    throw new HttpError(
      409,
      "media_protection_mismatch",
      call.protection === "sframe"
        ? "Esta chamada usa criptografia de ponta a ponta (SFrame). Atualize o Annoy para participar."
        : "Esta chamada usa apenas a criptografia de transporte. Entre sem E2EE ou aguarde todos saírem.",
    );
  }
  if (!call || call.present.size === 0) {
    if (call?.timer) clearTimeout(call.timer);
    call = { protection, callId: null, epoch: 0, present: new Map(), members: new Map(), adds: new Map(), removes: new Map(), timer: null };
    calls.set(channelId, call);
  }
  call.present.set(conn.id, { conn, userId: conn.userId! });
  return { protection, callId: call.callId, epoch: call.epoch };
}

export function mediaProtectionOf(channelId: string): VoiceMediaProtection | null {
  return calls.get(channelId)?.protection ?? null;
}

/** Called by a voice backend whenever a peer leaves, is kicked or loses access. */
export function mediaLeave(channelId: string, connId: number): void {
  const call = calls.get(channelId);
  if (!call) return;
  call.present.delete(connId);
  call.adds.delete(connId);
  const member = call.members.get(connId);
  if (member) {
    call.members.delete(connId);
    // Until a member commits the removal, the departed device still knows this epoch.
    // The SFU stops forwarding to it at once; the epoch rotates as soon as possible.
    if (call.members.size > 0) call.removes.set(connId, member.binding);
  }
  if (call.members.size === 0) {
    // Nobody holds the group anymore: the next device starts a new call with fresh keys.
    if (call.timer) clearTimeout(call.timer);
    call.timer = null;
    call.callId = null;
    call.epoch = 0;
    call.removes.clear();
    for (const [id, present] of call.present) if (call.adds.has(id)) present.conn.send(event(channelId, { kind: "restart" }));
    call.adds.clear();
  }
  if (call.present.size === 0) {
    if (call.timer) clearTimeout(call.timer);
    calls.delete(channelId);
    return;
  }
  notifyCommitter(channelId, call);
}

const event = (channelId: string, d: Record<string, unknown>): GatewayEvent => ({ t: "VOICE_MEDIA", d: { channelId, ...d } as never });

const text = (data: Record<string, unknown>, key: string, max: number): string => {
  const value = data[key];
  if (typeof value !== "string" || value === "" || value.length > max) throw badRequest(`Campo "${key}" inválido`);
  return value;
};

function binding(data: Record<string, unknown>, userId: string, callId: string): VoiceMediaBinding {
  const raw = data.binding as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") throw badRequest('Campo "binding" inválido');
  const result: VoiceMediaBinding = {
    userId: text(raw, "userId", 100),
    deviceId: text(raw, "deviceId", 64),
    mediaKey: text(raw, "mediaKey", 128),
    signature: text(raw, "signature", 256),
  };
  // The server only checks what it can: the claimed user is this session's user.
  // The signature is verified by every member against its pinned device directory.
  if (result.userId !== userId) throw forbidden("Vínculo de mídia de outro usuário");
  if (text(data, "callId", 64) !== callId) throw new HttpError(409, "media_call_changed", "A chamada criptografada foi reiniciada");
  return result;
}

function callOf(channelId: string, conn: Connection): Call {
  const call = calls.get(channelId);
  if (!call || !call.present.has(conn.id)) throw badRequest("Entre no canal de voz primeiro");
  if (call.protection !== "sframe") throw badRequest("Esta chamada não usa E2EE");
  return call;
}

function bindings(call: Call): VoiceMediaBinding[] {
  return [...call.members.values()].map((m) => m.binding);
}

function notifyCommitter(channelId: string, call: Call): void {
  if (call.timer) clearTimeout(call.timer);
  call.timer = null;
  const committer = call.members.values().next().value as Member | undefined;
  if (!committer || !call.callId || (call.adds.size === 0 && call.removes.size === 0)) return;
  committer.conn.send(
    event(channelId, {
      kind: "proposals",
      callId: call.callId,
      epoch: call.epoch,
      adds: [...call.adds].map(([ref, add]) => ({ ref, binding: add.binding, keyPackage: add.keyPackage })),
      removes: [...call.removes].map(([ref, removed]) => ({ ref, binding: removed })),
      bindings: bindings(call),
    }),
  );
  const epoch = call.epoch;
  call.timer = setTimeout(() => {
    if (call.epoch !== epoch || calls.get(channelId) !== call) return;
    // Rotate the turn: move the silent committer to the end of the order.
    const first = call.members.entries().next().value as [number, Member] | undefined;
    if (first && call.members.size > 1) {
      call.members.delete(first[0]);
      call.members.set(first[0], first[1]);
    }
    notifyCommitter(channelId, call);
  }, COMMIT_TIMEOUT_MS);
  call.timer.unref?.();
}

/** Gateway voice methods `mediaCreate`, `mediaPropose` and `mediaCommit`. */
export function handleMedia(conn: Connection, channelId: string, method: string, data: Record<string, unknown>): unknown {
  const call = callOf(channelId, conn);
  const userId = conn.userId!;
  switch (method) {
    case "mediaCreate": {
      const callId = text(data, "callId", 64);
      if (!/^[A-Za-z0-9_-]{22,64}$/.test(callId)) throw badRequest("Identificador de chamada inválido");
      if (call.callId) return { created: false, callId: call.callId, epoch: call.epoch };
      if (call.members.has(conn.id)) throw badRequest("Já participa da chamada");
      const own = binding(data, userId, callId);
      call.callId = callId;
      call.epoch = 0;
      call.members.set(conn.id, { conn, userId, binding: own });
      call.adds.delete(conn.id);
      notifyCommitter(channelId, call);
      return { created: true, callId, epoch: 0 };
    }
    case "mediaPropose": {
      if (!call.callId) throw new HttpError(409, "media_call_changed", "A chamada criptografada foi reiniciada");
      if (call.members.has(conn.id)) throw badRequest("Já participa da chamada");
      if (call.members.size + call.adds.size >= MAX_MEMBERS) throw forbidden("Limite de participantes criptográficos atingido");
      call.adds.set(conn.id, { binding: binding(data, userId, call.callId), keyPackage: text(data, "keyPackage", 65536) });
      notifyCommitter(channelId, call);
      return { pending: true, callId: call.callId, epoch: call.epoch };
    }
    case "mediaCommit": {
      if (!call.callId || text(data, "callId", 64) !== call.callId) throw new HttpError(409, "media_call_changed", "A chamada criptografada foi reiniciada");
      if (!call.members.has(conn.id)) throw forbidden("Somente participantes podem alterar a chamada");
      if (data.epoch !== call.epoch) throw new HttpError(409, "media_epoch_conflict", "Outra alteração da chamada foi aplicada antes");
      const adds = refs(data.adds);
      const removes = refs(data.removes);
      if (adds.some((ref) => !call.adds.has(ref)) || removes.some((ref) => !call.removes.has(ref))) {
        throw new HttpError(409, "media_epoch_conflict", "A lista de alterações pendentes mudou");
      }
      const commit = text(data, "commit", MAX_WIRE);
      const welcome = adds.length ? text(data, "welcome", MAX_WIRE) : null;
      call.epoch += 1;
      const added = adds.map((ref) => {
        const pending = call.adds.get(ref)!;
        call.adds.delete(ref);
        const present = call.present.get(ref)!;
        const member = { conn: present.conn, userId: present.userId, binding: pending.binding };
        call.members.set(ref, member);
        return member;
      });
      for (const ref of removes) call.removes.delete(ref);
      const roster = bindings(call);
      for (const [ref, member] of call.members) {
        if (ref === conn.id || adds.includes(ref)) continue;
        member.conn.send(event(channelId, { kind: "commit", callId: call.callId, epoch: call.epoch, commit, bindings: roster }));
      }
      for (const member of added) member.conn.send(event(channelId, { kind: "welcome", callId: call.callId, epoch: call.epoch, welcome, bindings: roster }));
      notifyCommitter(channelId, call);
      return { epoch: call.epoch };
    }
    default:
      throw badRequest("Operação de mídia desconhecida");
  }
}

function refs(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MEMBERS || !value.every((v) => Number.isSafeInteger(v))) throw badRequest("Referências inválidas");
  return [...new Set(value as number[])];
}

/** For tests: the server-side view holds no key material, only ordering state. */
export function mediaSnapshot(channelId: string): { callId: string | null; epoch: number; members: string[]; pending: number } | null {
  const call = calls.get(channelId);
  if (!call) return null;
  return { callId: call.callId, epoch: call.epoch, members: [...call.members.values()].map((m) => m.binding.deviceId), pending: call.adds.size + call.removes.size };
}
