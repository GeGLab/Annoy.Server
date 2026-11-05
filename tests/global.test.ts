// End to end with a real Annoy Global API (the sibling Annoy-api-global
// checkout): an Annoy account signs in here without Global learning where.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";

const globalRepo = resolve(process.env.ANNOY_GLOBAL_REPO ?? "../annoy-api-global");
const skip = !existsSync(join(globalRepo, "src/server.ts")) && "needs the Annoy-api-global checkout next to this one";

const GLOBAL_PORT = 18090;
const AUTH_PORT = 18091;
const dataDir = await mkdtemp(join(tmpdir(), "annoy-global-server-"));
const globalData = await mkdtemp(join(tmpdir(), "annoy-global-api-"));
process.env.ANNOY_DATA_DIR = dataDir;
process.env.ANNOY_GLOBAL_URL = `http://127.0.0.1:${GLOBAL_PORT}`;
// Accounts live in authannoy (TODO item 2); it needs Postgres and Valkey (annoy-api-global: npm run cloud:dev).
process.env.ANNOY_AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
process.env.ANNOY_REGISTRATION = "open";
process.env.ANNOY_ACCOUNT_MODE = "global";
delete process.env.ANNOY_GLOBAL;

let globalApi: ChildProcess | null = null;
let authApi: ChildProcess | null = null;
const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const kdf = skip ? null! : await import(pathToFileURL(join(globalRepo, "src/client-kdf.ts")).href);
const { authRoutes } = await import("../src/routes/auth.ts");
const { startGlobal, globalLoginAvailable, globalServerId } = await import("../src/global.ts");
const { db, run } = await import("../src/db.ts");
// Isolated historical fixture connection, never a live HTTP option.
const { createSession, hashPassword, userIdForToken } = await import("../src/auth.ts");
const { newId } = await import("../src/ids.ts");
async function legacyAccount(username: string, password: string) {
  const id = newId();
  run("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", id, username, username, await hashPassword(password), new Date().toISOString());
  const token = createSession(id);
  run("UPDATE sessions SET account_mode = 'migration' WHERE user_id = ?", id);
  return { token, user: { id, username, global: false } };
}

const app = Fastify();
app.setErrorHandler((e: Error & { status?: number; code?: string }, _req, reply) =>
  reply.status(e.status ?? (e as { statusCode?: number }).statusCode ?? 500).send({ code: e.code, message: e.message }),
);
await app.register(async (api) => authRoutes(api), { prefix: "/api" });

before(async () => {
  if (skip) return;
  globalApi = spawn(process.execPath, ["src/server.ts"], {
    cwd: globalRepo,
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(GLOBAL_PORT),
      HOST: "127.0.0.1",
      DATA_DIR: globalData,
      GLOBAL_PEPPER: key(),
      GLOBAL_DATA_KEY: key(),
      GLOBAL_ESCROW_KEY: key(),
      INTERNAL_TOKEN: "server-test-internal",
      REQUIRE_EMAIL_VERIFICATION: "false",
      NODE_ENV: "test",
    },
  });
  const pepper = key(), dataKey = key();
  authApi = spawn(process.execPath, ["services/auth/src/server.ts"], {
    cwd: globalRepo,
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(AUTH_PORT), HOST: "127.0.0.1", NODE_ENV: "test", AUTH_RESET_SCHEMA_FOR_TESTS: "1",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://annoy:annoy-dev-only@127.0.0.1:55432/annoy",
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/8",
      AUTH_PEPPER: pepper, AUTH_DATA_KEY: dataKey, REQUIRE_EMAIL_VERIFICATION: "false",
      GLOBAL_URL: process.env.ANNOY_GLOBAL_URL, GLOBAL_INTERNAL_TOKEN: "server-test-internal", SANCTIONS_CACHE_SECONDS: "0",
    },
  });
  for (const url of [process.env.ANNOY_GLOBAL_URL, process.env.ANNOY_AUTH_URL])
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${url}/v1/health`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
  startGlobal(() => undefined);
  for (let i = 0; i < 50 && !globalLoginAvailable(); i++) await new Promise((r) => setTimeout(r, 100));
});

after(async () => {
  // Windows keeps the database files locked until the process has really exited.
  for (const child of [globalApi, authApi]) if (child && child.exitCode === null) { const exited = new Promise((r) => child.once("exit", r)); child.kill(); await exited; }
  await app.close();
  db.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  await rm(globalData, { recursive: true, force: true, maxRetries: 5 });
});

/** Account calls go to authannoy; the registry stays in the Global. */
const G = (path: string, init?: RequestInit) => fetch(`${/^\/v1\/(servers|admin|health)/.test(path) ? process.env.ANNOY_GLOBAL_URL : process.env.ANNOY_AUTH_URL}${path}`, init).then((r) => r.json());
const json = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
});
const local = (url: string, payload?: unknown, token?: string, method = "POST") =>
  app.inject({ method: method as "POST", url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });

/** A Annoy account, as the app sees it after logging in: session and account keys. */
async function globalAccount(name: string) {
  const email = `${name}@example.com`;
  const keys = kdf.newAccountKeys();
  const { iterations } = await G("/v1/auth/prelogin", json({ email }));
  const salt = kdf.newSalt();
  const pk = await kdf.derivePasswordKeys("senha de teste longa", salt, iterations);
  await G("/v1/auth/register", json({ email, name, salt, authKey: pk.authKey, wrappedKeys: await kdf.wrapKeys(pk.wrapKey, keys), recovery: { mode: "recoveryKey", wrapped: await kdf.wrapWithRecovery(kdf.newRecoveryKey(),keys) }, acceptTerms: "2026-10-29" }));
  const login = await G("/v1/auth/login", json({ email, authKey: pk.authKey }));
  return { keys, session: login.token as string };
}

/** What the app sends to log in here: identity, signed challenge and a fresh blind token. */
async function proof(account: { keys: unknown; session: string }) {
  const serverId = globalServerId()!;
  const identity = await kdf.serverIdentity(account.keys, serverId);
  const { challenge } = (await local("/api/auth/global/challenge")).json();
  const { keys, issueWith } = await G("/v1/tokens/keys");
  const pending = await kdf.blindToken(keys.find((k: { kid: string }) => k.kid === issueWith), kdf.tokenContext(serverId, identity.id));
  const issued = await G("/v1/tokens", json({ kid: issueWith, blinded: [pending.blinded] }, account.session));
  return { identity: identity.id, challenge, signature: await kdf.signForServer(identity.privateKey, challenge), token: await kdf.finalizeToken(pending, issued.signatures[0]) };
}

test("the server registers with Global once and offers global login", { skip }, async () => {
  assert.match(globalServerId() ?? "", /^S[0-9A-Z]{11}$/);
  assert.equal((await local("/api/info", undefined, undefined, "GET")).json().globalServerId, globalServerId());
});

test("first global login asks for a username, then signs in to the same account", { skip }, async () => {
  const ana = await globalAccount("ana");
  const first = await local("/api/auth/global", await proof(ana));
  assert.equal(first.statusCode, 404);
  assert.equal(first.json().code, "global_new_account");

  const created = await local("/api/auth/global", { ...(await proof(ana)), username: "ana_aqui" });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().user.global, true);
  const again = await local("/api/auth/global", await proof(ana));
  assert.equal(again.json().user.id, created.json().user.id);

  // What this server stores is not the account's Global ID.
  const row = db.prepare("SELECT global_id FROM users WHERE username = 'ana_aqui'").get() as { global_id: string };
  const me = await G("/v1/me", { headers: { authorization: `Bearer ${ana.session}` } });
  assert.notEqual(row.global_id, me.id);
});

test("a token works once, only with its own identity and challenge", { skip }, async () => {
  const bia = await globalAccount("bia");
  const p = await proof(bia);
  await local("/api/auth/global", { ...p, username: "bia_aqui" });
  const replay = await local("/api/auth/global", { ...p, challenge: (await local("/api/auth/global/challenge")).json().challenge });
  assert.equal(replay.statusCode, 401);

  const other = await proof(await globalAccount("caio"));
  const swapped = await local("/api/auth/global", { ...(await proof(bia)), token: other.token });
  assert.equal(swapped.statusCode, 401, "someone else's token doesn't vouch for this identity");
  const forged = await proof(bia);
  assert.equal((await local("/api/auth/global", { ...forged, signature: other.signature })).statusCode, 401);
});

test("a legacy local account migrates exclusively to global without losing its ID", { skip }, async () => {
  const reg = await legacyAccount("dani_local", "senha local longa");
  const token = reg.token;
  assert.equal(userIdForToken(token), null);
  const dani = await globalAccount("dani");
  const linked = await local("/api/auth/migrate/global", await proof(dani), token);
  assert.equal(linked.statusCode, 200, linked.body);
  assert.equal(linked.json().user.global, true);
  assert.equal(linked.json().user.id, reg.user.id);
  assert.equal(userIdForToken(token), null);
  assert.equal(userIdForToken(linked.json().token), reg.user.id);
  assert.equal(db.prepare("SELECT password_hash FROM users WHERE id = ?").get(reg.user.id)?.password_hash, "!");
  const viaGlobal = await local("/api/auth/global", await proof(dani));
  assert.equal(viaGlobal.json().user.username, "dani_local");
  // Taken by another account here: refused.
  assert.equal((await local("/api/auth/login", { username: "dani_local", password: "senha local longa" })).statusCode, 403);
  assert.equal((await local("/api/users/@me/global", await proof(dani), linked.json().token)).statusCode, 410);
  assert.equal((await local("/api/users/@me/global", undefined, linked.json().token, "DELETE")).statusCode, 403);
});

test("1.9: legacy identities with history remain separate instead of rewriting authorship", { skip }, async () => {
  const { run, one } = await import("../src/db.ts");
  const local_ = await legacyAccount("eva_local", "senha local da eva");
  const eva = await globalAccount("eva");
  const viaGlobal = (await local("/api/auth/global", { ...(await proof(eva)), username: "eva_global" })).json();
  const keep = local_.user.id, drop = viaGlobal.user.id;
  const friend = (await legacyAccount("amigo", "senha do amigo 1")).user.id;
  const t = "2026-01-01";
  // drop owns a server and has a role there, writes in it, is in keep's server, and has a friend.
  run("INSERT INTO servers (id, name, owner_id, created_at) VALUES ('s_drop', 'Do global', ?, ?)", drop, t);
  run("INSERT INTO servers (id, name, owner_id, created_at) VALUES ('s_keep', 'Do local', ?, ?)", keep, t);
  run("INSERT INTO roles (id, server_id, name, color, permissions, position) VALUES ('r1', 's_drop', 'mod', NULL, 0, 1)");
  for (const [s, u] of [["s_drop", drop], ["s_keep", keep], ["s_keep", drop]]) run("INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)", s, u, t);
  run("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('s_drop', ?, 'r1')", drop);
  run("INSERT INTO channels (id, server_id, type, name, created_at) VALUES ('c1', 's_drop', 'text', 'geral', ?)", t);
  run("INSERT INTO messages (id, channel_id, author_id, content, created_at, mention_ids) VALUES ('m1', 'c1', ?, 'oi', ?, ?)", drop, t, JSON.stringify([drop]));
  run("INSERT INTO relationships (user_id, other_id, status) VALUES (?, ?, 'friend'), (?, ?, 'friend')", drop, friend, friend, drop);

  const wrong = await local("/api/auth/migrate/global", { ...(await proof(eva)), username: "eva_local", password: "errada" });
  assert.equal(wrong.statusCode, 401, "the local password confirms the local side");
  const merged = await local("/api/auth/migrate/global", { ...(await proof(eva)), username: "eva_local", password: "senha local da eva" });
  assert.equal(merged.statusCode, 409, merged.body);
  assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM users WHERE id IN (?,?)",keep,drop)!.n,2);
  assert.equal(one<{ owner_id: string }>("SELECT owner_id FROM servers WHERE id='s_drop'")!.owner_id,drop);
  assert.equal(one<{ author_id: string }>("SELECT author_id FROM messages WHERE id='m1'")!.author_id,drop);
  assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM member_roles WHERE user_id=? AND role_id='r1'",drop)!.n,1);
  assert.equal((await local("/api/auth/global",await proof(eva))).json().user.id,drop);
});

test("global is the exclusive default and local registrations cannot bypass it", { skip }, async () => {
  assert.equal((await local("/api/info", undefined, undefined, "GET")).json().accountMode, "global");
  assert.equal((await local("/api/auth/register", { username: "bypass", password: "senha local longa" })).statusCode, 403);
});
