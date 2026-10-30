import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

const directory = await mkdtemp(join(tmpdir(), "annoy-steam-server-"));
process.env.ANNOY_DATA_DIR = directory;
process.env.DISTOPIC_DATA_DIR = directory;
process.env.ANNOY_PUBLIC_URL = "https://annoy.example";
process.env.ANNOY_STEAM_API_KEY = "synthetic-private-key";
const { db, run, one } = await import("../src/db.ts");
const { createSession, deleteSession } = await import("../src/auth.ts");
const { steamRoutes } = await import("../src/routes/steam.ts");
const { HttpError } = await import("../src/errors.ts");
const { steamStatus, steamOnlineActivity } = await import("../src/steam.ts");
const { deleteAccount, mergeUsers } = await import("../src/accounts.ts");
const app = Fastify();
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : 500).send({ message: (e as Error).message }));
await app.register(async (api) => steamRoutes(api), { prefix: "/api" });
const tokens: Record<string, string> = {};
for (const id of ["alice", "bob", "charlie", "logout", "deleted", "keep", "drop"]) {
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')", id, id, id);
  tokens[id] = createSession(id);
}
const headers = (id = "alice") => ({ authorization: `Bearer ${tokens[id]}` });
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
async function begin(id = "alice") {
  const response = await app.inject({ method: "POST", url: "/api/auth/steam/begin", headers: headers(id), payload: {} });
  assert.equal(response.statusCode, 200);
  return response.json();
}
function assertion(link: { url: string }, steamId = "76561198000000001") {
  const url = new URL(link.url);
  const returnTo = url.searchParams.get("openid.return_to")!;
  return {
    state: new URL(returnTo).searchParams.get("state")!,
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.return_to": returnTo,
    "openid.claimed_id": `https://steamcommunity.com/openid/id/${steamId}`,
    "openid.identity": `https://steamcommunity.com/openid/id/${steamId}`,
    "openid.response_nonce": new Date().toISOString().slice(0, 19) + "Zsynthetic-nonce",
    "openid.signed": "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "synthetic-signature",
  };
}
const callback = (query: Record<string, string>) => app.inject({ url: `/api/auth/steam/callback?${new URLSearchParams(query)}` });
const poll = async (link: { handoff: string }, id = "alice") => (await app.inject({ method: "POST", url: "/api/auth/steam/poll", headers: headers(id), payload: { handoff: link.handoff } })).json();

test("Steam routes require authentication and keep connections private", async () => {
  for (const [method, url] of [["GET", "/users/@me/steam"], ["POST", "/auth/steam/begin"], ["POST", "/auth/steam/poll"], ["DELETE", "/users/@me/steam"], ["GET", "/users/@me/steam/activity"]] as const) {
    assert.equal((await app.inject({ method, url: `/api${url}`, payload: method === "POST" ? {} : undefined })).statusCode, 401);
  }
  assert.deepEqual(steamStatus("bob"), { connection: null, onlineActivityAvailable: true });
});

test("OpenID link verifies with Steam, binds initiating account, polls once and rejects replay", async () => {
  const link = await begin();
  const url = new URL(link.url);
  assert.equal(url.origin, "https://steamcommunity.com");
  assert.equal(url.searchParams.get("openid.realm"), "https://annoy.example/");
  assert.equal(link.url.includes(link.handoff), false);
  assert.deepEqual(await poll(link), { status: "pending" });
  assert.equal((await poll(link, "bob")).status, "error");
  let checks = 0;
  globalThis.fetch = async (endpoint, options) => {
    assert.equal(String(endpoint), "https://steamcommunity.com/openid/login");
    assert.equal(options?.method, "POST");
    assert.equal((options?.body as URLSearchParams).get("openid.mode"), "check_authentication");
    checks++;
    return new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n");
  };
  const query = assertion(link);
  const response = await callback(query);
  assert.match(response.body, /Steam conectada/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal((await poll(link)).status, "done");
  assert.equal((await poll(link)).status, "error");
  await callback(query);
  assert.equal(checks, 1);
  assert.equal(steamStatus("alice").connection?.steamId, "76561198000000001");
  assert.equal(steamStatus("bob").connection, null);
});

test("forged assertions, mismatched state/identity, missing signed fields and expired nonce cannot link", async () => {
  let checks = 0;
  globalThis.fetch = async () => { checks++; return new Response("is_valid:true\n"); };
  for (const change of [
    { "openid.op_endpoint": "https://attacker.test/openid" },
    { "openid.return_to": "https://attacker.test/" },
    { "openid.identity": "https://steamcommunity.com/openid/id/76561198000000009" },
    { "openid.claimed_id": "https://steamcommunity.com.attacker.test/openid/id/76561198000000009" },
    { "openid.signed": "op_endpoint,claimed_id,identity,response_nonce" },
    { "openid.response_nonce": "2020-01-01T00:00:00Zold" },
  ]) {
    const link = await begin("bob");
    await callback({ ...assertion(link), ...change });
    assert.equal((await poll(link, "bob")).status, "error");
  }
  assert.equal(checks, 0);
  const link = await begin("bob");
  globalThis.fetch = async () => new Response("is_valid:false\n");
  await callback(assertion(link));
  assert.equal((await poll(link, "bob")).status, "error");
  assert.equal(steamStatus("bob").connection, null);
});

test("cancellation, replacement and session logout invalidate pending links", async () => {
  const canceled = await begin("bob");
  const query = assertion(canceled);
  await callback({ state: query.state, "openid.mode": "cancel" });
  assert.equal((await poll(canceled, "bob")).status, "error");
  const replaced = await begin("bob");
  await begin("bob");
  assert.equal((await poll(replaced, "bob")).status, "error");
  const loggedOut = await begin("logout");
  deleteSession(tokens.logout!);
  globalThis.fetch = async () => new Response("is_valid:true\n");
  await callback(assertion(loggedOut, "76561198000000002"));
  assert.equal(steamStatus("logout").connection, null);
});

test("a Steam identity cannot belong to two Annoy accounts on the same instance", async () => {
  const link = await begin("bob");
  globalThis.fetch = async () => new Response("is_valid:true\n");
  await callback(assertion(link));
  assert.equal((await poll(link, "bob")).status, "error");
  assert.equal(steamStatus("bob").connection, null);
});

test("online activity uses server key, returns only game metadata and coalesces requests", async () => {
  let requests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.steampowered.com");
    assert.equal(url.searchParams.get("key"), "synthetic-private-key");
    assert.equal(url.searchParams.get("steamids"), "76561198000000001");
    requests++;
    return Response.json({ response: { players: [{ steamid: "76561198000000001", gameid: "480", gameextrainfo: "Synthetic game", personaname: "Private name" }] } });
  };
  const results = await Promise.all([steamOnlineActivity("alice"), steamOnlineActivity("alice")]);
  assert.equal(requests, 1);
  assert.deepEqual(results[0], [{ kind: "game", provider: "steam", name: "Synthetic game", appId: "480" }]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await steamOnlineActivity("bob"), []);
  const response = await app.inject({ url: "/api/users/@me/steam/activity", headers: headers() });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes("synthetic-private-key"), false);
  assert.equal(response.body.includes("76561198000000001"), false);
});

test("unlink cancels pending attempts, clears caches and allows relinking", async () => {
  const link = await begin();
  const response = await app.inject({ method: "DELETE", url: "/api/users/@me/steam", headers: headers() });
  assert.equal(response.json().connection, null);
  assert.deepEqual(await steamOnlineActivity("alice"), []);
  assert.equal((await poll(link)).status, "error");
  const bob = await begin("bob");
  globalThis.fetch = async () => new Response("is_valid:true\n");
  await callback(assertion(bob));
  assert.equal((await poll(bob, "bob")).status, "done");
});

test("failed, private and non-Steam game lookups clear activity", async () => {
  for (const [index, payload] of [null, { response: { players: [] } }, { response: { players: [{ steamid: "76561198000000003", gameid: "999999999999999999", gameextrainfo: "Shortcut" }] } }].entries()) {
    run("DELETE FROM steam_connections WHERE user_id = 'charlie'");
    const link = await begin("charlie");
    globalThis.fetch = async () => new Response("is_valid:true\n");
    await callback(assertion(link, "76561198000000003"));
    await poll(link, "charlie");
    globalThis.fetch = async () => payload ? Response.json(payload) : new Response("", { status: 503 });
    assert.deepEqual(await steamOnlineActivity("charlie"), [], `scenario ${index}`);
  }
});

test("account deletion erases the Steam link and merging transfers it", async () => {
  run("INSERT INTO steam_connections VALUES('deleted', '76561198000000004', '2026-01-01')");
  await deleteAccount("deleted", { deleteMessages: false });
  assert.equal(steamStatus("deleted").connection, null);
  run("UPDATE users SET global_id = 'synthetic-global-id' WHERE id = 'drop'");
  run("INSERT INTO steam_connections VALUES('drop', '76561198000000005', '2026-01-01')");
  mergeUsers("keep", "drop");
  assert.equal(steamStatus("keep").connection?.steamId, "76561198000000005");
  assert.equal(one("SELECT 1 FROM steam_connections WHERE user_id = 'drop'"), undefined);
  mergeUsers("bob", "charlie");
  assert.equal(steamStatus("bob").connection?.steamId, "76561198000000001");
  assert.equal(one("SELECT 1 FROM steam_connections WHERE user_id = 'charlie'"), undefined);
});

test("unlink during OpenID verification prevents a late callback from restoring the connection", async () => {
  const link = await begin("alice");
  let finish!: (response: Response) => void;
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = async () => { started(); return new Promise<Response>((resolve) => { finish = resolve; }); };
  const callbackResult = callback(assertion(link, "76561198000000006"));
  // app.inject is lazy until its promise is consumed.
  const completing = Promise.resolve(callbackResult);
  await requested;
  await app.inject({ method: "DELETE", url: "/api/users/@me/steam", headers: headers() });
  finish(new Response("is_valid:true\n"));
  await completing;
  assert.equal(steamStatus("alice").connection, null);
});

test("linking works without an API key and no online request is made", async () => {
  const { config } = await import("../src/config.ts");
  const mutable = config as { steamApiKey: string };
  const previous = mutable.steamApiKey;
  mutable.steamApiKey = "";
  try {
    const link = await begin("alice");
    globalThis.fetch = async () => new Response("is_valid:true\n");
    await callback(assertion(link, "76561198000000007"));
    assert.equal((await poll(link)).status, "done");
    assert.equal(steamStatus("alice").onlineActivityAvailable, false);
    globalThis.fetch = async () => { throw new Error("No online request expected"); };
    assert.deepEqual(await steamOnlineActivity("alice"), []);
  } finally { mutable.steamApiKey = previous; }
});
