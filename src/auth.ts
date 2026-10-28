import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import { now, one, run } from "./db.ts";
import { unauthorized } from "./errors.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createSession(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  run("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)", hashToken(token), userId, now());
  return token;
}

export function deleteSession(token: string): void {
  run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}

export function userIdForToken(token: string): string | null {
  const row = one<{ user_id: string }>("SELECT user_id FROM sessions WHERE token_hash = ?", hashToken(token));
  return row?.user_id ?? null;
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

/** Resolves the authenticated user id or throws 401. */
export function requireUser(req: FastifyRequest): string {
  const token = bearerToken(req);
  const userId = token ? userIdForToken(token) : null;
  if (!userId) throw unauthorized();
  return userId;
}
