import { clearCalls, handleCall, handOffCalls } from "./calls.ts";
import { Permission, type ClientOp } from "@distopic/protocol";
import type { FastifyInstance } from "fastify";
import { userIdForToken } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { Connection, register, sendToAudience, sendToChannel, sendToUser, unregister } from "./events.ts";
import { requireChannel } from "./perms.ts";
import { addConnection, presenceOf, removeConnection, setConnectionIdle, setManualPresence } from "./presence.ts";
import { audienceOf, dmChannelsForUser, getRelationships, getUser, serversForUser } from "./repo.ts";
import { getSettings, isAdmin } from "./instance.ts";
import { activitiesFor, clearActivity, expireActivities, updateActivity, refreshActivityPresence } from "./activity.ts";
import { detachVoice, handleVoice, setSelfState, setSpeaking, voiceBackend } from "./voice-backend.ts";

const HEARTBEAT_TIMEOUT_MS = 90_000;
const IDENTIFY_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 64 * 1024;

const live = new Set<Connection>();
let restarting = false;

/**
 * Restarting or updating: tell every client so it reconnects at once (to the
 * new process, during an update), and leave voice sessions and private calls
 * alone so they keep flowing and resume there. Runs as @fastify/websocket's
 * preClose, whose default would close the sockets without a code first.
 */
export function closeForRestart(): void {
  restarting = true;
  handOffCalls();
  for (const conn of live) conn.socket.close(4010, "server restarting");
}

export function registerGateway(app: FastifyInstance): void {

  const sweep = setInterval(() => {
    expireActivities();
    const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;
    for (const conn of live) if (conn.lastHeartbeat < cutoff) conn.socket.close(4009, "heartbeat timeout");
  }, 30_000);
  app.addHook("onClose", async () => clearInterval(sweep));

  app.get("/gateway", { websocket: true }, (socket) => {
    const conn = new Connection(socket);
    live.add(conn);
    const identifyTimer = setTimeout(() => {
      if (!conn.userId) socket.close(4003, "identify timeout");
    }, IDENTIFY_TIMEOUT_MS);

    socket.on("message", (raw, isBinary) => {
      if (isBinary) return void socket.close(4002, "binary frames unsupported");
      const text = raw.toString();
      if (text.length > MAX_FRAME_BYTES) return void socket.close(4008, "frame too large");
      let msg: ClientOp;
      try {
        msg = JSON.parse(text) as ClientOp;
      } catch {
        return void socket.close(4002, "invalid json");
      }
      conn.lastHeartbeat = Date.now();
      void onMessage(conn, msg).catch((err: unknown) => app.log.warn({ err }, "gateway message failed"));
    });

    socket.on("close", () => {
      clearTimeout(identifyTimer);
      live.delete(conn);
      if (!restarting) detachVoice(conn);
      const userId = conn.userId;
      const previousPresence = userId ? presenceOf(userId) : "offline";
      unregister(conn);
      clearActivity(conn);
      if (userId && !restarting) clearCalls(userId, conn.id);
      if (userId) {
        removeConnection(userId, conn.id);
        if (previousPresence !== presenceOf(userId)) {
          const event = { t: "PRESENCE_UPDATE" as const, d: { userId, presence: presenceOf(userId) } };
          sendToAudience(userId, event);
          sendToUser(userId, event);
          refreshActivityPresence(userId);
        }
      }
    });
  });
}

async function onMessage(conn: Connection, msg: ClientOp): Promise<void> {
  if (msg.op === "identify") {
    if (conn.userId) return;
    const userId = typeof msg.token === "string" ? userIdForToken(msg.token) : null;
    const user = userId ? getUser(userId) : undefined;
    if (!userId || !user) {
      conn.send({ t: "INVALID_SESSION", d: { reason: "Sessão inválida ou expirada" } });
      conn.socket.close(4004, "invalid session");
      return;
    }
    conn.deviceId = typeof msg.deviceId === "string" && msg.deviceId.length <= 64 ? msg.deviceId : null;
    if (Array.isArray(msg.features) && msg.features.length <= 16) conn.features = new Set(msg.features.filter((feature) => typeof feature === "string" && feature.length <= 64));
    register(conn, userId);
    const previousPresence = presenceOf(userId);
    setManualPresence(userId, msg.presence);
    const cameOnline = addConnection(userId);
    const presences = Object.fromEntries([userId, ...audienceOf(userId)].map((id) => [id, presenceOf(id)]));
    conn.send({
      t: "READY",
      d: {
        user,
        servers: serversForUser(userId),
        dms: dmChannelsForUser(userId),
        relationships: getRelationships(userId),
        presences,
        activities: activitiesFor(userId),
        instance: { isAdmin: isAdmin(userId), registration: getSettings().registration, voiceBackend, activityArtwork: true, steamConnection: true, serverOwnership: true, developmentActivity: true, directCalls: true, socialProfiles: true, presenceStatus: true, manualPresence: true, channelTypes: true, codeChannels: true },
      },
    });
    if (cameOnline || previousPresence !== presenceOf(userId)) {
      const event = { t: "PRESENCE_UPDATE" as const, d: { userId, presence: presenceOf(userId) } };
      sendToAudience(userId, event);
      sendToUser(userId, event);
      refreshActivityPresence(userId);
    }
    return;
  }

  const userId = conn.userId;
  if (!userId) return void conn.socket.close(4003, "not identified");

  switch (msg.op) {
    case "call": handleCall(conn, msg); return;
    case "presence":
      if (setConnectionIdle(userId, conn.id, msg.idle === true, msg.status)) {
        const event = { t: "PRESENCE_UPDATE" as const, d: { userId, presence: presenceOf(userId) } };
        sendToAudience(userId, event);
        sendToUser(userId, event);
        refreshActivityPresence(userId);
      }
      return;
    case "activity":
      if (!updateActivity(conn, msg.activities)) conn.socket.close(4002, "invalid activity");
      return;
    case "heartbeat":
      conn.send({ t: "HEARTBEAT_ACK", d: null });
      return;
    case "typing": {
      const { channel } = requireChannel(String(msg.channelId), userId, Permission.SEND_MESSAGES);
      sendToChannel(channel, { t: "TYPING_START", d: { channelId: channel.id, userId } }, userId);
      return;
    }
    case "voice_state":
      setSelfState(conn, msg.selfMute === true, msg.selfDeaf === true, msg.screenQuality);
      return;
    case "speaking":
      setSpeaking(conn, msg.speaking === true);
      return;
    case "voice": {
      const id = Number(msg.id);
      try {
        const data = await handleVoice(conn, msg.method, msg.data ?? {});
        conn.send({ t: "VOICE_REPLY", d: { id, ok: true, data } });
      } catch (err) {
        const message = err instanceof HttpError ? err.message : "Erro interno de voz";
        if (!(err instanceof HttpError)) console.error("voice", msg.method, err);
        conn.send({ t: "VOICE_REPLY", d: { id, ok: false, message } });
      }
      return;
    }
  }
}
