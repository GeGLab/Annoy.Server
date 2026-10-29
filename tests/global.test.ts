// End to end with a real Annoy Global API (the sibling Annoy-api-global
// checkout): a global account signs in here without Global learning where.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";

const globalRepo = resolve(process.env.ANNOY_GLOBAL_REPO ?? "../annoy-api-global");
const skip = !existsSync(join(globalRepo, "src/server.ts")) && "needs the Annoy-api-global checkout next to this one";

const GLOBAL_PORT = 18090;
const dataDir = await mkdtemp(join(tmpdir(), "annoy-global-server-"));
const globalData = await mkdtemp(join(tmpdir(), "annoy-global-api-"));
process.env.ANNOY_DATA_DIR = dataDir;
process.env.ANNOY_GLOBAL_URL = `http://127.0.0.1:${GLOBAL_PORT}`;
process.env.ANNOY_REGISTRATION = "open";

let globalApi: ChildProcess | null = null;
const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const kdf = skip ? null! : await import(join(globalRepo, "src/client-kdf.ts"));
const { authRoutes } = await import("../src/routes/auth.ts");
const { startGlobal, globalLoginAvailable, globalServerId } = await import("../src/global.ts");
const { db } = await import("../src/db.ts");

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
      REQUIRE_EMAIL_VERIFICATION: "false",
      NODE_ENV: "test",
    },
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${process.env.ANNOY_GLOBAL_URL}/v1/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  startGlobal(() => undefined);
  for (let i = 0; i < 50 && !globalLoginAvailable(); i++) await new Promise((r) => setTimeout(r, 100));
});

after(async () => {
  globalApi?.kill();
  await app.close();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(globalData, { recursive: true, force: true });
});

const G = (path: string, init?: RequestInit) => fetch(`${process.env.ANNOY_GLOBAL_URL}${path}`, init).then((r) => r.json());
const json = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
});
const local = (url: string, payload?: unknown, token?: string, method = "POST") =>
  app.inject({ method: method as "POST", url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });

/** A global account, as the app sees it after logging in: session and account keys. */
async function globalAccount(name: string) {
  const email = `${name}@example.com`;
  const keys = kdf.newAccountKeys();
  const { iterations } = await G("/v1/auth/prelogin", json({ email }));
  const salt = kdf.newSalt();
  const pk = await kdf.derivePasswordKeys("senha de teste longa", salt, iterations);
  await G("/v1/auth/register", json({ email, name, salt, authKey: pk.authKey, wrappedKeys: await kdf.wrapKeys(pk.wrapKey, keys), recovery: { mode: "email", escrow: kdf.escrowKeys(keys) }, acceptTerms: "2026-10-29" }));
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
  return { identity: identity.id, challenge, signature: await kdf.signForServer(identity.privateKey, challenge), token: kdf.finalizeToken(pending, issued.signatures[0]) };
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

test("a local account starts signing in with its global account (1.7)", { skip }, async () => {
  const reg = await local("/api/auth/register", { username: "dani_local", password: "senha local longa" });
  const token = reg.json().token;
  assert.equal(reg.json().user.global, false);
  const dani = await globalAccount("dani");
  const linked = await local("/api/users/@me/global", await proof(dani), token);
  assert.equal(linked.statusCode, 200, linked.body);
  assert.equal(linked.json().global, true);
  const viaGlobal = await local("/api/auth/global", await proof(dani));
  assert.equal(viaGlobal.json().user.username, "dani_local");
  // Taken by another account here: refused.
  const reg2 = await local("/api/auth/register", { username: "outro", password: "senha local longa" });
  assert.equal((await local("/api/users/@me/global", await proof(dani), reg2.json().token)).statusCode, 409);
});
