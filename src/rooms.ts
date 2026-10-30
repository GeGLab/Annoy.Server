import { has, LIMITS, Permission, TEMP_ROOM_IDLE_MS, type Channel } from "@distopic/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.ts";
import { removeWorkspace } from "./code.ts";
import { all, one, run } from "./db.ts";
import { badRequest, forbidden } from "./errors.ts";
import { onVoiceChanged, serverChanged } from "./events.ts";
import { forgetPlayback } from "./playback.ts";
import { requireServer } from "./perms.ts";
import { getChannel, getChannels } from "./repo.ts";
import { insertChannel } from "./routes/servers.ts";
import { discardBlobs } from "./uploads.ts";
import { parse, type Params } from "./validate.ts";
import { voiceStatesFor } from "./voice-backend.ts";

/** Deletes a channel with everything hanging off it: attachment files, playback and code workspace. */
export async function removeChannel(channel: Channel): Promise<void> {
  const blobs = all<{ id: string }>("SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id = ?", channel.id);
  run("DELETE FROM channels WHERE id = ?", channel.id);
  forgetPlayback(channel.id);
  await Promise.all([discardBlobs(blobs.map((b) => b.id)), removeWorkspace(channel.id)]);
  if (channel.serverId) serverChanged(channel.serverId);
}

// Temporary rooms ------------------------------------------------------------
// A temporary voice room lives until everyone who joined has left. One that nobody
// ever joins is removed TEMP_ROOM_IDLE_MS after creation.

const idleTimers = new Map<string, NodeJS.Timeout>();
/** Rooms per member at once, so nobody can flood the channel list. */
const ROOMS_PER_MEMBER = 3;

function scheduleIdle(channelId: string, createdAt: number): void {
  clearTimeout(idleTimers.get(channelId));
  const timer = setTimeout(() => {
    idleTimers.delete(channelId);
    const row = one<{ temp_used: number }>("SELECT temp_used FROM channels WHERE id = ? AND temporary = 1", channelId);
    const channel = getChannel(channelId);
    if (row && !row.temp_used && channel) void removeChannel(channel);
  }, Math.max(0, createdAt + TEMP_ROOM_IDLE_MS - Date.now()));
  timer.unref();
  idleTimers.set(channelId, timer);
}

function checkServer(serverId: string): void {
  roomsOccupied(serverId, new Set(voiceStatesFor(serverId).map((v) => v.channelId)));
}

/** Marks rooms someone is in as used and removes used rooms that emptied. */
export function roomsOccupied(serverId: string, occupied: ReadonlySet<string>): void {
  for (const room of all<{ id: string; temp_used: number }>("SELECT id, temp_used FROM channels WHERE server_id = ? AND temporary = 1", serverId)) {
    if (occupied.has(room.id)) {
      if (!room.temp_used) {
        run("UPDATE channels SET temp_used = 1 WHERE id = ?", room.id);
        clearTimeout(idleTimers.get(room.id));
        idleTimers.delete(room.id);
      }
    } else if (room.temp_used) {
      const channel = getChannel(room.id);
      if (channel) void removeChannel(channel);
    }
  }
}

/** Nobody is in voice right after a restart: rooms that were used go now, the rest get their timer back. */
export function startTempRooms(): void {
  for (const room of all<{ id: string; server_id: string; temp_used: number; created_at: string }>("SELECT id, server_id, temp_used, created_at FROM channels WHERE temporary = 1")) {
    if (room.temp_used) {
      const channel = getChannel(room.id);
      if (channel) void removeChannel(channel);
    } else scheduleIdle(room.id, Date.parse(room.created_at));
  }
  onVoiceChanged(checkServer);
}

const createTempRoom = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax),
  parentId: z.string().nullable().optional(),
});

export function tempRoomRoutes(app: FastifyInstance): void {
  app.post<Params<"id">>("/servers/:id/temp-rooms", async (req) => {
    const userId = requireUser(req);
    const serverId = req.params.id;
    const { perms } = requireServer(serverId, userId);
    if (!has(perms, Permission.CONNECT)) throw forbidden("Sem permissão para conectar em salas de voz");
    const body = parse(createTempRoom, req.body);
    const parentId = body.parentId && one("SELECT 1 AS x FROM channels WHERE id = ? AND server_id = ? AND type = 'category'", body.parentId, serverId) ? body.parentId : null;
    const mine = one<{ n: number }>("SELECT COUNT(*) AS n FROM channels WHERE server_id = ? AND temporary = 1 AND created_by = ?", serverId, userId)!.n;
    if (mine >= ROOMS_PER_MEMBER) throw badRequest(`Você já tem ${ROOMS_PER_MEMBER} salas temporárias neste servidor`);
    const id = insertChannel(serverId, "voice", body.name, parentId, "", userId, true);
    scheduleIdle(id, Date.now());
    serverChanged(serverId);
    return getChannels(serverId).find((c) => c.id === id);
  });
}
