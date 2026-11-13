import net from 'node:net';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { channel, connect } from './wire.mjs';

const key = Symbol.for('annoy.live.proxy');
export function install() {
  if (globalThis[key]) return { ready: true, protocol: 3 };
  const directory = process.env.ANNOY_CONTROL_DIR || '/control';
  const port = Number(process.env.ANNOY_PROXY_PORT || 8787);
  const servers = process._getActiveHandles().filter(s => s instanceof net.Server && s.listening && s.address()?.port === port);
  if (servers.length !== 1) throw Error('Public proxy listener could not be verified');
  const server = servers[0], listeners = server.listeners('connection');
  if (listeners.length !== 1) throw Error('Unexpected proxy listener');
  const pairs = new Map(), held = new Set();
  let frozen = false, controller, attempt;
  function capture() {
    for (const client of process._getActiveHandles().filter(s => s instanceof net.Socket && s.localPort === port && !s.destroyed)) {
      if ([...pairs.values()].some(p => p.client === client)) continue;
      const pipes = client._readableState.pipes;
      const upstream = Array.isArray(pipes) ? pipes[0] : pipes;
      if (!(upstream instanceof net.Socket) || upstream._readableState.pipes?.[0] !== client) continue;
      const id = randomUUID(), pair = { id, client, upstream, original: upstream, staged: null, switched: false };
      pairs.set(id, pair);
      client.once('close', () => { pair.upstream?.destroy(); pair.staged?.socket.destroy(); pairs.delete(id); });
    }
  }
  function accept(client) {
    if (!frozen) { listeners[0].call(server, client); return; }
    client.pause(); held.add(client); client.once('close', () => held.delete(client));
    client.on('error', () => client.destroy());
  }
  server.off('connection', listeners[0]); server.on('connection', accept);
  function restoreInput() {
    for (const pair of pairs.values()) {
      if (pair.client.destroyed) continue;
      if (pair.switched) {
        pair.staged?.release(); pair.upstream.pipe(pair.client);
        pair.upstream.on('error', () => pair.client.destroy());
        pair.upstream.on('close', () => pair.client.destroy());
        pair.original.destroy(); pair.original = pair.upstream;
        pair.staged = null; pair.switched = false;
      } else {
        pair.upstream.removeAllListeners('error'); pair.upstream.removeAllListeners('close');
        for (const [event, listener] of pair.listeners || []) pair.upstream.on(event, listener);
      }
      pair.client.pipe(pair.upstream); pair.client.resume(); pair.upstream.resume();
    }
    frozen = false;
    for (const client of held) if (!client.destroyed) listeners[0].call(server, client);
    held.clear();
  }
  async function command(method, data) {
    if (method === 'status') { capture(); return { protocol: 3, frozen, pairs: [...pairs.values()].map(p => ({ id: p.id, backendPort: p.upstream.remotePort, port: p.upstream.localPort, host: p.upstream.remoteAddress })) }; }
    if (method === 'freeze') {
      if (frozen) throw Error('A transfer already owns the proxy');
      capture(); frozen = true;
      for (const p of pairs.values()) {
        p.client.pause(); p.client.unpipe(p.upstream);
        p.listeners = ['close', 'error'].flatMap(event => p.upstream.listeners(event).map(listener => [event, listener]));
        p.upstream.removeAllListeners('error'); p.upstream.removeAllListeners('close');
        p.upstream.on('error', () => {});
      }
      return command('status', {});
    }
    if (method === 'stage') {
      if (!frozen) throw Error('Proxy must be frozen first');
      const p = pairs.get(data.linkId) || [...pairs.values()].find(p => p.upstream.localPort === data.route.port && p.upstream.remotePort === data.route.backendPort && p.upstream.remoteAddress === data.route.host);
      if (!p || p.client.destroyed || p.upstream.destroyed || p.staged) throw Error('Original client connection unavailable');
      const staged = await connect(`${directory}/gateway-${data.target}.sock`);
      try {
        staged.send({ auth: data.auth, transaction: data.transaction, session: { ...data.session, linkId: p.id } });
        const response = await staged.read();
        if (!response.ok) throw Error(response.error || 'Session rejected');
        staged.release();
        p.staged = staged;
        return { sourceId: data.session.id, linkId: p.id };
      } catch (error) { staged.socket.destroy(); throw error; }
    }
    if (method === 'switch') {
      for (const p of pairs.values()) if (p.staged) {
        p.original.unpipe(p.client); p.original.pause();
        p.upstream = p.staged.socket; p.switched = true;
      }
      return { switched: [...pairs.values()].filter(p => p.switched).length };
    }
    if (method === 'resume') { restoreInput(); return { ready: true }; }
    if (method === 'rollback') {
      for (const p of pairs.values()) {
        p.staged?.socket.destroy(); p.staged = null;
        if (p.switched) { p.upstream = p.original; p.upstream.pipe(p.client); p.switched = false; }
      }
      restoreInput(); return { ready: true };
    }
    throw Error('Unknown proxy operation');
  }
  async function poll() {
    if (controller && !controller.socket.destroyed || attempt) return;
    let request;
    try { request = JSON.parse(fs.readFileSync(`${directory}/proxy-request.json`, 'utf8')); } catch { return; }
    if (!/^[a-f0-9-]{36}$/.test(request.id) || Date.now() - request.created > 120_000) return;
    attempt = true;
    try {
      const peer = await connect(`${directory}/rollout-${request.id}.sock`);
      controller = peer; peer.send({ nonce: request.nonce, protocol: 3 });
      void (async () => {
        try {
          while (!peer.socket.destroyed) {
            const msg = await peer.read(120_000);
            try { peer.send({ ok: true, result: await command(msg.method, msg.data || {}) }); }
            catch (error) { peer.send({ ok: false, error: error.message }); }
          }
        } catch {
          // Ownership is unknown after a control-channel loss. Keep both live
          // backends and the paused fronts available for transaction recovery.
          peer.socket.destroy();
        }
      })();
    } catch {} finally { attempt = false; }
  }
  const timer = setInterval(() => void poll(), 100); timer.unref();
  globalThis[key] = { command };
  return { ready: true, protocol: 3 };
}
