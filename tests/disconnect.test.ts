import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { WebSocket } from "ws";

const directory = await mkdtemp(join(tmpdir(), "annoy-disconnect-"));
process.env.ANNOY_DATA_DIR = directory;
process.env.ANNOY_VOICE_BACKEND = "cloudflare";
process.env.ANNOY_CF_SFU_APP_ID = "test-app";
process.env.ANNOY_CF_SFU_APP_TOKEN = "test-token";
process.env.ANNOY_GLOBAL = "off";
const { db, run } = await import("../src/db.ts");
const { Connection, register, unregister } = await import("../src/events.ts");
const voice = await import("../src/voice-cloudflare.ts");
const { createSession } = await import("../src/auth.ts");
const { callRoutes, handleCall, endAllCalls } = await import("../src/calls.ts");
const { DEFAULT_EVERYONE_PERMISSIONS } = await import("@distopic/protocol");
for (const id of ["a", "b"]) {
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')", id, id, id);
}
run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Test','a','2026-01-01')");
run("INSERT INTO roles(id,server_id,name,permissions,position) VALUES('server','server','Members',?,0)", DEFAULT_EVERYONE_PERMISSIONS);
for (const id of ["a", "b"]) {
  run("INSERT INTO members(server_id,user_id,joined_at) VALUES('server',?,'2026-01-01')", id);
  run("INSERT INTO relationships(user_id,other_id,status) VALUES(?,?,'friend')", id, id === "a" ? "b" : "a");
}
run("INSERT INTO channels(id,server_id,type,name,created_at) VALUES('room','server','voice','Room','2026-01-01')");
const requests: { path: string; body: any }[] = [];
const originalFetch = globalThis.fetch;
let session = 0;
let deferPublish: (() => Promise<Response>) | null = null;
globalThis.fetch = (async (url, init) => {
  const path = new URL(String(url)).pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  requests.push({ path, body });
  if (path.endsWith('/sessions/new')) return Response.json({ sessionId: `session-${++session}` });
  if (path.endsWith('/tracks/new')) {
    if (deferPublish && body.tracks[0]?.location === 'local') return deferPublish();
    return Response.json({ tracks: [{ mid: body.tracks[0]?.mid ?? 'remote-mid' }], sessionDescription: { type: 'answer', sdp: 'v=0' } });
  }
  return Response.json({});
}) as typeof fetch;
function peer(id: string) {
  const events: any[] = [];
  const socket = { OPEN: 1, readyState: 1, send: (data: string) => events.push(JSON.parse(data)) };
  const conn = new Connection(socket as unknown as WebSocket);
  register(conn, id); conn.deviceId = id; conn.features.add('directCalls');
  return { conn, events };
}
const a = peer('a'), b = peer('b');
const app = Fastify(); callRoutes(app);
after(async () => {
  await voice.stopVoice(); endAllCalls();
  unregister(a.conn); unregister(b.conn);
  await app.close(); db.close(); globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
});

test('losing a gateway revokes both published and received Cloudflare tracks without a grace period', async () => {
  await voice.handleVoice(a.conn, 'join', { channelId: 'room' });
  await voice.handleVoice(b.conn, 'join', { channelId: 'room' });
  const published = await voice.handleVoice(a.conn, 'publish', { kind: 'audio', source: 'mic', mid: 'mic-mid', sdp: 'v=0' }) as { producerId: string };
  await voice.handleVoice(b.conn, 'subscribe', { producerId: published.producerId });
  const before = requests.length;
  voice.leaveVoice(a.conn);
  assert.equal(voice.voiceStatesFor('server').some(s => s.userId === 'a'), false);
  const closing = requests.slice(before).filter(r => r.path.endsWith('/tracks/close'));
  assert.ok(closing.some(r => r.body.force && r.body.tracks.some((t: any) => t.mid === 'mic-mid')));
  assert.ok(closing.some(r => r.body.force && r.body.tracks.some((t: any) => t.mid === 'remote-mid')));
  assert.ok(b.events.some(e => e.t === 'VOICE_PRODUCER_CLOSED' && e.d.producerId === published.producerId));
});

test('an old client cannot resume a previous media session', async () => {
  await assert.rejects(voice.handleVoice(a.conn, 'resume', { channelId: 'room', sessionId: 'previous-session', resumeToken: 'old-token' }), /encerrada/);
});

test('a publish finishing after disconnect is revoked instead of resurrecting a peer', async () => {
  await voice.handleVoice(a.conn, 'join', { channelId: 'room' });
  let finish!: (response: Response) => void;
  deferPublish = () => new Promise<Response>(resolve => { finish = resolve; });
  const pending = voice.handleVoice(a.conn, 'publish', { kind: 'video', source: 'screen', mid: 'late-mid', sdp: 'v=0' });
  voice.leaveVoice(a.conn);
  finish(Response.json({ tracks: [{ mid: 'late-mid' }] }));
  await assert.rejects(pending, /encerrada/);
  deferPublish = null;
  assert.ok(requests.some(r => r.path.endsWith('/tracks/close') && r.body.tracks.some((t: any) => t.mid === 'late-mid')));
  assert.equal(voice.voiceStatesFor('server').some(s => s.userId === 'a'), false);
});

test('shutdown ends active private calls and ignores persisted handoffs from older servers', async () => {
  const response = await app.inject({ method: 'POST', url: '/calls', headers: { authorization: `Bearer ${createSession('a')}` }, payload: { userId: 'b', video: true, deviceId: 'a' } });
  assert.equal(response.statusCode, 200, response.body);
  const call = response.json();
  handleCall(b.conn, { op: 'call', callId: call.id, action: 'accept', deviceId: 'b' });
  run("INSERT OR REPLACE INTO instance_settings(key,value) VALUES('handoff.calls',?)", JSON.stringify({ at: Date.now(), calls: [call] }));
  endAllCalls();
  assert.ok(a.events.some(e => e.t === 'CALL_UPDATE' && e.d.id === call.id && e.d.status === 'ended'));
  const count = b.events.length;
  handleCall(a.conn, { op: 'call', callId: call.id, action: 'signal', deviceId: 'a', signal: { description: { type: 'offer', sdp: 'v=0' } } });
  assert.equal(b.events.length, count);
});

test('shutdown revokes every remaining track and refuses further voice operations', async () => {
  await voice.handleVoice(b.conn, 'publish', { kind: 'audio', source: 'mic', mid: 'last-mid', sdp: 'v=0' });
  await voice.stopVoice();
  assert.deepEqual(voice.voiceStatesFor('server'), []);
  assert.ok(b.events.some(e => e.t === 'VOICE_KICKED'));
  assert.ok(requests.some(r => r.path.endsWith('/tracks/close') && r.body.tracks.some((t: any) => t.mid === 'last-mid')));
  await assert.rejects(voice.handleVoice(a.conn, 'join', { channelId: 'room' }), /encerrada/);
});
