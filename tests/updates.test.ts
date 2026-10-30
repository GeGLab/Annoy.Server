import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

const directory = await mkdtemp(join(tmpdir(), "annoy-updates-"));
const control = join(directory, "control");
process.env.ANNOY_DATA_DIR = directory;
process.env.ANNOY_CONTROL_DIR = control;
const { db, run } = await import("../src/db.ts");
const { createSession } = await import("../src/auth.ts");
const { HttpError } = await import("../src/errors.ts");
const { adminRoutes } = await import("../src/routes/admin.ts");
const { VERSION } = await import("../src/version.ts");
const app = Fastify();
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : 500).send({ message: (e as Error).message }));
await app.register(adminRoutes);
for (const id of ["admin", "member"]) run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')", id, id, id);
run("UPDATE users SET is_admin = 1 WHERE id = 'admin'");
const auth = (id = "admin") => ({ authorization: `Bearer ${createSession(id)}` });
// Keep the test offline: GitHub answers with a fixed release.
globalThis.fetch = (async () => Response.json({ tag_name: "v9.9.9" })) as typeof fetch;
const heartbeat = (at = new Date()) =>
  writeFile(join(control, "status.json"), JSON.stringify({ heartbeat: at.toISOString(), auto: false, channel: "latest", intervalHours: 6, lastCheck: null, lastError: null, updating: false }));
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });

test("without the updater, the admin sees versions and can't update", async () => {
  const status = (await app.inject({ url: "/admin/updates", headers: auth() })).json();
  assert.deepEqual([status.current, status.latest, status.available], [VERSION, "9.9.9", false]);
  assert.equal((await app.inject({ method: "POST", url: "/admin/updates/apply", headers: auth() })).statusCode, 409);
});

test("only the instance admin controls updates", async () => {
  assert.equal((await app.inject({ url: "/admin/updates", headers: auth("member") })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/admin/updates/apply", headers: auth("member") })).statusCode, 403);
});

test("with the updater running, the admin turns auto on and asks for an update", async () => {
  await mkdir(control, { recursive: true });
  await heartbeat();
  const patched = await app.inject({ method: "PATCH", url: "/admin/updates", headers: auth(), payload: { auto: true } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().auto, true);
  assert.equal(await readFile(join(control, "auto"), "utf8"), "on");
  const applied = await app.inject({ method: "POST", url: "/admin/updates/apply", headers: auth() });
  assert.equal(applied.json().updating, true);
  assert.ok(await readFile(join(control, "request"), "utf8"));
});

test("a stale updater counts as stopped", async () => {
  await heartbeat(new Date(Date.now() - 5 * 60_000));
  assert.equal((await app.inject({ url: "/admin/updates", headers: auth() })).json().available, false);
  assert.equal((await app.inject({ method: "PATCH", url: "/admin/updates", headers: auth(), payload: { auto: false } })).statusCode, 409);
});
