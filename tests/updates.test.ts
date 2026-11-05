import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

// TODO item 5: the annoy-server is administered from its host (annoy-admin),
// never from the app. Settings are .env flags only.
const directory = await mkdtemp(join(tmpdir(), "annoy-updates-"));
const control = join(directory, "control");
process.env.ANNOY_ACCOUNT_MODE = "local";
process.env.ANNOY_DATA_DIR = directory;
process.env.ANNOY_CONTROL_DIR = control;
process.env.ANNOY_REGISTRATION = "closed";
const { db, run } = await import("../src/db.ts");
const { createSession } = await import("../src/auth.ts");
const { HttpError } = await import("../src/errors.ts");
const { adminRoutes } = await import("../src/routes/admin.ts");
const { ensureAdminToken, adminTokenPath, ADMIN_TOKEN_HEADER } = await import("../src/admin-control.ts");
const { getSettings } = await import("../src/instance.ts");
const { VERSION } = await import("../src/version.ts");
const app = Fastify();
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : 500).send({ message: (e as Error).message }));
await app.register(adminRoutes);
for (const id of ["admin", "member"]) run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')", id, id, id);
run("UPDATE users SET is_admin = 1 WHERE id = 'admin'");
ensureAdminToken();
const token = (await readFile(adminTokenPath(), "utf8")).trim();
const host = { [ADMIN_TOKEN_HEADER]: token };
const user = (id: string) => ({ authorization: `Bearer ${createSession(id)}` });
// Keep the test offline: GitHub answers with a fixed release.
globalThis.fetch = (async () => Response.json({ tag_name: "v9.9.9" })) as typeof fetch;
const heartbeat = (at = new Date()) =>
  writeFile(join(control, "status.json"), JSON.stringify({ heartbeat: at.toISOString(), auto: false, channel: "latest", intervalHours: 6, lastCheck: null, lastError: null, updating: false }));
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });

test("nobody administers the annoy-server from the app, not even its admin account", async () => {
  for (const headers of [user("admin"), user("member"), {}]) {
    assert.equal((await app.inject({ url: "/admin/overview", headers })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/admin/invites", headers, payload: {} })).statusCode, 403);
  }
});

test("the host token works only over loopback without a proxy in between", async () => {
  assert.equal((await app.inject({ url: "/admin/overview", headers: host })).statusCode, 200);
  assert.equal((await app.inject({ url: "/admin/overview", headers: { [ADMIN_TOKEN_HEADER]: "x".repeat(64) } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/admin/overview", headers: { ...host, "x-forwarded-for": "203.0.113.5" } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/admin/overview", headers: { ...host, "cf-connecting-ip": "203.0.113.5" } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/admin/overview", headers: host, remoteAddress: "172.18.0.4" })).statusCode, 403);
});

test("settings come from the flags; values stored by the old app panel are ignored", async () => {
  run("INSERT INTO instance_settings(key,value) VALUES('settings.registration','open')");
  assert.equal(getSettings().registration, "closed");
  assert.equal((await app.inject({ method: "PATCH", url: "/admin/settings", headers: host, payload: { registration: "open" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: "/admin/updates", headers: host, payload: { auto: true } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: "/admin/users/member", headers: host, payload: { isAdmin: true } })).statusCode, 404);
});

test("the host creates sign-up invites and bans by username", async () => {
  const invite = await app.inject({ method: "POST", url: "/admin/invites", headers: host, payload: { maxUses: 2 } });
  assert.equal(invite.statusCode, 200, invite.body);
  assert.equal(invite.json().maxUses, 2);
  assert.equal((await app.inject({ method: "POST", url: "/admin/users/member/ban", headers: host, payload: { reason: "spam" } })).statusCode, 200);
  const list = (await app.inject({ url: "/admin/users?q=member", headers: host })).json();
  assert.ok(list[0].bannedAt);
  assert.equal((await app.inject({ method: "DELETE", url: "/admin/users/member/ban", headers: host })).statusCode, 200);
});

test("without the updater, the host sees versions and can't update", async () => {
  const status = (await app.inject({ url: "/admin/updates", headers: host })).json();
  assert.deepEqual([status.current, status.latest, status.available], [VERSION, "9.9.9", false]);
  assert.equal((await app.inject({ method: "POST", url: "/admin/updates/apply", headers: host })).statusCode, 409);
});

test("with the updater running, the host asks for an update", async () => {
  await mkdir(control, { recursive: true });
  await heartbeat();
  const applied = await app.inject({ method: "POST", url: "/admin/updates/apply", headers: host });
  assert.equal(applied.json().updating, true);
  assert.ok(await readFile(join(control, "request"), "utf8"));
});

test("a stale updater counts as stopped", async () => {
  await heartbeat(new Date(Date.now() - 5 * 60_000));
  assert.equal((await app.inject({ url: "/admin/updates", headers: host })).json().available, false);
});
