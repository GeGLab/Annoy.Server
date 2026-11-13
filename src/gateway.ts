import {observeSessions} from "./session-events.ts";
import { compareVersions, isVersion } from "./version.ts";
import {config} from "./config.ts";
import { usesLegacyGateway, proxyLegacyGateway, gatewayRetirement } from './handoff.ts';
import { clearCalls, handleCall, endAllCalls } from "./calls.ts";
import { Permission, type ClientOp } from "@annoy/protocol";
import type { FastifyInstance } from "fastify";
import { hashToken, userIdForSessionHash, userIdForToken } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { Connection, register, sendToAudience, sendToChannel, sendToUser, unregister } from "./events.ts";
import { requireChannel } from "./perms.ts";
import { addConnection, presenceOf, removeConnection, setConnectionIdle, setManualPresence } from "./presence.ts";
import { audienceOf, dmChannelsForUser, getRelationships, getUser, serversForUser } from "./repo.ts";
import { getSettings, isAdmin } from "./instance.ts";
import { activitiesFor, clearActivity, expireActivities, updateActivity, refreshActivityPresence } from "./activity.ts";
import { annoySocial } from "./social-moved.ts";
import { integrationsEnabled } from "./integrations.ts";
import { leaveVoice, handleVoice, setSelfState, setSpeaking, voiceBackend } from "./voice-backend.ts";

const HEARTBEAT_TIMEOUT_MS = 90_000;
const IDENTIFY_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 64 * 1024;

const live = new Set<Connection>();
const sessionHashes = new WeakMap<Connection, string>();
export const migrationState = { live, sessionHashes, onMessage };
let restarting = false;

/** End server-owned sessions before closing gateways, including on an update. */
export function closeForRestart(): void {
  restarting = true;
  endAllCalls();
  for (const conn of live) conn.socket.close(4010, "server restarting");
}

export function registerGateway(app: FastifyInstance): void {
  const stopObserving=observeSessions((hash)=>{for(const conn of live)if(sessionHashes.get(conn)===hash)conn.socket.close(4004,'session revoked');});
  app.addHook('onClose',async()=>stopObserving());

  const sweep = setInterval(() => {
    expireActivities();
    const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;
    for (const conn of live) {
      const hash = sessionHashes.get(conn);
      if (conn.userId && (!hash || userIdForSessionHash(hash) !== conn.userId)) conn.socket.close(4004, "session expired");
      else if (conn.lastHeartbeat < cutoff) {
        conn.socket.close(4009, "heartbeat timeout");
        // A dead link never answers the close handshake: without this its voice session would stay
        // in the room (others hearing silence, the user's next join racing it) until ws gives up.
        const socket = conn.socket;
        setTimeout(() => { if (socket.readyState !== socket.CLOSED) socket.terminate(); }, 2_000).unref();
      }
    }
  }, 30_000);
  app.addHook("onClose", async () => clearInterval(sweep));

  app.get("/gateway", { websocket: true }, async (socket,req) => {
    const retirement=gatewayRetirement();
    if(retirement){socket.pause();await retirement;if(socket.readyState!==socket.OPEN)return;}
    if (usesLegacyGateway()){proxyLegacyGateway(socket);if(retirement)socket.resume();return;}
    if (restarting) return void socket.close(4010, "server stopping");
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
      leaveVoice(conn);
      const userId = conn.userId;
      const previousPresence = userId ? presenceOf(userId) : "offline";
      unregister(conn);
      clearActivity(conn);
      if (userId) clearCalls(userId, conn.id);
      if (userId) {
        removeConnection(userId, conn.id);
        if (!annoySocial && previousPresence !== presenceOf(userId)) {
          const event = { t: "PRESENCE_UPDATE" as const, d: { userId, presence: presenceOf(userId) } };
          sendToAudience(userId, event);
          sendToUser(userId, event);
          refreshActivityPresence(userId);
        }
      }
    });
    if(retirement)socket.resume();
  });
}

async function onMessage(conn: Connection, msg: ClientOp): Promise<void> {
  if (restarting) return;
  if (msg.op === "identify") {
    if (conn.userId) return;
    // A client older than this server's minimum is told to update; a newer one always connects.
    if (!isVersion(msg.clientVersion) || compareVersions(msg.clientVersion, config.minClientVersion) < 0) {
      conn.send({ t: "INVALID_SESSION", d: { reason: `Atualize o Annoy: este servidor exige a versão ${config.minClientVersion} ou mais nova.` } });
      conn.socket.close(4011, "client outdated");
      return;
    }
    const userId = typeof msg.token === "string" ? userIdForToken(msg.token) : null;
    const user = userId ? getUser(userId) : undefined;
    if (!userId || !user) {
      conn.send({ t: "INVALID_SESSION", d: { reason: "Sessão inválida ou expirada" } });
      conn.socket.close(4004, "invalid session");
      return;
    }
    conn.deviceId = typeof msg.deviceId === "string" && msg.deviceId.length <= 64 ? msg.deviceId : null;
    if (Array.isArray(msg.features) && msg.features.length <= 16) conn.features = new Set(msg.features.filter((feature) => typeof feature === "string" && feature.length <= 64));
    sessionHashes.set(conn, hashToken(msg.token));
    register(conn, userId);
    const previousPresence = presenceOf(userId);
    setManualPresence(userId, msg.presence);
    const cameOnline = addConnection(userId);
    const presences = annoySocial ? {} : Object.fromEntries([userId, ...audienceOf(userId)].map((id) => [id, presenceOf(id)]));
    conn.send({
      t: "READY",
      d: {
        user,
        servers: serversForUser(userId),
        dms: annoySocial ? [] : dmChannelsForUser(userId),
        relationships: annoySocial ? [] : getRelationships(userId),
        presences,
        activities: annoySocial ? {} : activitiesFor(userId),
        instance: { isAdmin: isAdmin(userId), registration: getSettings().registration, voiceBackend, activityArtwork: true, steamConnection: !annoySocial, serverOwnership: true, developmentActivity: true, directCalls: !annoySocial, annoySocial, socialProfiles: true, groupActivity: true, reactions: true, stickerReactions: true, serverIcons: true, gifSearch: !!process.env.GIPHY_CLIENT_API_KEY, serverStickers: true, presenceStatus: true, manualPresence: true, channelTypes: true, codeChannels: true, historyWindow: true, messagePins: true, serverReadState: true, integrations: integrationsEnabled(), profileDetails: !annoySocial, extendedActivity: true },
      },
    });
    if (!annoySocial && (cameOnline || previousPresence !== presenceOf(userId))) {
      const event = { t: "PRESENCE_UPDATE" as const, d: { userId, presence: presenceOf(userId) } };
      sendToAudience(userId, event);
      sendToUser(userId, event);
      refreshActivityPresence(userId);
    }
    return;
  }

  const userId = conn.userId;
  if (userId) {
    const hash = sessionHashes.get(conn);
    if (!hash || userIdForSessionHash(hash) !== userId) {
      conn.socket.close(4004, "session expired");
      return;
    }
  }
  if (!userId) return void conn.socket.close(4003, "not identified");

  switch (msg.op) {
    case "call": if (!annoySocial) handleCall(conn, msg); return;
    case "presence":
      // Annoy accounts publish status to chatannoy only.
      if (annoySocial) return;
      if (setConnectionIdle(userId, conn.id, msg.idle === true, msg.status)) {
        const event = { t: "PRESENCE_UPDATE" as const, d: { userId, presence: presenceOf(userId) } };
        sendToAudience(userId, event);
        sendToUser(userId, event);
        refreshActivityPresence(userId);
      }
      return;
    case "activity":
      if (annoySocial) return;
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
        const params = msg.data ?? {};
        const data = await handleVoice(conn, msg.method, params);
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
