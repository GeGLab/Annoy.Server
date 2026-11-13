// Compatibility bootstrap for the exact alpha.2/global runtime. Loaded once
// inside that process after isolated verification. No gateway is closed here.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import openBus from './bus.cjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const singleton = Symbol.for('annoy.legacy.handoff');
export async function install({ slot, target, attempt: suppliedAttempt }) {
  if (!['annoy', 'annoy-b'].includes(slot) || !['annoy', 'annoy-b'].includes(target) || slot === target) throw Error('Invalid slots');
  if (globalThis[singleton]) return globalThis[singleton].status();
  const attemptKey=Symbol.for('annoy.handoff.attempt'),preparingKey=Symbol.for('annoy.handoff.preparing');
  const generation=suppliedAttempt||randomUUID();
  if(globalThis[preparingKey])throw Error('Another preparation is still in progress');
  if(!suppliedAttempt)globalThis[attemptKey]=generation;
  const checkAttempt=()=>{if(globalThis[attemptKey]!==generation)throw Error('Preparation cancelled');};
  checkAttempt();globalThis[preparingKey]=generation;
  const cleanups=[];
  try {
  const base = process.cwd();
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  const version=manifest.version;
  if ((version !== '0.12.0-alpha.2' && manifest.annoyHandoff !== 1) || (process.env.ANNOY_ACCOUNT_MODE || 'global') !== 'global') throw Error('Unsupported gateway compatibility runtime');
  const directory = process.env.ANNOY_CONTROL_DIR;
  if (!directory) throw Error('Shared control directory required');
  const data = process.env.ANNOY_DATA_DIR || '/data';
  const token = fs.readFileSync(path.join(data, 'admin.token'), 'utf8').trim();
  const require = createRequire(path.join(base, 'package.json'));
  const proxyaddr = require('@fastify/proxy-addr');
  const { config } = await import(pathToFileURL(path.join(base, 'src/config.ts')).href);
  const events = await import(pathToFileURL(path.join(base, 'src/events.ts')).href);
  const database = await import(pathToFileURL(path.join(base, 'src/db.ts')).href);
  const voice = await import(pathToFileURL(path.join(base, 'src/voice-backend.ts')).href);
  const accounts = await import(pathToFileURL(path.join(base, 'src/accounts.ts')).href);
  const presence = await import(pathToFileURL(path.join(base, 'src/presence.ts')).href);
  const playback = await import(pathToFileURL(path.join(base, 'src/playback.ts')).href);
  const port = Number(process.env.ANNOY_PORT || 8787);
  const servers = process._getActiveHandles().filter(h => h instanceof http.Server && h.listening && h.address()?.port === port);
  if (servers.length !== 1) throw Error('Cannot identify the original HTTP server safely');
  const server = servers[0], originals = server.listeners('request');
  if (originals.length !== 1) throw Error('Unexpected HTTP request listeners');
  const sockets = () => process._getActiveHandles().filter(h => h instanceof net.Socket && h.localPort === port).flatMap(s => {
    const key = Object.getOwnPropertySymbols(s).find(k => k.description === 'websocket');
    const ws = key && s[key]; return ws && ws.readyState !== 3 ? [ws] : [];
  });
  const connections = new Set();
  for (const row of database.all('SELECT id FROM users')) for (const connection of events.connectionsOf(row.id)) connections.add(connection);
  const originalSend = events.Connection.prototype.send;
  function capture(event) { connections.add(this); return originalSend.call(this, event); }
  checkAttempt();
  events.Connection.prototype.send = capture;
  cleanups.push(()=>{if(events.Connection.prototype.send===capture)events.Connection.prototype.send=originalSend;});
  // Verify TSX resolved the existing module instance, not a duplicate empty map.
  for (let retry = 0; retry < 20; retry++) {
    checkAttempt();
    if (sockets().every(ws => [...connections].some(c => c.socket === ws))) break;
    if (retry === 19) { events.Connection.prototype.send = originalSend; throw Error('Existing gateway namespace could not be verified'); }
    await new Promise(r => setTimeout(r, 500));
  }
  // A background Git/import task must finish before HTTP ownership changes.
  if (process._getActiveHandles().some(h => h.spawnfile && /(?:^|[/\\])git(?:\.exe)?$/.test(h.spawnfile))) { events.Connection.prototype.send = originalSend; throw Error('Wait for the existing Git operation to finish'); }
  const imports = await import(pathToFileURL(path.join(base, 'src/discord/import.ts')).href);
  if (database.all('SELECT id FROM users').some(u => imports.jobsFor(u.id).some(j => j.phase === 'structure'))) { events.Connection.prototype.send = originalSend; throw Error('Wait for the existing Discord import to finish'); }

  const bus = openBus(path.join(directory, 'handoff.sqlite'));
  cleanups.push(()=>bus.close());
  bus.prepare("UPDATE commands SET status='failed' WHERE status='pending' AND generation!=?").run(generation);
  let cursor = Number(bus.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get().id);
  const descriptor = path.join(directory, 'legacy.json');
  const socketPath = path.join(directory, `legacy-${slot}.sock`);
  const targetPath = path.join(directory, `api-${target}.sock`);
  const trust = proxyaddr.compile(config.trustedProxies || []);
  let forwarded = false, busy = false, closed = false, timer, lastSnapshot = 0;
  const pendingRequests = new Set();
  cleanups.push(()=>{closed=true;clearInterval(timer);});
  const tunnel = net.createServer(client => {
    const upstream = net.connect({ host: '127.0.0.1', port });
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  tunnel.on('error',()=>{});
  cleanups.push(()=>{try{tunnel.close();}catch{}try{fs.unlinkSync(socketPath);}catch{}});
  try { fs.unlinkSync(socketPath); } catch {}
  await new Promise((resolve, reject) => { tunnel.once('error', reject); tunnel.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); resolve(); }); });
  checkAttempt();
  cleanups.push(()=>{try{if(JSON.parse(fs.readFileSync(descriptor,'utf8')).generation===generation)fs.unlinkSync(descriptor);}catch{}});
  function currentConnections() {
    for (const c of connections) if (c.socket.readyState === 3) connections.delete(c);
    return [...connections].filter(c => c.userId && c.socket.readyState !== 3);
  }
  function status() {
    const live = currentConnections(), voiceStates = {};
    for (const row of database.all('SELECT id FROM servers')) voiceStates[row.id] = voice.voiceStatesFor(row.id);
    let externalConnections = 0;
    for(const filename of ['/proc/net/tcp','/proc/net/tcp6'])for(const line of fs.readFileSync(filename,'utf8').trim().split('\n').slice(1)){const f=line.trim().split(/\s+/);if(f[3]==='01'&&parseInt(f[1].split(':').at(-1),16)===port&&!/^(0100007F|00000000000000000000000001000000|0000000000000000FFFF00000100007F):/.test(f[2]))externalConnections++;}
    return { version, slot, target, generation, bundle:path.dirname(fileURLToPath(import.meta.url)), lastEventId:cursor, pid: process.pid, enabled: !closed, heartbeat: new Date().toISOString(), gatewayConnections: sockets().length, externalConnections,
      externalGateways: live.filter(c => !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(c.socket._socket?.remoteAddress)).length,
      connectionCounts: Object.fromEntries([...new Set(live.map(c => c.userId))].map(id => [id, live.filter(c => c.userId === id).length])), presences:Object.fromEntries([...new Set(live.map(c=>c.userId))].map(id=>[id,presence.presenceOf(id)])), voiceStates, forwarded, pendingRequests: pendingRequests.size };
  }
  function saveStatus() { if (closed) return; fs.writeFileSync(descriptor + '.tmp', JSON.stringify(status()), { mode: 0o600 }); fs.renameSync(descriptor + '.tmp', descriptor); }
  function forward(req, res) {
    const headers = { ...req.headers };
    for (const key of Object.keys(headers)) if (key.startsWith('x-annoy-handoff-')) delete headers[key];
    const remote = req.socket.remoteAddress || '';
    const trusted = trust(remote, 0);
    const proto = trusted ? String(req.headers['x-forwarded-proto'] || '').split(',').at(-1).trim() : '';
    headers['x-annoy-handoff-auth'] = token;
    headers['x-annoy-handoff-remote'] = remote;
    headers['x-annoy-handoff-ip'] = proxyaddr(req, trust);
    headers['x-annoy-handoff-host'] = trusted && req.headers['x-forwarded-host'] ? String(req.headers['x-forwarded-host']).split(',').at(-1).trim() : String(req.headers.host || 'localhost');
    headers['x-annoy-handoff-secure'] = req.socket.encrypted || proto === 'https' ? 'yes' : 'no';
    delete headers.connection; delete headers['proxy-connection'];
    const upstream = http.request({ socketPath: targetPath, method: req.method, path: req.url, headers, agent: false }, response => {
      const outgoing = { ...response.headers, connection: 'close' };
      res.writeHead(response.statusCode || 502, outgoing); response.pipe(res);
    });
    pendingRequests.add(res);
    res.once('close', () => { pendingRequests.delete(res); upstream.destroy(); });
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"handoff_unavailable","message":"A API está temporariamente indisponível."}'); } else res.destroy(); });
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  }
  async function activate(expires) {
    if (forwarded) return;
    // Check the new API through the private path before touching old listeners.
    const response = await new Promise((resolve, reject) => {
      const request = http.get({ socketPath: targetPath, path: '/api/info', headers: { host: 'localhost' }, timeout: 3000 }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      request.on('timeout', () => request.destroy(Error('timeout'))); request.on('error', reject);
    });
    if (response !== 200) throw Error('New private API is not healthy');
    const deadline=Date.now()+30_000;
    while(process._getActiveHandles().some(s=>s instanceof net.Socket&&s.localPort===port&&s._httpMessage&&!s._httpMessage.writableEnded&&!Object.getOwnPropertySymbols(s).some(k=>k.description==='websocket'&&s[k]))){
      if(Date.now()>deadline)throw Error('An original HTTP handler is still in flight');
      await new Promise(r=>setTimeout(r,20));
    }
    if(Date.now()>expires)throw Error('Activation request expired');
    server.removeListener('request', originals[0]); server.on('request', forward); forwarded = true;
    saveStatus();
  }
  function uninstall() {
    if (closed) return;
    if (forwarded) { server.removeListener('request', forward); server.on('request', originals[0]); }
    // Old playback cache must reload the database if a rollback restores HTTP.
    for (const row of database.all("SELECT id FROM channels WHERE type IN ('song','theater')")) playback.forgetPlayback(row.id);
    if (events.Connection.prototype.send === capture) events.Connection.prototype.send = originalSend;
    closed = true; clearInterval(timer); tunnel.close();
    try { fs.unlinkSync(socketPath); } catch {}
    try { if (JSON.parse(fs.readFileSync(descriptor, 'utf8')).generation === generation) fs.unlinkSync(descriptor); } catch {}
    delete globalThis[singleton];
    setTimeout(()=>{try{bus.close();}catch{}},200).unref();
  }
  async function tick() {
    if (closed || busy) return; busy = true;
    try {
      for (const item of bus.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT 1000').all(cursor)) {
        const event = JSON.parse(item.event);
        if (event.t === 'SERVER_REFRESH') events.serverChanged(event.d.serverId);
        else for (const userId of JSON.parse(item.recipients)) events.sendToUser(userId, event);
        cursor = Number(item.id);
      }
      for (const item of bus.prepare("SELECT * FROM commands WHERE status='pending' AND generation=? ORDER BY created LIMIT 100").all(generation)) {
        try {
          if(Date.now()-item.created>35_000)throw Error('Command expired');
          const value = JSON.parse(item.data);
          if (item.action === 'mute') await voice.setServerMute(value.serverId, value.userId, value.muted === true);
          else if (item.action === 'disconnect-voice') voice.disconnectUser(value.serverId, value.userId);
          else if (item.action === 'revoke-user') accounts.disconnectEverywhere(value.userId, String(value.reason || 'Acesso revogado nesta instância'));
          else if (item.action === 'close-idle') server.closeIdleConnections();
          else if (item.action === 'snapshot') saveStatus();
          else if (item.action === 'retire-listener') {
            const current=status();
            if(current.gatewayConnections||current.externalConnections||pendingRequests.size||Object.values(current.voiceStates).some(v=>v.length))throw Error('Gateway is still in use');
            server.close();tunnel.close();
          }
          else if (item.action === 'activate') await activate(item.created+35_000);
          else if (item.action === 'rollback') uninstall();
          else throw Error('Unknown command');
          bus.prepare("UPDATE commands SET status='done',result='{}' WHERE id=?").run(item.id);
          if(closed)break;
        } catch { bus.prepare("UPDATE commands SET status='failed',result='{}' WHERE id=?").run(item.id); }
      }
      if(Date.now()-lastSnapshot>500){saveStatus();lastSnapshot=Date.now();}
    } catch { /* Retry on the next tick; never crash the legacy gateway. */ }
    finally { busy = false; }
  }
  checkAttempt();
  globalThis[singleton] = { generation,status,uninstall };
  timer = setInterval(() => void tick(), 50); timer.unref(); saveStatus();
  return status();
  } catch(error) {
    for(const cleanup of cleanups.reverse())try{cleanup();}catch{}
    if(globalThis[singleton]?.generation===generation)delete globalThis[singleton];
    throw error;
  } finally { if(globalThis[preparingKey]===generation)delete globalThis[preparingKey]; }
}
