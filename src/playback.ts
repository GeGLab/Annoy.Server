import { DJ_STYLES, has, Permission, playbackPosition, type Channel, type PlaybackItem, type PlaybackKind, type PlaybackState } from "@annoy/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.ts";
import { now, one, run } from "./db.ts";
import { badRequest, forbidden, notFound } from "./errors.ts";
import { sendToChannel } from "./events.ts";
import { secretId } from "./ids.ts";
import { requireChannel } from "./perms.ts";
import { getChannel } from "./repo.ts";
import { parse, type Params } from "./validate.ts";
import { isLegacySource } from './handoff.ts';

// Theater and song rooms share one playback per channel: a queue and where the current
// item is. The server only keeps time; every viewer plays the media on their own device.

const QUEUE_MAX = 200;
const states = new Map<string, Omit<PlaybackState, "serverTime">>();

const isPlaybackChannel = (channel: Channel) => channel.type === "theater" || channel.type === "song";

function load(channelId: string): Omit<PlaybackState, "serverTime"> {
  let state = states.get(channelId);
  if (!state) {
    const row = one<{ state: string }>("SELECT state FROM playback WHERE channel_id = ?", channelId);
    state = row
      ? (JSON.parse(row.state) as Omit<PlaybackState, "serverTime">)
      : { channelId, queue: [], currentId: null, paused: true, position: 0, updatedAt: Date.now(), autoplay: true, ducking: true };
    // Rooms saved before ducking and DJ mode existed get their defaults, like new ones.
    state.ducking ??= true;
    state.dj ??= false;
    state.djStyle ??= "auto";
    states.set(channelId, state);
  }
  return state;
}

// Who is listening in each song room right now. Kept in memory only: listeners say so when
// they join, again every LISTEN_BEAT_MS while they stay, and when they leave; a listener
// that goes quiet (closed the app, lost the connection) drops out after LISTEN_TTL_MS.
const LISTEN_TTL_MS = 75_000;
const listening = new Map<string, Map<string, number>>();

function listenersOf(channelId: string): string[] {
  const room = listening.get(channelId);
  return room ? [...room.keys()] : [];
}

const snapshot = (state: Omit<PlaybackState, "serverTime">): PlaybackState => ({ ...state, listeners: listenersOf(state.channelId), serverTime: Date.now() });

/**
 * Brings `position` up to now before anything else changes. Every save restarts the clock
 * at `updatedAt`, so an option toggled mid-song (DJ, ducking, autoplay, a new queue item)
 * must not send everyone back to where the last play or seek left the song.
 */
function settle(state: Omit<PlaybackState, "serverTime">): void {
  if (!state.paused && state.currentId) state.position = playbackPosition(snapshot(state));
  state.updatedAt = Date.now();
}

/** Tells the room who is listening, without touching its clock. */
function announce(channelId: string): void {
  const channel = getChannel(channelId);
  if (!channel || !isPlaybackChannel(channel)) {
    listening.delete(channelId);
    return;
  }
  sendToChannel(channel, { t: "PLAYBACK_UPDATE", d: snapshot(load(channel.id)) });
}

const sweep = setInterval(() => {
  if(isLegacySource())return;
  const now = Date.now();
  for (const [channelId, room] of listening) {
    let changed = false;
    for (const [userId, seen] of room) {
      if (now - seen > LISTEN_TTL_MS) {
        room.delete(userId);
        changed = true;
      }
    }
    if (room.size === 0) listening.delete(channelId);
    if (changed) announce(channelId);
  }
}, 15_000);
sweep.unref?.();

function save(channel: Channel, state: Omit<PlaybackState, "serverTime">): PlaybackState {
  state.updatedAt = Date.now();
  run("INSERT OR REPLACE INTO playback (channel_id, state) VALUES (?, ?)", channel.id, JSON.stringify(state));
  const out = snapshot(state);
  sendToChannel(channel, { t: "PLAYBACK_UPDATE", d: out });
  return out;
}

export function forgetPlayback(channelId: string): void {
  states.delete(channelId);
  listening.delete(channelId);
}

/** Drops queue items that pointed at an upload that no longer exists. */
export function uploadsRemoved(channel: Channel, attachmentIds: readonly string[]): void {
  if (!isPlaybackChannel(channel) || attachmentIds.length === 0) return;
  const state = load(channel.id);
  const gone = (item: PlaybackItem) => item.kind === "file" && attachmentIds.some((id) => item.url.startsWith(`/api/uploads/${id}/`));
  if (!state.queue.some(gone)) return;
  settle(state);
  if (state.queue.find((i) => i.id === state.currentId && gone(i))) advance(state);
  state.queue = state.queue.filter((i) => !gone(i));
  save(channel, state);
}

const YOUTUBE = /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
const DIRECT = /\.(mp4|webm|mkv|mov|m4v|ogv|mp3|ogg|oga|opus|m4a|aac|flac|wav)$/i;

function classify(url: URL): PlaybackKind {
  if (YOUTUBE.test(url.hostname)) return "youtube";
  if (DIRECT.test(url.pathname)) return "direct";
  return "site";
}

/** Best effort title for a link; YouTube answers oEmbed without a key. */
async function titleFor(url: URL, kind: PlaybackKind): Promise<string> {
  const fallback = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "") || url.hostname;
  if (kind !== "youtube") return kind === "site" ? url.hostname.replace(/^www\./, "") : fallback;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.toString())}`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) return String(((await res.json()) as { title?: unknown }).title ?? "").slice(0, 200) || "YouTube";
  } catch {
    // Offline or blocked: the generic title is fine.
  }
  return "YouTube";
}

function advance(state: Omit<PlaybackState, "serverTime">): void {
  const index = state.queue.findIndex((i) => i.id === state.currentId);
  const next = state.queue[index + 1] ?? null;
  state.currentId = next?.id ?? null;
  state.position = 0;
  state.paused = !next;
}

const listen = z.object({ value: z.boolean() });

const action = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), url: z.string().max(2048).default(""), title: z.string().max(200).optional(), uploadId: z.string().regex(/^[0-9a-f]{32}$/).optional() }),
  z.object({ op: z.literal("remove"), itemId: z.string() }),
  z.object({ op: z.literal("play"), itemId: z.string().optional() }),
  z.object({ op: z.literal("pause"), position: z.number().min(0) }),
  z.object({ op: z.literal("seek"), position: z.number().min(0) }),
  z.object({ op: z.literal("next") }),
  z.object({ op: z.literal("ended"), itemId: z.string() }),
  z.object({ op: z.literal("move"), itemId: z.string(), index: z.number().int().min(0) }),
  z.object({ op: z.literal("autoplay"), value: z.boolean() }),
  z.object({ op: z.literal("ducking"), value: z.boolean() }),
  z.object({ op: z.literal("dj"), value: z.boolean(), style: z.enum(DJ_STYLES as [string, ...string[]]).optional() }),
]);

export function playbackRoutes(app: FastifyInstance): void {
  app.get<Params<"id">>("/channels/:id/playback", async (req) => {
    const { channel } = requireChannel(req.params.id, requireUser(req));
    if (!isPlaybackChannel(channel)) throw notFound("Sala");
    return snapshot(load(channel.id));
  });

  // Joining, staying in (a heartbeat) or leaving a song room's audience. Anyone who can see
  // the room may listen, so this needs no more than seeing it.
  app.post<Params<"id">>("/channels/:id/playback/listen", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireChannel(req.params.id, userId);
    if (channel.type !== "song") throw notFound("Sala");
    const { value } = parse(listen, req.body);
    let room = listening.get(channel.id);
    const before = room?.has(userId) ?? false;
    if (value) {
      if (!room) listening.set(channel.id, (room = new Map()));
      room.set(userId, Date.now());
    } else if (room) {
      room.delete(userId);
      if (room.size === 0) listening.delete(channel.id);
    }
    const state = snapshot(load(channel.id));
    if (before !== value) sendToChannel(channel, { t: "PLAYBACK_UPDATE", d: state });
    return state;
  });

  app.post<Params<"id">>("/channels/:id/playback", async (req) => {
    const userId = requireUser(req);
    const { channel, perms } = requireChannel(req.params.id, userId, Permission.SEND_MESSAGES);
    if (!isPlaybackChannel(channel)) throw notFound("Sala");
    const body = parse(action, req.body);
    const state = load(channel.id);
    const moderator = has(perms, Permission.MANAGE_MESSAGES);
    const owns = (itemId: string | null) => state.queue.find((i) => i.id === itemId)?.addedBy === userId;
    // A stale end report changes nothing, not even the clock.
    if (body.op === "ended" && body.itemId !== state.currentId) return snapshot(state);
    settle(state);

    switch (body.op) {
      case "add": {
        if (state.queue.length >= QUEUE_MAX) throw badRequest(`A fila já tem ${QUEUE_MAX} itens`);
        let item: PlaybackItem;
        if (body.uploadId) {
          const row = one<{ filename: string; content_type: string }>(
            "SELECT a.filename, a.content_type FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.id = ? AND m.channel_id = ?",
            body.uploadId,
            channel.id,
          );
          if (!row) throw notFound("Arquivo");
          if (!/^(audio|video)\//.test(row.content_type)) throw badRequest("Só arquivos de áudio ou vídeo podem entrar na fila");
          const url = `/api/uploads/${body.uploadId}/${encodeURIComponent(row.filename)}`;
          item = { id: secretId(), url, title: body.title?.trim() || row.filename, kind: "file", addedBy: userId, addedAt: now() };
        } else {
          let url: URL;
          try {
            url = new URL(body.url.trim());
          } catch {
            throw badRequest("Link inválido");
          }
          if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("Use um link http ou https");
          const kind = classify(url);
          item = { id: secretId(), url: url.toString(), title: body.title?.trim() || (await titleFor(url, kind)), kind, addedBy: userId, addedAt: now() };
        }
        state.queue.push(item);
        if (!state.currentId) {
          state.currentId = item.id;
          state.position = 0;
          state.paused = false;
        }
        break;
      }
      case "remove": {
        if (!moderator && !owns(body.itemId)) throw forbidden("Só quem adicionou ou um moderador pode remover");
        if (state.currentId === body.itemId) advance(state);
        state.queue = state.queue.filter((i) => i.id !== body.itemId);
        break;
      }
      case "play": {
        if (body.itemId && body.itemId !== state.currentId) {
          if (!state.queue.some((i) => i.id === body.itemId)) throw notFound("Item");
          state.currentId = body.itemId;
          state.position = 0;
        }
        if (!state.currentId) throw badRequest("A fila está vazia");
        state.paused = false;
        break;
      }
      case "pause":
        state.paused = true;
        state.position = body.position;
        break;
      case "seek":
        state.position = body.position;
        break;
      case "next":
        if (!moderator && !owns(state.currentId)) throw forbidden("Só quem adicionou ou um moderador pode pular");
        advance(state);
        break;
      case "ended":
        // Every viewer reports the end; only the first one for the current item counts (above).
        if (state.autoplay) advance(state);
        else state.paused = true;
        break;
      case "move": {
        if (!moderator) throw forbidden("Só moderadores podem reordenar a fila");
        const from = state.queue.findIndex((i) => i.id === body.itemId);
        if (from < 0) throw notFound("Item");
        const [item] = state.queue.splice(from, 1);
        state.queue.splice(Math.min(body.index, state.queue.length), 0, item!);
        break;
      }
      case "autoplay":
        state.autoplay = body.value;
        break;
      case "ducking":
        if (channel.type !== "song") throw badRequest("Só salas de música abaixam o volume quando alguém fala");
        state.ducking = body.value;
        break;
      case "dj":
        if (channel.type !== "song") throw badRequest("Só salas de música têm modo DJ");
        state.dj = body.value;
        if (body.style) state.djStyle = body.style as NonNullable<PlaybackState["djStyle"]>;
        state.djStyle ??= "auto";
        // A DJ always moves on to the next track.
        if (body.value) state.autoplay = true;
        break;
    }
    return save(channel, state);
  });
}
