import { Permission, type ClientOp } from "@distopic/protocol";
import type { FastifyInstance } from "fastify";
import { userIdForToken } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { Connection, register, sendToAudience, sendToChannel, unregister } from "./events.ts";
import { requireChannel } from "./perms.ts";
import { addConnection, presenceOf, removeConnection } from "./presence.ts";
import { audienceOf, dmChannelsForUser, getRelationships, getUser, serversForUser } from "./repo.ts";
import { handleVoice, leaveVoice, setSelfState } from "./voice.ts";

const HEARTBEAT_TIMEOUT_MS = 90_000;
const IDENTIFY_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 64 * 1024;

export function registerGateway(app: FastifyInstance): void {
  const live = new Set<Connection>();

  const sweep = setInterval(() => {
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
      leaveVoice(conn);
      const userId = conn.userId;
      unregister(conn);
      if (userId && removeConnection(userId)) {
        sendToAudience(userId, { t: "PRESENCE_UPDATE", d: { userId, presence: "offline" } });
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
    register(conn, userId);
    const cameOnline = addConnection(userId);
    const presences = Object.fromEntries(audienceOf(userId).map((id) => [id, presenceOf(id)]));
    conn.send({
      t: "READY",
      d: { user, servers: serversForUser(userId), dms: dmChannelsForUser(userId), relationships: getRelationships(userId), presences },
    });
    if (cameOnline) sendToAudience(userId, { t: "PRESENCE_UPDATE", d: { userId, presence: "online" } });
    return;
  }

  const userId = conn.userId;
  if (!userId) return void conn.socket.close(4003, "not identified");

  switch (msg.op) {
    case "heartbeat":
      conn.send({ t: "HEARTBEAT_ACK", d: null });
      return;
    case "typing": {
      const { channel } = requireChannel(String(msg.channelId), userId, Permission.SEND_MESSAGES);
      sendToChannel(channel, { t: "TYPING_START", d: { channelId: channel.id, userId } }, userId);
      return;
    }
    case "voice_state":
      setSelfState(conn, msg.selfMute === true, msg.selfDeaf === true);
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
