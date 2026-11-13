import { readFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { WebSocket } from 'ws';
import type { DatabaseSync } from 'node:sqlite';
import type { GatewayEvent, VoiceState, Presence } from '@annoy/protocol';
import { config } from './config.ts';
import { compareVersions, isVersion } from './version.ts';

interface LegacyState { enabled: boolean; generation: string; lastEventId: number; heartbeat: string; version: string; slot: string; target: string; gatewayConnections: number; externalGateways: number; externalConnections: number; connectionCounts: Record<string, number>; presences: Record<string, Presence>; voiceStates: Record<string, VoiceState[]>; forwarded: boolean }
const directory = config.updateControlDir, slot = process.env.ANNOY_SLOT;
const require = createRequire(import.meta.url);
let bus: DatabaseSync | undefined, localGateways = false;
let retirement: Promise<void> | undefined;
const recipients = new Map<GatewayEvent, Set<string>>();
let flushScheduled = false;
const snapshotHooks: ((serverId: string) => void)[] = [];
let previousSnapshot = '';
export function legacyState(): LegacyState | null {
  if (!directory || !slot) return null;
  try {
    const state = JSON.parse(readFileSync(join(directory, 'legacy.json'), 'utf8')) as LegacyState;
    return state.enabled && state.target === slot && ['annoy', 'annoy-b'].includes(state.slot) ? state : null;
  } catch { return null; }
}
export const usesLegacyGateway = () => !localGateways && legacyState() !== null;
export const legacyConnections = (userId: string) => usesLegacyGateway() ? legacyState()?.connectionCounts[userId] ?? 0 : 0;
export const legacyVoiceStates = (serverId: string) => usesLegacyGateway() ? legacyState()?.voiceStates[serverId] ?? [] : null;
export const legacyPresence = (userId: string) => usesLegacyGateway() ? legacyState()?.presences[userId] : undefined;
export const gatewayRetirement = () => retirement;
export function isLegacySource(): boolean { try { const value=JSON.parse(readFileSync(join(directory,'legacy.json'),'utf8'));return value.enabled&&value.forwarded&&value.slot===slot; }catch{return false;} }
export const onLegacyVoiceChanged = (hook: (serverId: string) => void) => snapshotHooks.push(hook);
function openBus(): DatabaseSync | undefined {
  if (!directory || !slot) return;
  if (!bus) bus = require('../scripts/handoff/bus.cjs')(join(directory, 'handoff.sqlite')) as DatabaseSync;
  return bus;
}
function flush(): void {
  flushScheduled = false;
  let database:DatabaseSync|undefined;
  try{database=openBus();}catch{flushScheduled=true;setTimeout(flush,250).unref();return;}
  if(!database)return;
  for (const [event, users] of recipients) {
    try { database.prepare('INSERT INTO events(origin,recipients,event,created) VALUES(?,?,?,?)').run(slot!, JSON.stringify([...users]), JSON.stringify(event), Date.now()); recipients.delete(event); }
    catch { if (!flushScheduled) { flushScheduled = true; setTimeout(flush, 50).unref(); } break; }
  }
}
export function publishLegacyEvent(userId: string, event: GatewayEvent): void {
  if (!usesLegacyGateway()) return;
  let users = recipients.get(event); if (!users) recipients.set(event, users = new Set()); users.add(userId);
  if (!flushScheduled) { flushScheduled = true; queueMicrotask(flush); }
}
export async function legacyCommand(action: string, data: Record<string, unknown>): Promise<void> {
  const state = legacyState(), database = openBus(); if (!state || !database) return;
  const id = randomUUID();
  database.prepare('INSERT INTO commands(id,action,data,created,generation) VALUES(?,?,?,?,?)').run(id, action, JSON.stringify(data), Date.now(),state.generation);
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const row = database.prepare('SELECT status FROM commands WHERE id=?').get(id) as { status: string };
    if (row.status === 'done') return;
    if (row.status === 'failed') throw Error('O gateway anterior não concluiu a operação');
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error('O gateway anterior não confirmou a operação');
}
const proxies = new Set<WebSocket>();

export function proxyLegacyGateway(front: WebSocket): void {
  const state = legacyState();
  if (!state) { front.close(1013, 'gateway unavailable'); return; }
  const upstream = new WebSocket('ws://localhost:8787/gateway', {
    createConnection: () => connect({ path: join(directory, `legacy-${state.slot}.sock`) }), handshakeTimeout: 5000,
  });
  proxies.add(front);
  const waiting: { value: Buffer; binary: boolean }[] = [];
  front.on('message', (data, binary) => {
    const value = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (!binary) try {
      const message = JSON.parse(value.toString());
      if (message.op === 'identify' && (!isVersion(message.clientVersion) || compareVersions(message.clientVersion, config.minClientVersion) < 0)) {
        front.send(JSON.stringify({ t: 'INVALID_SESSION', d: { reason: `Atualize o cliente para ${config.minClientVersion} ou superior.` } })); front.close(4011, 'client outdated'); return;
      }
    } catch {}
    if (upstream.readyState === WebSocket.OPEN) upstream.send(value, { binary });
    else if(waiting.length<32)waiting.push({ value, binary });
    else front.close(4008,'gateway queue limit');
  });
  upstream.on('open', () => { for (const item of waiting.splice(0)) upstream.send(item.value, { binary: item.binary }); });
  upstream.on('message', (data, binary) => { if (front.readyState === WebSocket.OPEN) front.send(data, { binary }); });
  upstream.on('error', () => { if (front.readyState === WebSocket.OPEN) front.close(1013, 'legacy gateway unavailable'); });
  upstream.on('close', (code, reason) => { if (front.readyState === WebSocket.OPEN) front.close(code === 1005 || code === 1006 ? 1011 : code, reason); });
  front.on('close', () => { proxies.delete(front); upstream.close(); });
  front.on('error', () => upstream.close());
}

/** Stop assigning new frontends to legacy before allowing its retirement. */
export async function prepareLegacyRetirement(): Promise<boolean> {
  const state = legacyState();
  if (!state) return false;
  if(retirement)return false;
  try{if(readFileSync(join(directory,'active'),'utf8').trim()!==slot)return false;}catch{return false;}
  if (state.gatewayConnections || state.externalConnections || proxies.size || Object.values(state.voiceStates).some(v => v.length) || Date.now() - Date.parse(state.heartbeat) > 2000) return false;
  let finish!:()=>void;
  retirement=new Promise<void>(resolve=>{finish=resolve;});
  try{await legacyCommand('retire-listener',{});localGateways=true;return true;}
  catch{return false;}
  finally{finish();retirement=undefined;}
}

export async function startApiTunnel(port: number): Promise<void> {
  if (!directory || !slot) return;
  const filename = join(directory, `api-${slot}.sock`); if (existsSync(filename)) unlinkSync(filename);
  const server = createServer(client => {
    const upstream = connect({ host: '127.0.0.1', port });
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy()); client.pipe(upstream).pipe(client);
  });
  server.on('error',()=>{});
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(filename, () => { chmodSync(filename, 0o600); resolve(); }); });
  const timer = setInterval(() => {
    try {
    const state = legacyState(); if (!state) return;
    const serialized = JSON.stringify(state.voiceStates);
    if (serialized !== previousSnapshot) { previousSnapshot = serialized; for (const serverId of Object.keys(state.voiceStates)) for (const hook of snapshotHooks) hook(serverId); }
    const database = bus;
    if (database && Date.now() % 10_000 < 500) {
      database.prepare('DELETE FROM events WHERE id<=? AND created<?').run(state.lastEventId||0,Date.now() - 60_000);
      database.prepare("DELETE FROM commands WHERE status!='pending' AND created<?").run(Date.now() - 60_000);
    }
    }catch{/* A failed control channel must not crash the API process. */}
  }, 500); timer.unref();
}
