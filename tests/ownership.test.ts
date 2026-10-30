import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

const directory = await mkdtemp(join(tmpdir(), "annoy-ownership-"));
process.env.ANNOY_DATA_DIR = directory;
process.env.DISTOPIC_DATA_DIR = directory;
const { db, run, one } = await import("../src/db.ts");
const { createSession } = await import("../src/auth.ts");
const { serverRoutes, deleteServer } = await import("../src/routes/servers.ts");
const { HttpError } = await import("../src/errors.ts");
const { adminRoutes } = await import("../src/routes/admin.ts");
const { ALL_PERMISSIONS } = await import("@distopic/protocol");
const app = Fastify();
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : 500).send({ message: (e as Error).message }));
serverRoutes(app);
await app.register(adminRoutes);
const tokens: Record<string, string> = {};
for (const id of ["owner", "member", "stranger", "ghost", "banned", "deleted"]) {
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')", id, id === "deleted" ? "deleted.old" : id, id);
  tokens[id] = createSession(id);
}
run("UPDATE users SET imported_from = 'discord:synthetic' WHERE id = 'ghost'");
run("UPDATE users SET banned_at = '2026-01-01' WHERE id = 'banned'");
run("UPDATE users SET is_admin = 1 WHERE id = 'owner'");
const auth = (id = "owner") => ({ authorization: `Bearer ${tokens[id]}` });
function server(id: string, members = ["owner", "member"]) {
  run("INSERT INTO servers VALUES(?,?, 'owner', '2026-01-01')", id, id);
  // Even granting administrator permissions does not grant ownership.
  run("INSERT INTO roles(id,server_id,name,permissions,position) VALUES(?,?,'everyone',?,0)", id, id, ALL_PERMISSIONS);
  for (const member of members) run("INSERT INTO members(server_id,user_id,joined_at) VALUES(?,?,'2026-01-01')", id, member);
}
const ownerOf = (id: string) => one<{ owner_id: string }>("SELECT owner_id FROM servers WHERE id = ?", id)?.owner_id;
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });

test("owners cannot delete communities with other members, even when all others are offline", async () => {
  server("shared");
  const response = await app.inject({ method: "DELETE", url: "/servers/shared", headers: auth() });
  assert.equal(response.statusCode, 403);
  assert.equal(ownerOf("shared"), "owner");
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE server_id='shared'")!.n, 2);
});

test("an owner alone can delete their community", async () => {
  server("alone", ["owner"]);
  const response = await app.inject({ method: "DELETE", url: "/servers/alone", headers: auth() });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(ownerOf("alone"), undefined);
  assert.equal(one("SELECT 1 FROM members WHERE server_id='alone'"), undefined);
});

test("the backend rechecks membership if someone joins after the client's alone snapshot", async () => {
  server("joined", ["owner"]);
  const snapshot = (await app.inject({ url: "/servers/joined", headers: auth() })).json();
  assert.equal(snapshot.members.length, 1);
  run("INSERT INTO members(server_id,user_id,joined_at) VALUES('joined','member','2026-01-01')");
  assert.equal((await app.inject({ method: "DELETE", url: "/servers/joined", headers: auth() })).statusCode, 403);
});

test("only the owner can transfer ownership, to another active member of this community", async () => {
  server("transfer-invalid", ["owner", "member", "ghost", "banned", "deleted"]);
  const transfer = (target: string, actor = "owner") => app.inject({ method: "POST", url: "/servers/transfer-invalid/ownership", headers: auth(actor), payload: { userId: target } });
  assert.equal((await transfer("owner", "member")).statusCode, 403);
  for (const target of ["owner", "stranger", "ghost", "banned", "deleted", "unknown"])
    assert.equal((await transfer(target)).statusCode, 400, target);
  assert.equal(ownerOf("transfer-invalid"), "owner");
  assert.equal((await app.inject({ method: "POST", url: "/servers/transfer-invalid/ownership", payload: { userId: "member" } })).statusCode, 401);
});

test("after transferring, the former owner can leave but cannot delete the new owner's server", async () => {
  server("transferred");
  const transfer = await app.inject({ method: "POST", url: "/servers/transferred/ownership", headers: auth(), payload: { userId: "member" } });
  assert.equal(transfer.statusCode, 200, transfer.body);
  assert.equal(transfer.json().ownerId, "member");
  assert.equal((await app.inject({ method: "DELETE", url: "/servers/transferred", headers: auth() })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/servers/transferred/ownership", headers: auth(), payload: { userId: "owner" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: "/servers/transferred/members/@me", headers: auth() })).statusCode, 200);
  assert.equal(ownerOf("transferred"), "member");
  assert.equal((await app.inject({ method: "DELETE", url: "/servers/transferred", headers: auth("member") })).statusCode, 200);
});

test("owners cannot bypass the membership guard through the administrative deletion helper", async () => {
  server("admin-owned");
  assert.equal((await app.inject({ method: "DELETE", url: "/admin/servers/admin-owned", headers: auth() })).statusCode, 403);
  await assert.rejects(deleteServer("admin-owned", "owner"), (error: unknown) => error instanceof HttpError && error.status === 403);
  assert.equal(ownerOf("admin-owned"), "owner");
});

test("owners must transfer ownership before leaving; nonowners cannot delete even with administrator permissions", async () => {
  server("leave-protected");
  assert.equal((await app.inject({ method: "DELETE", url: "/servers/leave-protected/members/@me", headers: auth() })).statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: "/servers/leave-protected", headers: auth("member") })).statusCode, 403);
  assert.equal(ownerOf("leave-protected"), "owner");
});
