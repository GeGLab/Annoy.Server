import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";

test('SIGTERM in the real server ends private calls before closing gateways and exits cleanly', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'annoy-shutdown-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env: { ...process.env, ANNOY_DATA_DIR: directory, ANNOY_GLOBAL: 'off', ANNOY_HOST: '127.0.0.1', ANNOY_PORT: '0', ANNOY_REGISTRATION: 'open', ANNOY_VOICE_BACKEND: 'cloudflare', ANNOY_CF_SFU_APP_ID: 'test', ANNOY_CF_SFU_APP_TOKEN: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  const sockets: WebSocket[] = [];
  let errors = '';
  child.stderr.on('data', chunk => { errors += String(chunk); });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 5_000);
      let output = '';
      child.stdout.on('data', chunk => {
        output += String(chunk);
        const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited at startup: ${code}, ${errors}`)); });
    });
    const api = async (path: string, body: unknown, token?: string, method = 'POST') => {
      const res = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
      const data = await res.json() as any;
      assert.equal(res.status, 200, JSON.stringify(data));
      return data;
    };
    const a = await api('/auth/register', { username: 'alice', password: 'synthetic-password' });
    const b = await api('/auth/register', { username: 'bob', password: 'synthetic-password' });
    await api('/relationships', { username: 'bob' }, a.token);
    await api(`/relationships/${a.user.id}`, {}, b.token, 'PUT');
    const connect = async (auth: any, deviceId: string) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/gateway`); sockets.push(ws);
      const events: any[] = [];
      ws.on('message', raw => events.push(JSON.parse(String(raw))));
      await once(ws, 'open');
      ws.send(JSON.stringify({ op: 'identify', token: auth.token, deviceId, features: ['directCalls'] }));
      while (!events.some(event => event.t === 'READY')) await once(ws, 'message');
      return { ws, events };
    };
    const ca = await connect(a, 'a'), cb = await connect(b, 'b');
    const call = await api('/calls', { userId: b.user.id, video: true, deviceId: 'a' }, a.token);
    cb.ws.send(JSON.stringify({ op: 'call', callId: call.id, action: 'accept', deviceId: 'b' }));
    while (!ca.events.some(e => e.t === 'CALL_UPDATE' && e.d.status === 'active')) await once(ca.ws, 'message');
    const closed = Promise.all(sockets.map(socket => once(socket, 'close')));
    child.kill('SIGTERM');
    const codes = await closed;
    assert.ok(codes.every(([code]) => code === 4010));
    assert.ok(ca.events.some(e => e.t === 'CALL_UPDATE' && e.d.id === call.id && e.d.status === 'ended'));
    assert.ok(cb.events.some(e => e.t === 'CALL_UPDATE' && e.d.id === call.id && e.d.status === 'ended'));
    const [code, signal] = await exit;
    assert.equal(code, 0, errors); assert.equal(signal, null);
  } finally {
    for (const socket of sockets) socket.terminate();
    if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
    await rm(directory, { recursive: true, force: true });
  }
});
