import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from './config.ts';
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export function handoffContext(req: FastifyRequest): { remote: string; ip: string; host: string; secure: boolean } | null {
  if (!loopback.has(req.socket.remoteAddress ?? '')) return null;
  const given = req.headers['x-annoy-handoff-auth'];
  if (typeof given !== 'string') return null;
  let expected: Buffer;
  try { expected = Buffer.from(readFileSync(`${config.dataDir}/admin.token`, 'utf8').trim()); } catch { return null; }
  const token = Buffer.from(given);
  if (expected.length < 32 || token.length !== expected.length || !timingSafeEqual(token, expected)) return null;
  const remote = req.headers['x-annoy-handoff-remote'], ip = req.headers['x-annoy-handoff-ip'];
  if (typeof remote !== 'string' || typeof ip !== 'string' || remote.length > 100 || ip.length > 100) return null;
  const host=req.headers['x-annoy-handoff-host'];
  if(typeof host!=='string'||!host||host.length>1024)return null;
  return { remote, ip, host, secure: req.headers['x-annoy-handoff-secure'] === 'yes' };
}
