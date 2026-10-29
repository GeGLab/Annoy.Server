import { has, Permission, type MediaSource, type VoiceMethod, type VoiceState } from "@distopic/protocol";
import * as mediasoup from "mediasoup";
import type { types as ms } from "mediasoup";
import { config, detectRouteAddress } from "./config.ts";
import { sourceFor } from "./media-source.ts";
import { badRequest, forbidden, notFound } from "./errors.ts";
import { onServerChanged, sendToServer, type Connection } from "./events.ts";
import { channelPermissions } from "./perms.ts";
import { getChannel } from "./repo.ts";

const MEDIA_CODECS: ms.RouterRtpCodecCapability[] = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2, preferredPayloadType: 111 },
  { kind: "video", mimeType: "video/VP8", clockRate: 90000, parameters: { "x-google-start-bitrate": 1000 } },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1, "x-google-start-bitrate": 1000 },
  },
];

/** Screen shares at 1080p can need several Mbps; this caps what one sender may push. */
const MAX_INCOMING_BITRATE = 8_000_000;

const sourceOf = (producer: ms.Producer): MediaSource => producer.appData.source as MediaSource;

interface Peer {
  conn: Connection;
  userId: string;
  serverId: string;
  channelId: string;
  transports: Map<string, ms.WebRtcTransport>;
  producers: Map<string, ms.Producer>;
  consumers: Map<string, ms.Consumer>;
}

interface Room {
  router: ms.Router;
  levels: ms.AudioLevelObserver;
  peers: Map<number, Peer>;
}

let worker: ms.Worker;
let webRtcServer: ms.WebRtcServer;
const rooms = new Map<string, Room>();
const roomCreation = new Map<string, Promise<Room>>();
const peersByConn = new Map<number, Peer>();
/** Authoritative voice state, keyed by user (one voice session per user). */
const states = new Map<string, VoiceState>();

let announced: string[] = [];
/** Address → port, as clients will see them in ICE candidates. */
export const voiceAddresses = () => announced.map((address, i) => `${address}:${config.voice.port + i}`);

export async function startVoice(): Promise<void> {
  announced = config.voice.announcedAddresses.length > 0 ? config.voice.announcedAddresses : [await detectRouteAddress()];
  worker = await mediasoup.createWorker({ logLevel: "warn" });
  worker.on("died", () => {
    console.error("mediasoup worker died; exiting so the supervisor restarts the server");
    process.exit(1);
  });
  // One port per announced address: a WebRtcServer can't announce two addresses on the same socket.
  webRtcServer = await worker.createWebRtcServer({
    listenInfos: announced.flatMap((announcedAddress, i) => [
      { protocol: "udp" as const, ip: "0.0.0.0", announcedAddress, port: config.voice.port + i },
      { protocol: "tcp" as const, ip: "0.0.0.0", announcedAddress, port: config.voice.port + i },
    ]),
  });
  onServerChanged(revalidateServer);
}

export function voiceStatesFor(serverId: string): VoiceState[] {
  return [...states.values()].filter((s) => s.serverId === serverId);
}

function publishState(userId: string, serverId: string): void {
  sendToServer(serverId, { t: "VOICE_STATE_UPDATE", d: { userId, serverId, state: states.get(userId) ?? null } });
}

async function getRoom(channelId: string): Promise<Room> {
  const existing = rooms.get(channelId);
  if (existing) return existing;
  const pending = roomCreation.get(channelId);
  if (pending) return pending;
  const creating = (async () => {
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    const levels = await router.createAudioLevelObserver({ maxEntries: 16, threshold: -55, interval: 250 });
    const room: Room = { router, levels, peers: new Map() };
    levels.on("volumes", (volumes) => {
      const loud = new Set(volumes.map((v) => v.producer.appData.userId as string));
      for (const peer of room.peers.values()) markSpeaking(peer, loud.has(peer.userId));
    });
    levels.on("silence", () => {
      for (const peer of room.peers.values()) markSpeaking(peer, false);
    });
    rooms.set(channelId, room);
    return room;
  })();
  roomCreation.set(channelId, creating);
  try {
    return await creating;
  } finally {
    roomCreation.delete(channelId);
  }
}

function markSpeaking(peer: Peer, speaking: boolean): void {
  const state = states.get(peer.userId);
  if (!state || state.speaking === speaking) return;
  state.speaking = speaking;
  publishState(peer.userId, peer.serverId);
}

function peerOf(conn: Connection): Peer {
  const peer = peersByConn.get(conn.id);
  if (!peer) throw badRequest("Não está em um canal de voz");
  return peer;
}

function roomOf(peer: Peer): Room {
  const room = rooms.get(peer.channelId);
  if (!room) throw badRequest("Sala de voz encerrada");
  return room;
}

/** Releases every media resource of the connection's voice session. */
/** Media runs through this process, so a dropped socket ends the session right away. */
export function detachVoice(conn: Connection): void {
  leaveVoice(conn);
}

export function leaveVoice(conn: Connection): void {
  const peer = peersByConn.get(conn.id);
  if (!peer) return;
  peersByConn.delete(conn.id);
  for (const transport of peer.transports.values()) transport.close(); // closes producers/consumers too
  const room = rooms.get(peer.channelId);
  room?.peers.delete(conn.id);
  if (room && room.peers.size === 0) {
    room.router.close();
    rooms.delete(peer.channelId);
  }
  if (states.get(peer.userId)?.channelId === peer.channelId) {
    states.delete(peer.userId);
    publishState(peer.userId, peer.serverId);
  }
}

/** Mirrors which video sources a peer is sending into its public voice state. */
function refreshMediaFlags(peer: Peer): void {
  const state = states.get(peer.userId);
  if (!state || state.channelId !== peer.channelId) return;
  const sources = new Set([...peer.producers.values()].map(sourceOf));
  const video = sources.has("camera");
  const screen = sources.has("screen");
  if (state.video === video && state.screen === screen) return;
  state.video = video;
  state.screen = screen;
  publishState(peer.userId, peer.serverId);
}

function kick(peer: Peer, reason: string): void {
  leaveVoice(peer.conn);
  peer.conn.send({ t: "VOICE_KICKED", d: { reason } });
}

/** The built-in SFU measures audio levels itself; client reports are ignored. */
export function setSpeaking(_conn: Connection, _speaking: boolean): void {}

export function setSelfState(conn: Connection, selfMute: boolean, selfDeaf: boolean, quality?: { width?: number; height: number; fps: number }): void {
  const peer = peersByConn.get(conn.id);
  const state = peer && states.get(peer.userId);
  if (!peer || !state) return;
  state.selfMute = selfMute || selfDeaf;
  state.selfDeaf = selfDeaf;
  if (quality && [480, 720, 1080, 1440, 2160].includes(quality.height) && [15, 24, 30, 60, 120].includes(quality.fps)) state.screenQuality = { height: quality.height, fps: quality.fps, ...([854, 1280, 1920, 2048, 2560, 3840].includes(quality.width ?? 0) && { width: quality.width }) };
  publishState(peer.userId, peer.serverId);
}

export async function setServerMute(serverId: string, userId: string, muted: boolean): Promise<void> {
  const state = states.get(userId);
  if (!state || state.serverId !== serverId) throw notFound("Usuário em voz");
  state.serverMute = muted;
  for (const peer of peersByConn.values()) {
    if (peer.userId !== userId) continue;
    // Server mute silences the microphone only; cameras and screens keep flowing.
    for (const producer of peer.producers.values()) {
      if (sourceOf(producer) === "mic") await (muted ? producer.pause() : producer.resume());
    }
  }
  publishState(userId, serverId);
}

export function disconnectUser(serverId: string, userId: string): void {
  for (const peer of [...peersByConn.values()]) {
    if (peer.userId === userId && peer.serverId === serverId) kick(peer, "Desconectado por um moderador");
  }
}

/** Drops sessions that lost access after a permission or membership change. */
function revalidateServer(serverId: string): void {
  for (const peer of [...peersByConn.values()]) {
    if (peer.serverId !== serverId) continue;
    const channel = getChannel(peer.channelId);
    const perms = channel ? channelPermissions(channel, peer.userId) : 0;
    if (!channel || !has(perms, Permission.VIEW_CHANNEL) || !has(perms, Permission.CONNECT)) {
      kick(peer, "Você perdeu acesso a este canal de voz");
    } else {
      const canSpeak = has(perms, Permission.SPEAK);
      const canStream = has(perms, Permission.STREAM);
      for (const producer of [...peer.producers.values()]) {
        const allowed = sourceOf(producer) === "mic" ? canSpeak : canStream;
        if (!allowed) producer.close();
      }
    }
  }
}

// Signaling --------------------------------------------------------------------

const str = (data: Record<string, unknown>, key: string): string => {
  const v = data[key];
  if (typeof v !== "string" || v === "") throw badRequest(`Campo "${key}" ausente`);
  return v;
};

export async function handleVoice(conn: Connection, method: VoiceMethod, data: Record<string, unknown>): Promise<unknown> {
  const userId = conn.userId;
  if (!userId) throw forbidden();

  switch (method) {
    case "join": {
      const channelId = str(data, "channelId");
      const channel = getChannel(channelId);
      const perms = channel ? channelPermissions(channel, userId) : 0;
      if (!channel || channel.type !== "voice" || !channel.serverId || !has(perms, Permission.VIEW_CHANNEL)) {
        throw notFound("Canal de voz");
      }
      if (!has(perms, Permission.CONNECT)) throw forbidden("Sem permissão para conectar");

      leaveVoice(conn);
      // One voice session per user: a newer device takes over.
      for (const other of [...peersByConn.values()]) if (other.userId === userId) kick(other, "Conectado em outro dispositivo");

      const room = await getRoom(channelId);
      const peer: Peer = {
        conn,
        userId,
        serverId: channel.serverId,
        channelId,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
      };
      room.peers.set(conn.id, peer);
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
      // screenAudio: this server accepts the "screen_audio" source (0.4.2+); older ones would take it for a mic.
      return { backend: "builtin", rtpCapabilities: room.router.rtpCapabilities, canSpeak: has(perms, Permission.SPEAK), canStream: has(perms, Permission.STREAM), screenAudio: true };
    }

    case "createTransport": {
      const peer = peerOf(conn);
      const transport = await roomOf(peer).router.createWebRtcTransport({
        webRtcServer,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1_500_000,
      });
      await transport.setMaxIncomingBitrate(MAX_INCOMING_BITRATE);
      peer.transports.set(transport.id, transport);
      return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      };
    }

    case "connectTransport": {
      const peer = peerOf(conn);
      const transport = peer.transports.get(str(data, "transportId"));
      if (!transport) throw notFound("Transporte");
      await transport.connect({ dtlsParameters: data.dtlsParameters as ms.DtlsParameters });
      return {};
    }

    case "produce": {
      const peer = peerOf(conn);
      const channel = getChannel(peer.channelId);
      const perms = channel ? channelPermissions(channel, userId) : 0;
      const kind = data.kind === "video" ? "video" : data.kind === "audio" ? "audio" : null;
      const source = sourceFor(kind, data.source);
      if (!kind || !source) throw badRequest("Mídia inválida");
      if (source === "mic" && !has(perms, Permission.SPEAK)) throw forbidden("Sem permissão para falar");
      if (source !== "mic" && !has(perms, Permission.STREAM)) throw forbidden("Sem permissão para transmitir câmera ou tela");
      const transport = peer.transports.get(str(data, "transportId"));
      if (!transport) throw notFound("Transporte");
      const room = roomOf(peer);
      // One producer per source: a new camera replaces the previous one.
      for (const existing of [...peer.producers.values()]) if (sourceOf(existing) === source) existing.close();
      const producer = await transport.produce({
        kind,
        rtpParameters: data.rtpParameters as ms.RtpParameters,
        appData: { userId, source },
      });
      peer.producers.set(producer.id, producer);
      producer.observer.on("close", () => {
        peer.producers.delete(producer.id);
        refreshMediaFlags(peer);
      });
      if (source === "mic") {
        if (states.get(userId)?.serverMute) await producer.pause();
        await room.levels.addProducer({ producerId: producer.id });
      }
      refreshMediaFlags(peer);
      for (const other of room.peers.values()) {
        if (other !== peer) {
          other.conn.send({ t: "VOICE_NEW_PRODUCER", d: { channelId: peer.channelId, producerId: producer.id, userId, kind, source } });
        }
      }
      return { id: producer.id };
    }

    case "closeProducer": {
      const peer = peerOf(conn);
      const producer = peer.producers.get(str(data, "producerId"));
      // Consumers observe "producerclose" and notify their own clients.
      producer?.close();
      return {};
    }

    case "getProducers": {
      const peer = peerOf(conn);
      const out: { producerId: string; userId: string; kind: ms.MediaKind; source: MediaSource }[] = [];
      for (const other of roomOf(peer).peers.values()) {
        if (other === peer) continue;
        for (const producer of other.producers.values()) {
          out.push({ producerId: producer.id, userId: other.userId, kind: producer.kind, source: sourceOf(producer) });
        }
      }
      return { producers: out };
    }

    case "consume": {
      const peer = peerOf(conn);
      const room = roomOf(peer);
      const producerId = str(data, "producerId");
      const rtpCapabilities = data.rtpCapabilities as ms.RtpCapabilities;
      if (!room.router.canConsume({ producerId, rtpCapabilities })) throw badRequest("Não é possível consumir este áudio");
      const transport = peer.transports.get(str(data, "transportId"));
      if (!transport) throw notFound("Transporte");
      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
      peer.consumers.set(consumer.id, consumer);
      const closed = () => {
        peer.consumers.delete(consumer.id);
        peer.conn.send({ t: "VOICE_PRODUCER_CLOSED", d: { producerId } });
      };
      consumer.on("producerclose", closed);
      consumer.on("transportclose", () => peer.consumers.delete(consumer.id));
      return { id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
    }

    case "resumeConsumer": {
      const consumer = peerOf(conn).consumers.get(str(data, "consumerId"));
      if (!consumer) throw notFound("Consumidor");
      await consumer.resume();
      return {};
    }

    case "leave":
      leaveVoice(conn);
      return {};

    default:
      throw badRequest("Operação de voz não suportada neste servidor");
  }
}
