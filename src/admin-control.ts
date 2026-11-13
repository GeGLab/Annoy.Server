// Access for the `annoy-admin` command (TODO item 5). The app never administers
// the annoy-server: settings are Compose flags, and the few actions that are not
// flags (sign-up invites, bans, deleting a server) run from inside the server's
// container. The command proves that with a random token kept in the data
// folder, readable only by the server's user, and must connect over loopback
// with no proxy in between.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { forbidden } from "./errors.ts";
import { handoffContext } from './handoff-context.ts';

export const ADMIN_TOKEN_HEADER = "x-annoy-admin-token";
export const adminTokenPath = () => join(config.dataDir, "admin.token");

/** Creates the token once; both Compose slots share the data folder and so the token. */
export function ensureAdminToken(): void {
  try {
    if (readFileSync(adminTokenPath(), "utf8").trim().length >= 32) return;
  } catch { /* missing: create it */ }
  writeFileSync(adminTokenPath(), randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROXY_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip"];

export function requireHostAdmin(req: FastifyRequest): void {
  // The socket address, not req.ip: a trusted proxy must never stand in for loopback.
  const direct = LOOPBACK.has(handoffContext(req)?.remote ?? req.socket.remoteAddress ?? "") && !PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  const given = req.headers[ADMIN_TOKEN_HEADER];
  let expected = "";
  try { expected = readFileSync(adminTokenPath(), "utf8").trim(); } catch { /* no token yet */ }
  const ok = direct && typeof given === "string" && expected.length >= 32 && given.length === expected.length
    && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) throw forbidden("A administração do annoy-server é feita pelo comando annoy-admin no host.");
}

/** Nested Fastify injection does not inherit AsyncLocalStorage. Each delegated
 * request must prove host authority itself; browsers never receive this token.
 */
export function delegatedHostActor(req: FastifyRequest): string | null {
  const actor = req.headers['x-annoy-host-actor'];
  if (actor === undefined) return null;
  requireHostAdmin(req);
  if (typeof actor !== 'string' || !actor || actor.length > 128 || !/^\/(?:api\/)?(servers|channels|invites|stickers|sticker-info|uploads|import)(\/|$)/.test(req.url)) {
    throw forbidden('Delegação administrativa fora do escopo da instância.');
  }
  return actor;
}
