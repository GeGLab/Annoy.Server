import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { channel, serve } from './wire.mjs';
import { scopes } from './scopes.mjs';

const singleton = Symbol.for('annoy.live.sessions');
export async function install({ compatibility = false } = {}) {
  if (globalThis[singleton]) return { ready: true, protocol: 3 };
  const base = process.cwd(), require = createRequire(path.join(base, 'package.json'));
  const load = name => import(pathToFileURL(path.join(base, `src/${name}.ts`)).href);
  const manifest = require('./package.json');
  if (compatibility && !['0.12.0-alpha.2', '0.12.0-alpha.6'].includes(manifest.version)) throw Error('Unverified compatibility source');
  const [{ config }, gateway, events, presence, cloudflare, auth, repo] = await Promise.all(['config', 'gateway', 'events', 'presence', 'voice-cloudflare', 'auth', 'repo'].map(load));
  const slot = process.env.ANNOY_SLOT, directory = process.env.ANNOY_CONTROL_DIR;
  if (!directory || !['annoy', 'annoy-b'].includes(slot)) throw Error('Managed slot required');
  const g = gateway.migrationState || (compatibility ? await scopes(gateway.registerGateway, ['live', 'sessionHashes', 'onMessage']) : null);
  const v = cloudflare.migrationState || (compatibility ? await scopes(cloudflare.handleVoice, ['peersByConn', 'states']) : null);
  const p = presence.migrationState || (compatibility ? await scopes(presence.addConnection, ['connections', 'idle', 'manual']) : null);
  if (!g || !v || !p) throw Error('Native migration state unavailable');
  const { WebSocket } = require('ws');
  const token = fs.readFileSync(path.join(config.dataDir, 'admin.token'), 'utf8').trim();
  const equal = value => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const voiceIdentity = createHash('sha256').update(JSON.stringify(config.voice.cloudflare)).digest('hex');
  const pending = new Map(), transfers = new Map(), frozen = new Map(), probes = new Map();
  const pendingVoice = new Set();
  const dropped = new Map(), delivered = new Set();
  const installedAt = Date.now();
  const watch = conn => {
    if (conn.liveMigrationWatched) return;
    conn.liveMigrationWatched = true;
    conn.socket.once('close', () => { for (const id of pendingVoice) if (id.startsWith(`${conn.id}:`)) pendingVoice.delete(id); });
    conn.socket.prependListener('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.op === 'heartbeat' && typeof msg.migrationProbe === 'string') probes.set(msg.migrationProbe, conn.id);
        if (msg.op === 'voice') pendingVoice.add(`${conn.id}:${msg.id}`);
      } catch {}
    });
  };
  const originalSend = events.Connection.prototype.send;
  events.Connection.prototype.send = function(event) {
    watch(this);
    if (event.t === 'VOICE_REPLY') pendingVoice.delete(`${this.id}:${event.d.id}`);
    const frozenState = frozen.get(this.id);
    if (frozenState) { frozenState.events.push(event); return; }
    return originalSend.call(this, event);
  };
  for (const conn of g.live) watch(conn);
  const route = socket => ({ port: socket.remotePort, backendPort: socket.localPort, host: socket.localAddress });
  const legacy = () => globalThis[Symbol.for('annoy.legacy.handoff')];
  function validBackend() {
    if ((process.env.ANNOY_ACCOUNT_MODE || 'global') !== 'global') throw Error('Local social/call state requires its own migration protocol');
    if (config.voice.backend !== 'cloudflare' && v.peersByConn.size) throw Error('Embedded media workers cannot be replaced by a signaling-only transfer');
    // With builtin voice the other module owns peers, so fail closed even if
    // this Cloudflare map is empty. No fake successful media handoff.
    if (config.voice.backend !== 'cloudflare') throw Error('Live migration requires external Cloudflare media');
  }
  function detach(conn) {
    g.live.delete(conn); g.sessionHashes.delete(conn); events.unregister(conn);
    presence.removeConnection(conn.userId, conn.id);
    v.peersByConn.delete(conn.id);
    if (![...v.peersByConn.values()].some(peer => peer.userId === conn.userId)) v.states.delete(conn.userId);
    conn.socket.removeAllListeners('message'); conn.socket.removeAllListeners('close');
  }
  function adopt(record) {
    const { conn, session, ws } = record;
    events.register(conn, session.userId); g.sessionHashes.set(conn, session.sessionHash); g.live.add(conn);
    presence.addConnection(session.userId); presence.setManualPresence(session.userId, session.manual || 'online');
    if (session.idle) presence.setConnectionIdle(session.userId, conn.id, true);
    if (session.peer) {
      v.peersByConn.set(conn.id, { ...session.peer, conn, published: new Map(session.peer.published), pulled: new Map(session.peer.pulled) });
      v.states.set(session.userId, session.voiceState);
    }
    watch(conn);
    ws.on('message', (raw, binary) => {
      if (binary || raw.length > 64 * 1024) return ws.close(4002, 'invalid frame');
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return ws.close(4002, 'invalid json'); }
      conn.lastHeartbeat = Date.now();
      void g.onMessage(conn, msg).catch(error => console.warn('Migrated gateway message failed', error.message));
    });
    ws.on('close', () => {
      g.live.delete(conn); g.sessionHashes.delete(conn);
      cloudflare.leaveVoice(conn); events.unregister(conn); presence.removeConnection(conn.userId, conn.id);
    });
  }
  async function command(method, data) {
    if (method === 'status') return { protocol: 3, version: manifest.version, slot, connections: g.live.size, voices: v.peersByConn.size, mediaFingerprint: createHash('sha256').update(JSON.stringify([...v.peersByConn.values()].map(peer => ({ sessionId: peer.sessionId, published: [...peer.published.keys()].sort(), pulled: [...peer.pulled.keys()].sort() })).sort((a,b) => a.sessionId.localeCompare(b.sessionId)))).digest('hex'), ready: !compatibility || Date.now() - installedAt > 16_000, pendingVoice: pendingVoice.size, frozen: frozen.size, transfers: [...transfers.entries()] };
    if (method === 'routes') {
      const routes = [];
      for (const socket of process._getActiveHandles().filter(h => h instanceof net.Socket && h.localPort === Number(process.env.ANNOY_PORT || 8787))) {
        const symbol = Object.getOwnPropertySymbols(socket).find(k => k.description === 'websocket');
        const front = symbol && socket[symbol];
        if (!front || front.readyState !== 1 || [...g.live].some(conn => conn.socket === front)) continue;
        const listener = front.listeners('message')[0];
        if (!listener) throw Error('Legacy relay cannot be identified');
        const { upstream } = await scopes(listener, ['upstream']);
        if (upstream.readyState !== 1) throw Error('Legacy relay is unavailable');
        const nonce = randomUUID(); upstream.send(JSON.stringify({ op: 'heartbeat', migrationProbe: nonce }));
        routes.push({ nonce, route: route(socket) });
      }
      return routes;
    }
    if (method === 'freeze') {
      validBackend();
      if (compatibility && Date.now() - installedAt < 16_000 || pendingVoice.size) throw Error('Voice commands are still completing');
      if (frozen.size) throw Error('Sessions already frozen');
      const sessions = [];
      try {
        for (const conn of g.live) {
          if (!conn.userId) throw Error('An identification is still completing');
          const ws = conn.socket, socket = ws._socket, receiver = ws._receiver;
          socket.pause();
          frozen.set(conn.id, { conn, events: [] });
          if (ws.readyState !== 1 || Object.keys(ws._extensions).length || receiver._state !== 0 || receiver._bufferedBytes || receiver._fragmented || socket.readableLength || socket.writableLength || ws._sender._bufferedBytes) throw Error('WebSocket is between message boundaries; retry safely');
          const sessionHash = g.sessionHashes.get(conn);
          if (!sessionHash || auth.userIdForSessionHash(sessionHash) !== conn.userId) throw Error('Session is no longer authorized');
          const peer = v.peersByConn.get(conn.id);
          sessions.push({ id: conn.id, userId: conn.userId, deviceId: conn.deviceId, features: [...conn.features], sessionHash, manual: p.manual.get(conn.userId), idle: p.idle.get(conn.userId)?.has(conn.id) || false,
            route: route(socket), linkId: conn.liveMigrationLink,
            nonce: [...probes].find(([, id]) => id === conn.id)?.[0], voiceIdentity,
            peer: peer ? { userId: peer.userId, serverId: peer.serverId, channelId: peer.channelId, sessionId: peer.sessionId, published: [...peer.published], pulled: [...peer.pulled] } : null,
            voiceState: peer ? v.states.get(conn.userId) : null });
        }
        return sessions;
      } catch (error) { await command('resume', {}); throw error; }
    }
    if (method === 'resume') {
      for (const { conn, events: queued } of frozen.values()) { for (const event of queued) originalSend.call(conn, event); conn.socket._socket.resume(); }
      frozen.clear(); return { ready: true };
    }
    if (method === 'activate') {
      if (transfers.has(data.transaction)) return { connections: (pending.get(data.transaction) || []).length, voices: (pending.get(data.transaction) || []).filter(r => r.session.peer).length };
      const records = pending.get(data.transaction);
      const prepared = records || [];
      if (prepared.length !== data.count || prepared.some(r => r.ws.readyState !== 1 || r.ws._socket.destroyed)) throw Error('Prepared session set is incomplete');
      for (const record of prepared) if (auth.userIdForSessionHash(record.session.sessionHash) !== record.session.userId) throw Error('Session revoked before activation');
      for (const record of prepared) adopt(record);
      transfers.set(data.transaction, 'active');
      return { connections: prepared.length, voices: prepared.filter(r => r.session.peer).length };
    }
    if (method === 'deliver') {
      if (delivered.has(data.transaction)) return {};
      for (const record of pending.get(data.transaction) || []) for (const event of data.events[record.session.id] || []) record.conn.send(event);
      delivered.add(data.transaction);
      return {};
    }
    if (method === 'release') {
      if (transfers.get(data.transaction) === 'released') return { ready: true };
      if (transfers.get(data.transaction) !== 'active') throw Error('Target ownership was not activated');
      for (const record of pending.get(data.transaction) || []) { record.peer.release(); record.ws._socket.resume(); }
      transfers.set(data.transaction, 'released');
      pending.delete(data.transaction); return { ready: true };
    }
    if (method === 'drop') {
      if (dropped.has(data.transaction)) return dropped.get(data.transaction);
      const queued = {};
      for (const id of data.ids) {
        const entry = frozen.get(id); if (!entry) throw Error('Source session is not frozen');
        queued[id] = entry.events;
      }
      for (const id of data.ids) {
        const { conn } = frozen.get(id); detach(conn); frozen.delete(id); conn.socket.terminate();
      }
      if (!g.live.size && legacy()) legacy().uninstall();
      dropped.set(data.transaction, queued);
      return queued;
    }
    if (method === 'idle-http') {
      const servers = process._getActiveHandles().filter(h => h instanceof net.Server && h.listening && h.address()?.port === Number(process.env.ANNOY_PORT || 8787));
      for (const server of servers) server.closeIdleConnections?.();
      return { pending: process._getActiveHandles().filter(s => s instanceof net.Socket && s._httpMessage && !s._httpMessage.writableEnded).length };
    }
    if (method === 'abort') {
      if (transfers.has(data.transaction)) throw Error('An activated transfer must complete');
      for (const record of pending.get(data.transaction) || []) record.ws.terminate();
      pending.delete(data.transaction); return {};
    }
    throw Error('Unknown session operation');
  }
  const controlPath = path.join(directory, `sessions-${slot}.sock`), gatewayPath = path.join(directory, `gateway-${slot}.sock`);
  for (const filename of [controlPath, gatewayPath]) { try { fs.unlinkSync(filename); } catch {} }
  const control = net.createServer(socket => serve(socket, message => {
    if (!equal(message.auth)) throw Error('Unauthorized private request');
    return command(message.method, message.data || {});
  }));
  const raw = net.createServer(socket => {
    const peer = channel(socket);
    void (async () => {
      try {
        const message = await peer.read(), session = message.session;
        validBackend();
        if (!equal(message.auth) || !/^[a-f0-9-]{36}$/.test(message.transaction) || session.voiceIdentity !== voiceIdentity || auth.userIdForSessionHash(session.sessionHash) !== session.userId || !repo.getUser(session.userId)) throw Error('Session import authorization failed');
        if (session.peer && (!session.voiceState || session.peer.userId !== session.userId || session.peer.channelId !== session.voiceState.channelId)) throw Error('Invalid voice ownership');
        if (transfers.has(message.transaction)) throw Error('Transaction already activated');
        const ws = new WebSocket(null, undefined, { autoPong: true });
        ws.on('error', () => {});
        // No HTTP upgrade or READY goes to the client: its original WebSocket
        // and its existing Cloudflare RTCPeerConnection remain established.
        peer.send({ ok: true });
        const connection = peer.release();
        ws.setSocket(connection, Buffer.alloc(0), { allowSynchronousEvents: true, maxPayload: 64 * 1024, skipUTF8Validation: false });
        connection.pause();
        const conn = new events.Connection(ws); conn.deviceId = session.deviceId; conn.features = new Set(session.features); conn.liveMigrationLink = session.linkId;
        const record = { peer, ws, conn, session };
        let records = pending.get(message.transaction); if (!records) pending.set(message.transaction, records = []);
        if (records.some(r => r.session.id === session.id)) throw Error('Duplicate session import');
        records.push(record);
      } catch (error) { if (!socket.destroyed) { try { peer.send({ ok: false, error: error.message }); } catch {} socket.destroy(); } }
    })();
  });
  for (const [server, filename] of [[control, controlPath], [raw, gatewayPath]]) {
    server.on('error', error => console.warn('Private session listener failed', error.message));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(filename, () => { fs.chmodSync(filename, 0o600); resolve(); }); });
  }
  globalThis[singleton] = { command };
  return { ready: true, protocol: 3 };
}
