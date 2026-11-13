import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { channel, call } from './wire.mjs';

export async function move(source, target, { relaySlot, directory = process.env.ANNOY_CONTROL_DIR || '/control', tokenFile = '/data/admin.token' } = {}) {
  if (!['annoy', 'annoy-b'].includes(source) || !['annoy', 'annoy-b'].includes(target) || source === target) throw Error('Invalid migration slots');
  const auth = fs.readFileSync(tokenFile, 'utf8').trim();
  const request = `${directory}/proxy-request.json`, manifest = `${directory}/migration.json`;
  const existing = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null;
  const recovering = existing && !['done', 'rolled_back'].includes(existing.phase);
  if (recovering && (existing.source !== source || existing.target !== target)) throw Error('Recover the recorded source and target before another transfer');
  const transaction = recovering ? existing.transaction : randomUUID(), nonce = randomUUID(), filename = `${directory}/rollout-${transaction}.sock`;
  let peer, server, frozen = false, activated = false, sessions;
  const sessionCall = (slot, method, data = {}) => call(`${directory}/sessions-${slot}.sock`, auth, method, data, frozen ? 1200 : 30_000);
  const proxyCall = async (method, data = {}) => {
    peer.send({ method, data }); const response = await peer.read(frozen ? 1200 : 8000);
    if (!response.ok) throw Error(response.error || 'Proxy operation failed');
    return response.result;
  };
  const save = phase => {
    fs.writeFileSync(manifest + '.tmp', JSON.stringify({ protocol: 3, transaction, source, target, phase, ids: sessions?.map(s => s.id) || existing?.ids, connections: sessions?.length ?? existing?.connections, voices: sessions?.filter(s => s.peer).length ?? existing?.voices, at: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(manifest + '.tmp', manifest);
  };
  try {
    // Complete already-started voice RPCs before pausing any public input.
    const deadline = Date.now() + 25_000;
    while (!recovering) {
      const status = await sessionCall(source, 'status');
      if (status.ready && !status.pendingVoice) break;
      if (Date.now() > deadline) throw Error('Active voice RPCs have not settled; serving processes preserved');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Live proxy controller unavailable')), 8000);
      server = net.createServer(socket => {
        const candidate = channel(socket);
        void candidate.read().then(hello => {
          if (hello.nonce !== nonce || hello.protocol !== 3 || peer) { socket.destroy(); return; }
          peer = candidate; clearTimeout(timer); resolve();
        }).catch(() => socket.destroy());
      });
      server.on('error', reject);
      if (recovering) { try { fs.unlinkSync(filename); } catch {} }
      server.listen(filename, () => {
        fs.chmodSync(filename, 0o600);
        fs.writeFileSync(request + '.tmp', JSON.stringify({ id: transaction, nonce, created: Date.now() }), { mode: 0o600 });
        fs.renameSync(request + '.tmp', request);
      });
    });
    await connected;
    let imported;
    if (recovering) {
      const status = await sessionCall(target, 'status');
      activated = status.transfers.some(([id, phase]) => id === transaction && ['active', 'released'].includes(phase));
      if (!activated) {
        await sessionCall(target, 'abort', { transaction });
        await sessionCall(source, 'resume');
        await proxyCall('rollback'); save('rolled_back');
        return { recovered: true, rolledBack: true, source, target };
      }
      imported = { connections: existing.connections, voices: existing.voices };
      frozen = true;
    } else {
      save('preparing');
      await proxyCall('freeze'); frozen = true;
    // Incoming client bytes are held in the proxy. Probe legacy API relays
    // internally to associate their outer socket with the original session.
    const relays = relaySlot ? await sessionCall(relaySlot, 'routes') : [];
    await new Promise(resolve => setTimeout(resolve, 40));
    sessions = await sessionCall(source, 'freeze');
    const finalRelays = relaySlot ? await sessionCall(relaySlot, 'routes', { probe: false }) : [];
    for (const session of sessions) {
      const relay = relays.find(row => row.nonce === session.nonce);
      const original = relay?.route;
      const finalRoute = original && finalRelays.find(row => row.route.port === original.port && row.route.backendPort === original.backendPort && row.route.host === original.host)?.route;
      await proxyCall('stage', { target, auth, transaction, session, linkId: session.linkId, route: finalRoute || session.route });
    }
    save('prepared');
    await proxyCall('switch');
      imported = await sessionCall(target, 'activate', { transaction, count: sessions.length });
      activated = true; save('target_owns_sessions');
    }
    const events = await sessionCall(source, 'drop', { transaction, ids: sessions?.map(s => s.id) || existing.ids });
    await sessionCall(target, 'deliver', { transaction, events });
    // Route both new connections and the preserved old transports to target.
    fs.writeFileSync(`${directory}/active.tmp`, target + '\n'); fs.renameSync(`${directory}/active.tmp`, `${directory}/active`);
    // The preserved TCP proxy polls the route every 500 ms. Held accepts must
    // see the new route before they are allowed to establish a backend.
    await new Promise(resolve => setTimeout(resolve, 750));
    await sessionCall(target, 'release', { transaction });
    await proxyCall('resume'); frozen = false;
    const status = await sessionCall(target, 'status');
    if (status.connections < imported.connections || status.voices < imported.voices) throw Error('Destination ownership does not match the transferred sessions');
    save('done');
    return { connections: imported.connections, voices: imported.voices, source, target, protocol: 3 };
  } catch (error) {
    if (!activated) {
      // An RPC reply may be lost after the synchronous ownership commit.
      const status = await sessionCall(target, 'status').catch(() => null);
      activated = status?.transfers?.some(([id, phase]) => id === transaction && phase === 'active');
    }
    if (!activated) {
      let rollback = true;
      await sessionCall(target, 'abort', { transaction }).catch(() => { rollback = false; });
      await sessionCall(source, 'resume').catch(() => { rollback = false; });
      if (frozen && peer && !peer.socket.destroyed) await proxyCall('rollback').catch(() => { rollback = false; });
      else if (frozen) rollback = false;
      save(rollback ? 'rolled_back' : 'recovery_required');
    } else save('recovery_required');
    throw error;
  } finally {
    peer?.socket.destroy(); server?.close();
    try { fs.unlinkSync(filename); } catch {}
    try { if (JSON.parse(fs.readFileSync(request, 'utf8')).id === transaction) fs.unlinkSync(request); } catch {}
  }
}

if (process.argv[1]?.endsWith('/move.mjs')) {
  const execute = async () => {
    if (process.argv[2] === 'recover') {
      const file = `${process.env.ANNOY_CONTROL_DIR || '/control'}/migration.json`;
      if (!fs.existsSync(file)) return { recovered: false };
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (['done', 'rolled_back'].includes(state.phase)) return { recovered: false };
      return move(state.source, state.target);
    }
    return move(process.argv[2], process.argv[3], { relaySlot: process.argv[4] });
  };
  execute().then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}
