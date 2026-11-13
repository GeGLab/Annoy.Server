import { argon2, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import {sessionChanged} from "./session-events.ts";
import { now, one, run, all } from "./db.ts";
import { requireAccountMode } from "./account-policy.ts";
import { config } from "./config.ts";
import { hostActor } from "./host-context.ts";
import { HttpError, unauthorized } from "./errors.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const argon = promisify(argon2);
const ARGON = { memory: 65536, passes: 3, parallelism: 1, tagLength: 32 };
let active = 0;
const waiting: Array<() => void> = [];
async function passwordSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) {
    if (waiting.length >= 8) throw new HttpError(429, "auth_busy", "Tente novamente mais tarde");
    await new Promise<void>(resolve => waiting.push(resolve));
  } else active++;
  try { return await work(); }
  finally { const next = waiting.shift(); if (next) next(); else active--; }
}
export const SESSION_TTL_MS = 24 * 60 * 60_000;
// Sessions last until sign-out or revocation, as before the E2EE work. The
// 5-minute "bootstrap" lifetime waited for a device-bind that 0.10 removed
// (TODO item 3); keeping it signed everyone out after five minutes.
const SESSION_LIFETIME_MS = 10 * 365 * 24 * 60 * 60_000;

export async function hashPassword(password: string): Promise<string> {
  if (password.length > 256) throw new HttpError(400, "invalid_password", "Senha muito longa");
  return passwordSlot(async () => {
    const salt = randomBytes(16);
    const key = await argon("argon2id", { message: password, nonce: salt, ...ARGON });
    try { return `$argon2id$v=19$m=65536,t=3,p=1$${salt.toString("base64")}$${key.toString("base64")}`; }
    finally { key.fill(0); }
  });
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > 256) return false;
  const m = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=)$/.exec(stored);
  const legacy = /^scrypt\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{86}==)$/.exec(stored);
  if (!m && !legacy) return false;
  return passwordSlot(async () => {
    const parts = m ?? legacy!;
    const expected = Buffer.from(parts[2]!, "base64");
    const salt = Buffer.from(parts[1]!, "base64");
    const actual = m ? await argon("argon2id", { message: password, nonce: salt, ...ARGON })
      : await scrypt(password, salt, 64);
    try { return timingSafeEqual(actual, expected); }
    finally { actual.fill(0); expected.fill(0); }
  });
}

// Fixed public dummy hash: unknown users still incur the same Argon2 cost.
const DUMMY = "$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
export const spendPasswordTime = (password: string) => verifyPassword(password, DUMMY);

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createSession(userId: string): string {
  requireAccountMode(config.accountMode);
  const token = randomBytes(32).toString("base64url");
  run("INSERT INTO sessions (token_hash, user_id, created_at, account_mode, expires_at) VALUES (?, ?, ?, ?, ?)", hashToken(token), userId, now(), config.accountMode, new Date(Date.now() + SESSION_LIFETIME_MS).toISOString());
  return token;
}

export function deleteSession(token: string): void {
  const hash=hashToken(token);run("DELETE FROM sessions WHERE token_hash = ?", hash);sessionChanged(hash,"revoked");
}

/** Sessions of suspended accounts are rejected even if a ban raced a request. */
export function userIdForToken(token: string): string | null {
  return userIdForSessionHash(hashToken(token));
}

export function userIdForSessionHash(tokenHash: string): string | null {
  const row = one<{ user_id: string }>(
    "SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.banned_at IS NULL AND s.expires_at > ? AND s.account_mode = ? AND ((? = 'global' AND u.global_id IS NOT NULL) OR (? = 'local' AND u.global_id IS NULL))",
    tokenHash, now(), config.accountMode, config.accountMode, config.accountMode,
  );
  return row?.user_id ?? null;
}

export function deleteSessionsOf(userId: string): void {
  const sessions=all<{token_hash:string}>("SELECT token_hash FROM sessions WHERE user_id=?",userId);
  run("DELETE FROM sessions WHERE user_id = ?", userId);
  for(const session of sessions)sessionChanged(session.token_hash,"revoked");
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  const match=header?.match(/^Bearer (.+)$/);
  return match?.[1]?.trim() || null;
}

/** Resolves the authenticated user id or throws 401. */
export function requireUser(req: FastifyRequest): string {
  const actor = hostActor.getStore();
  if (actor) return actor;
  const token = bearerToken(req);
  const userId = token ? userIdForToken(token) : null;
  if (!userId) throw unauthorized();
  return userId;
}
