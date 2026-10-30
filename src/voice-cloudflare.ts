// Voice through Cloudflare's Realtime SFU, for hosts without a reachable
// public address (CGNAT). Media flows between each client and Cloudflare; this
// server keeps every decision: who may publish, who may receive which track,
// server mute and permission changes. The app token never leaves the server.
//
// Each client has one Cloudflare session (one RTCPeerConnection). Publishing
// sends the client's offer; subscribing asks Cloudflare for an offer that the
// client answers through `renegotiate`.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { has, isVoiceChannel, Permission, type MediaSource, type VoiceMethod, type VoiceState } from "@distopic/protocol";
import { config } from "./config.ts";
import { sourceFor } from "./media-source.ts";
import { badRequest, forbidden, HttpError, notFound } from "./errors.ts";
import { onServerChanged, sendToServer, voiceChanged, type Connection } from "./events.ts";
import { channelPermissions } from "./perms.ts";
import { getChannel } from "./repo.ts";
import * as budget from "./sfu-budget.ts";

const API = "https://rtc.live.cloudflare.com/v1/apps";
const ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];
const BUDGET_TICK_S = 10;
const VIDEO_PAUSED = "Câmera e tela pausadas: esta instância está perto do limite mensal de tráfego de voz";
const VOICE_PAUSED = "Esta instância atingiu o limite mensal de tráfego de voz; a voz volta no próximo mês";

interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

interface CfTrackResult {
  mid?: string;
  trackName?: string;
  errorCode?: string;
  errorDescription?: string;
}

interface CfResponse {
  sessionId?: string;
  sessionDescription?: SessionDescription;
  requiresImmediateRenegotiation?: boolean;
  tracks?: CfTrackResult[];
  errorCode?: string;
  errorDescription?: string;
}

async function cf(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<CfResponse> {
  const { appId, appToken } = config.voice.cloudflare;
  const res = await fetch(`${API}/${appId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as CfResponse;
  if (!res.ok || json.errorCode) {
    throw new HttpError(502, "sfu_error", `Cloudflare SFU: ${json.errorDescription || json.errorCode || `HTTP ${res.status}`}`);
  }
  return json;
}

function firstTrack(res: CfResponse): CfTrackResult {
  const track = res.tracks?.[0];
  if (!track || track.errorCode) throw new HttpError(502, "sfu_error", `Cloudflare SFU: ${track?.errorDescription || track?.errorCode || "faixa recusada"}`);
  return track;
}

interface Published {
  trackName: string;
  mid: string;
  kind: "audio" | "video";
  source: MediaSource;
  /** What each viewer costs in Cloudflare egress, bytes per second. */
  rate: number;
  /** Server mute or lost permission: nobody may receive it until unblocked. */
  blocked: boolean;
}

interface Peer {
  conn: Connection;
  /** Set while the socket is gone: the session keeps flowing until the client resumes or the grace ends. */
  detached?: ReturnType<typeof setTimeout>;
  userId: string;
  serverId: string;
  channelId: string;
  sessionId: string;
  published: Map<string, Published>;
  /** trackName → mid in this peer's session, for tracks it receives. */
  pulled: Map<string, string>;
}

const peersByConn = new Map<number, Peer>();
const states = new Map<string, VoiceState>();

const roomPeers = (channelId: string) => [...peersByConn.values()].filter((p) => p.channelId === channelId);

export const voiceAddresses = () => ["Cloudflare Realtime SFU"];

export async function startVoice(): Promise<void> {
  onServerChanged(revalidateServer);
  let lastLevel = budget.level();
  setInterval(() => {
    // Cloudflare bills what it sends: every track each peer receives.
    const rateOf = new Map<string, number>();
    for (const peer of peersByConn.values()) for (const t of peer.published.values()) rateOf.set(t.trackName, t.rate);
    const received: number[] = [];
    for (const peer of peersByConn.values()) {
      for (const trackName of peer.pulled.keys()) {
        const rate = rateOf.get(trackName);
        if (rate) received.push(rate);
      }
    }
    budget.record(received, BUDGET_TICK_S);
    const current = budget.level();
    if (current === lastLevel) return;
    lastLevel = current;
    if (current === "off") for (const peer of [...peersByConn.values()]) kick(peer, VOICE_PAUSED);
    else for (const serverId of new Set([...peersByConn.values()].map((p) => p.serverId))) revalidateServer(serverId);
  }, BUDGET_TICK_S * 1000).unref();
}

export function voiceStatesFor(serverId: string): VoiceState[] {
  return [...states.values()].filter((s) => s.serverId === serverId);
}

function publishState(userId: string, serverId: string): void {
  sendToServer(serverId, { t: "VOICE_STATE_UPDATE", d: { userId, serverId, state: states.get(userId) ?? null } });
  voiceChanged(serverId);
}

function refreshMediaFlags(peer: Peer): void {
  const state = states.get(peer.userId);
  if (!state || state.channelId !== peer.channelId) return;
  const sources = new Set([...peer.published.values()].map((t) => t.source));
  const video = sources.has("camera");
  const screen = sources.has("screen");
  if (state.video === video && state.screen === screen) return;
  state.video = video;
  state.screen = screen;
  publishState(peer.userId, peer.serverId);
}

/** Stops delivering a track to everyone who receives it (the publisher keeps its session). */
async function unsubscribeAll(publisher: Peer, trackName: string): Promise<void> {
  for (const other of roomPeers(publisher.channelId)) {
    const mid = other.pulled.get(trackName);
    if (mid === undefined) continue;
    other.pulled.delete(trackName);
    other.conn.send({ t: "VOICE_PRODUCER_CLOSED", d: { producerId: trackName } });
    await cf("PUT", `/sessions/${other.sessionId}/tracks/close`, { tracks: [{ mid }], force: true }).catch(() => undefined);
  }
}

function announce(publisher: Peer, track: Published): void {
  for (const other of roomPeers(publisher.channelId)) {
    if (other !== publisher) {
      other.conn.send({
        t: "VOICE_NEW_PRODUCER",
        d: { channelId: publisher.channelId, producerId: track.trackName, userId: publisher.userId, kind: track.kind, source: track.source },
      });
    }
  }
}

async function setBlocked(peer: Peer, track: Published, blocked: boolean): Promise<void> {
  if (track.blocked === blocked) return;
  track.blocked = blocked;
  if (blocked) await unsubscribeAll(peer, track.trackName);
  else announce(peer, track);
}

/** How long a dropped socket keeps its voice session for the client to resume. */
const DETACH_GRACE_MS = 20_000;
/** After a server restart, tracks still pulled from peers that never came back are dropped after this. */
const ORPHAN_GRACE_MS = 25_000;

/**
 * The gateway socket closed, but media flows through Cloudflare, not through
 * this server: keep the session so a reconnecting client resumes without a gap.
 */
export function detachVoice(conn: Connection): void {
  const peer = peersByConn.get(conn.id);
  if (!peer || peer.detached) return;
  peer.detached = setTimeout(() => {
    if (peersByConn.get(conn.id) === peer) leaveVoice(conn);
  }, DETACH_GRACE_MS);
}

/** Proves a client owns a Cloudflare session, across restarts (the app token is the key). */
const resumeToken = (userId: string, sessionId: string) =>
  createHmac("sha256", config.voice.cloudflare.appToken).update(`annoy-voice-resume:${userId}:${sessionId}`).digest("base64url");

function validResumeToken(userId: string, sessionId: string, token: unknown): boolean {
  if (typeof token !== "string") return false;
  const expected = Buffer.from(resumeToken(userId, sessionId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Tells receivers to drop tracks whose publisher never resumed after a restart. */
function dropOrphanPulls(): void {
  const live = new Set<string>();
  for (const peer of peersByConn.values()) for (const name of peer.published.keys()) live.add(name);
  for (const peer of peersByConn.values()) {
    for (const [trackName, mid] of [...peer.pulled]) {
      if (live.has(trackName)) continue;
      peer.pulled.delete(trackName);
      peer.conn.send({ t: "VOICE_PRODUCER_CLOSED", d: { producerId: trackName } });
      void cf("PUT", `/sessions/${peer.sessionId}/tracks/close`, { tracks: [{ mid }], force: true }).catch(() => undefined);
    }
  }
}

export function leaveVoice(conn: Connection): void {
  const peer = peersByConn.get(conn.id);
  if (!peer) return;
  clearTimeout(peer.detached);
  peersByConn.delete(conn.id);
  // Receivers drop the tracks; Cloudflare ends the session when the client's connection closes.
  for (const track of peer.published.values()) {
    for (const other of roomPeers(peer.channelId)) {
      const mid = other.pulled.get(track.trackName);
      if (mid === undefined) continue;
      other.pulled.delete(track.trackName);
      other.conn.send({ t: "VOICE_PRODUCER_CLOSED", d: { producerId: track.trackName } });
      void cf("PUT", `/sessions/${other.sessionId}/tracks/close`, { tracks: [{ mid }], force: true }).catch(() => undefined);
    }
  }
  if (states.get(peer.userId)?.channelId === peer.channelId) {
    states.delete(peer.userId);
    publishState(peer.userId, peer.serverId);
  }
}

function kick(peer: Peer, reason: string): void {
  leaveVoice(peer.conn);
  peer.conn.send({ t: "VOICE_KICKED", d: { reason } });
}

export function setSelfState(conn: Connection, selfMute: boolean, selfDeaf: boolean, quality?: { width?: number; height: number; fps: number }): void {
  const peer = peersByConn.get(conn.id);
  const state = peer && states.get(peer.userId);
  if (!peer || !state) return;
  state.selfMute = selfMute || selfDeaf;
  state.selfDeaf = selfDeaf;
  if (quality && [0, 480, 720, 1080, 1440, 2160].includes(quality.height) && [0, 15, 24, 30, 60, 120].includes(quality.fps)) state.screenQuality = { height: quality.height, fps: quality.fps, ...([0, 854, 1280, 1920, 2048, 2560, 3840].includes(quality.width ?? 0) && { width: quality.width }) };
  if (state.selfMute) state.speaking = false;
  publishState(peer.userId, peer.serverId);
}

/** Cloudflare doesn't measure levels, so the client reports when it's talking. */
export function setSpeaking(conn: Connection, speaking: boolean): void {
  const peer = peersByConn.get(conn.id);
  const state = peer && states.get(peer.userId);
  if (!peer || !state) return;
  const value = speaking && !state.selfMute && !state.serverMute;
  if (state.speaking === value) return;
  state.speaking = value;
  publishState(peer.userId, peer.serverId);
}

export async function setServerMute(serverId: string, userId: string, muted: boolean): Promise<void> {
  const state = states.get(userId);
  if (!state || state.serverId !== serverId) throw notFound("Usuário em voz");
  state.serverMute = muted;
  if (muted) state.speaking = false;
  for (const peer of peersByConn.values()) {
    if (peer.userId !== userId) continue;
    for (const track of peer.published.values()) if (track.source === "mic") await setBlocked(peer, track, muted || !canPublish(peer, "mic"));
  }
  publishState(userId, serverId);
}

export function disconnectUser(serverId: string, userId: string): void {
  for (const peer of [...peersByConn.values()]) if (peer.userId === userId && peer.serverId === serverId) kick(peer, "Desconectado por um moderador");
}

function canPublish(peer: Peer, source: MediaSource): boolean {
  if (source !== "mic" && budget.level() !== "ok") return false;
  const channel = getChannel(peer.channelId);
  const perms = channel ? channelPermissions(channel, peer.userId) : 0;
  return has(perms, source === "mic" ? Permission.SPEAK : Permission.STREAM);
}

function revalidateServer(serverId: string): void {
  for (const peer of [...peersByConn.values()]) {
    if (peer.serverId !== serverId) continue;
    const channel = getChannel(peer.channelId);
    const perms = channel ? channelPermissions(channel, peer.userId) : 0;
    if (!channel || !has(perms, Permission.VIEW_CHANNEL) || !has(perms, Permission.CONNECT)) {
      kick(peer, "Você perdeu acesso a este canal de voz");
      continue;
    }
    const muted = states.get(peer.userId)?.serverMute ?? false;
    for (const track of peer.published.values()) {
      void setBlocked(peer, track, !canPublish(peer, track.source) || (track.source === "mic" && muted));
    }
  }
}

const str = (data: Record<string, unknown>, key: string): string => {
  const v = data[key];
  if (typeof v !== "string" || v === "") throw badRequest(`Campo "${key}" ausente`);
  return v;
};

function peerOf(conn: Connection): Peer {
  const peer = peersByConn.get(conn.id);
  if (!peer) throw badRequest("Não está em um canal de voz");
  return peer;
}

export async function handleVoice(conn: Connection, method: VoiceMethod, data: Record<string, unknown>): Promise<unknown> {
  const userId = conn.userId;
  if (!userId) throw forbidden();

  switch (method) {
    case "join": {
      const channelId = str(data, "channelId");
      const channel = getChannel(channelId);
      const perms = channel ? channelPermissions(channel, userId) : 0;
      if (!channel || !isVoiceChannel(channel.type) || !channel.serverId || !has(perms, Permission.VIEW_CHANNEL)) throw notFound("Canal de voz");
      if (!has(perms, Permission.CONNECT)) throw forbidden("Sem permissão para conectar");
      if (budget.level() === "off") throw forbidden(VOICE_PAUSED);
      leaveVoice(conn);
      for (const other of [...peersByConn.values()]) if (other.userId === userId) kick(other, "Conectado em outro dispositivo");
      const session = await cf("POST", "/sessions/new");
      if (!session.sessionId) throw new HttpError(502, "sfu_error", "Cloudflare SFU não criou a sessão");
      const peer: Peer = { conn, userId, serverId: channel.serverId, channelId, sessionId: session.sessionId, published: new Map(), pulled: new Map() };
      peersByConn.set(conn.id, peer);
      states.set(userId, {
        userId,
        serverId: channel.serverId,
        channelId,
        selfMute: data.selfMute === true,
        selfDeaf: data.selfDeaf === true,
        serverMute: false,
        speaking: false,
        video: false,
        screen: false,
      });
      publishState(userId, channel.serverId);
      return {
        backend: "cloudflare",
        iceServers: ICE_SERVERS,
        canSpeak: has(perms, Permission.SPEAK),
        canStream: has(perms, Permission.STREAM) && budget.level() === "ok",
        screenAudio: true,
        sessionId: session.sessionId,
        resumeToken: resumeToken(userId, session.sessionId),
      };
    }

    case "resume": {
      const channelId = str(data, "channelId");
      const sessionId = str(data, "sessionId");
      if (!validResumeToken(userId, sessionId, data.resumeToken)) throw forbidden("Sessão de voz inválida");
      const channel = getChannel(channelId);
      const perms = channel ? channelPermissions(channel, userId) : 0;
      if (!channel || !isVoiceChannel(channel.type) || !channel.serverId || !has(perms, Permission.VIEW_CHANNEL)) throw notFound("Canal de voz");
      if (!has(perms, Permission.CONNECT)) throw forbidden("Sem permissão para conectar");
      if (budget.level() === "off") throw forbidden(VOICE_PAUSED);
      // Same server process: the session is still here, just re-attach it to the new socket.
      let peer = [...peersByConn.values()].find((p) => p.userId === userId && p.sessionId === sessionId);
      if (peer) {
        clearTimeout(peer.detached);
        peer.detached = undefined;
        peersByConn.delete(peer.conn.id);
        peer.conn = conn;
      } else {
        // The server restarted: rebuild what the client says its session carries.
        const published = new Map<string, Published>();
        for (const raw of Array.isArray(data.published) ? (data.published as Record<string, unknown>[]) : []) {
          const kind = raw.kind === "video" ? "video" : raw.kind === "audio" ? "audio" : null;
          const source = sourceFor(kind, raw.source);
          const trackName = typeof raw.trackName === "string" ? raw.trackName : "";
          const mid = typeof raw.mid === "string" ? raw.mid : "";
          if (!kind || !source || !trackName.startsWith(`${source}-`) || !mid) continue;
          published.set(trackName, { trackName, mid, kind, source, rate: budget.rateFor(source, raw.maxBitrate), blocked: false });
        }
        const pulled = new Map<string, string>();
        for (const raw of Array.isArray(data.pulled) ? (data.pulled as Record<string, unknown>[]) : []) {
          if (typeof raw.trackName === "string" && typeof raw.mid === "string") pulled.set(raw.trackName, raw.mid);
        }
        peer = { conn, userId, serverId: channel.serverId, channelId, sessionId, published, pulled };
        setTimeout(dropOrphanPulls, ORPHAN_GRACE_MS).unref();
      }
      for (const other of [...peersByConn.values()]) if (other.userId === userId && other !== peer) kick(other, "Conectado em outro dispositivo");
      peersByConn.set(conn.id, peer);
      const previous = states.get(userId);
      states.set(userId, {
        userId,
        serverId: channel.serverId,
        channelId,
        selfMute: data.selfMute === true,
        selfDeaf: data.selfDeaf === true,
        serverMute: previous?.channelId === channelId ? previous.serverMute : false,
        speaking: false,
        video: false,
        screen: false,
      });
      refreshMediaFlags(peer);
      publishState(userId, channel.serverId);
      // Permissions may have changed while away; blocked tracks stop reaching others.
      for (const track of peer.published.values()) {
        void setBlocked(peer, track, !canPublish(peer, track.source) || (track.source === "mic" && (states.get(userId)?.serverMute ?? false)));
      }
      const producers: { producerId: string; userId: string; kind: "audio" | "video"; source: MediaSource }[] = [];
      for (const other of roomPeers(channelId)) {
        if (other === peer) continue;
        for (const t of other.published.values()) if (!t.blocked) producers.push({ producerId: t.trackName, userId: other.userId, kind: t.kind, source: t.source });
      }
      return {
        canSpeak: has(perms, Permission.SPEAK),
        canStream: has(perms, Permission.STREAM) && budget.level() === "ok",
        producers,
      };
    }

    case "publish": {
      const peer = peerOf(conn);
      const kind = data.kind === "video" ? "video" : data.kind === "audio" ? "audio" : null;
      const source = sourceFor(kind, data.source);
      if (!kind || !source) throw badRequest("Mídia inválida");
      if (source !== "mic" && budget.level() !== "ok") throw forbidden(VIDEO_PAUSED);
      if (!canPublish(peer, source)) throw forbidden(source === "mic" ? "Sem permissão para falar" : "Sem permissão para transmitir câmera ou tela");
      const mid = str(data, "mid");
      const trackName = `${source}-${randomUUID()}`;
      const res = await cf("POST", `/sessions/${peer.sessionId}/tracks/new`, {
        sessionDescription: { type: "offer", sdp: str(data, "sdp") },
        tracks: [{ location: "local", mid, trackName }],
      });
      firstTrack(res);
      // A second camera replaces the first, like the built-in backend.
      for (const existing of [...peer.published.values()]) {
        if (existing.source === source) {
          peer.published.delete(existing.trackName);
          await unsubscribeAll(peer, existing.trackName);
        }
      }
      const blocked = source === "mic" && (states.get(userId)?.serverMute ?? false);
      const track: Published = { trackName, mid, kind, source, rate: budget.rateFor(source, data.maxBitrate), blocked };
      peer.published.set(trackName, track);
      refreshMediaFlags(peer);
      if (!blocked) announce(peer, track);
      return { producerId: trackName, sdp: res.sessionDescription?.sdp };
    }

    case "getProducers": {
      const peer = peerOf(conn);
      const out: { producerId: string; userId: string; kind: "audio" | "video"; source: MediaSource }[] = [];
      for (const other of roomPeers(peer.channelId)) {
        if (other === peer) continue;
        for (const t of other.published.values()) if (!t.blocked) out.push({ producerId: t.trackName, userId: other.userId, kind: t.kind, source: t.source });
      }
      return { producers: out };
    }

    case "subscribe": {
      const peer = peerOf(conn);
      const trackName = str(data, "producerId");
      const publisher = roomPeers(peer.channelId).find((p) => p !== peer && p.published.has(trackName));
      const track = publisher?.published.get(trackName);
      if (!publisher || !track || track.blocked) throw notFound("Faixa");
      const res = await cf("POST", `/sessions/${peer.sessionId}/tracks/new`, {
        tracks: [{ location: "remote", sessionId: publisher.sessionId, trackName }],
      });
      const result = firstTrack(res);
      if (!result.mid) throw new HttpError(502, "sfu_error", "Cloudflare SFU não devolveu a faixa");
      peer.pulled.set(trackName, result.mid);
      return {
        mid: result.mid,
        kind: track.kind,
        sdp: res.sessionDescription?.sdp,
        renegotiate: res.requiresImmediateRenegotiation === true,
      };
    }

    case "renegotiate": {
      const peer = peerOf(conn);
      await cf("PUT", `/sessions/${peer.sessionId}/renegotiate`, { sessionDescription: { type: "answer", sdp: str(data, "sdp") } });
      return {};
    }

    case "closeProducer": {
      const peer = peerOf(conn);
      const track = peer.published.get(str(data, "producerId"));
      if (!track) return {};
      peer.published.delete(track.trackName);
      await unsubscribeAll(peer, track.trackName);
      refreshMediaFlags(peer);
      // A negotiated close keeps the client's SDP in step with Cloudflare.
      const sdp = typeof data.sdp === "string" ? data.sdp : null;
      const res = await cf("PUT", `/sessions/${peer.sessionId}/tracks/close`, {
        tracks: [{ mid: track.mid }],
        force: sdp === null,
        ...(sdp && { sessionDescription: { type: "offer", sdp } }),
      });
      return { sdp: res.sessionDescription?.sdp };
    }

    case "leave":
      leaveVoice(conn);
      return {};

    default:
      throw badRequest("Operação de voz não suportada neste servidor");
  }
}
