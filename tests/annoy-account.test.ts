// Leaving a server and deleting an Annoy account: messages stay, by "Usuário desconhecido".
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

const directory = await mkdtemp(join(tmpdir(), "annoy-account-"));
process.env.ANNOY_ACCOUNT_MODE = "local";
process.env.ANNOY_DATA_DIR = directory;
const { db, run, one, all } = await import("../src/db.ts");
const { createSession } = await import("../src/auth.ts");
const { serverRoutes, deleteServer } = await import("../src/routes/servers.ts");
const { HttpError } = await import("../src/errors.ts");
const { deleteForAnnoyAccount, UNKNOWN_USER } = await import("../src/annoy-members.ts");
const { DEFAULT_EVERYONE_PERMISSIONS } = await import("@annoy/protocol");
const app = Fastify();
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : 500).send({ message: (e as Error).message }));
serverRoutes(app);
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });

const tokens: Record<string, string> = {};
for (const id of ["owner", "member", "gone"]) {
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')", id, id, id);
  tokens[id] = createSession(id);
}
let n = 0;
function server(id: string, owner: string, members: string[]) {
  run("INSERT INTO servers(id,name,owner_id,created_at) VALUES(?,?,?,'2026-01-01')", id, id, owner);
  run("INSERT INTO roles(id,server_id,name,permissions,position) VALUES(?,?,'@everyone',?,0)", id, id, DEFAULT_EVERYONE_PERMISSIONS);
  for (const member of members) run("INSERT INTO members(server_id,user_id,joined_at) VALUES(?,?,'2026-01-01')", id, member);
  run("INSERT INTO channels(id,server_id,type,name,created_at) VALUES(?,?,'text','geral','2026-01-01')", `${id}-c`, id);
}
function message(channel: string, author: string): string {
  const id = `m${++n}`;
  run("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,'oi','2026-01-01')", id, channel, author);
  return id;
}
const authorOf = (id: string) => one<{ author_id: string }>("SELECT author_id FROM messages WHERE id = ?", id)?.author_id;

test("leaving a server keeps the messages there, by Usuário desconhecido; other servers are untouched", async () => {
  server("a", "owner", ["owner", "member"]);
  server("b", "owner", ["owner", "member"]);
  const there = message("a-c", "member"), elsewhere = message("b-c", "member");
  const res = await app.inject({ method: "DELETE", url: "/servers/a/members/@me", headers: { authorization: `Bearer ${tokens.member}` } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(authorOf(there), UNKNOWN_USER);
  assert.equal(authorOf(elsewhere), "member");
  assert.equal(one<{ display_name: string }>("SELECT display_name FROM users WHERE id = ?", UNKNOWN_USER)!.display_name, "Usuário desconhecido");
  assert.equal(one("SELECT 1 AS x FROM members WHERE server_id = 'a' AND user_id = 'member'"), undefined);
  // The owner still has to transfer first.
  assert.equal((await app.inject({ method: "DELETE", url: "/servers/b/members/@me", headers: { authorization: `Bearer ${tokens.owner}` } })).statusCode, 400);
});

test("a deleted Annoy account: its solo servers go, it leaves the others, messages stay as Usuário desconhecido", async () => {
  server("solo", "gone", ["gone"]);
  server("shared", "owner", ["owner", "gone"]);
  const kept = message("shared-c", "gone");
  message("solo-c", "gone");
  await deleteForAnnoyAccount("gone", deleteServer, () => undefined);
  assert.equal(one("SELECT 1 AS x FROM servers WHERE id = 'solo'"), undefined);
  assert.equal(authorOf(kept), UNKNOWN_USER);
  assert.equal(one("SELECT 1 AS x FROM users WHERE id = 'gone'"), undefined);
  assert.deepEqual(all("SELECT server_id FROM members WHERE user_id = 'gone'"), []);
  assert.ok(one("SELECT 1 AS x FROM servers WHERE id = 'shared'"));
});
