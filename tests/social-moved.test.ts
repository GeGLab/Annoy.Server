// TODO item 1: on Annoy-account servers, friends, DMs, status and direct calls
// leave the server; old routes say so, and the old data is removed once.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

const directory = await mkdtemp(join(tmpdir(), "annoy-social-moved-"));
process.env.ANNOY_ACCOUNT_MODE = "global";
process.env.ANNOY_DATA_DIR = directory;
const { db, run, one } = await import("../src/db.ts");
const { annoySocial, retireServerSocial, socialMovedRoutes } = await import("../src/social-moved.ts");
const { getUser } = await import("../src/repo.ts");
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

test("old DMs and friend lists leave an Annoy-account server once, files included", async () => {
  assert.equal(annoySocial, true);
  run("INSERT INTO users(id,username,display_name,password_hash,global_public_id,created_at) VALUES('a','a','A','!','UAAAAAAAAAA1','2026-01-01'),('b','b','B','!',NULL,'2026-01-01')");
  run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('s','S','a','2026-01-01')");
  run("INSERT INTO channels(id,server_id,type,name,created_at) VALUES('text','s','text','geral','2026-01-01')");
  run("INSERT INTO channels(id,type,name,created_at) VALUES('dm','dm','','2026-01-01')");
  run("INSERT INTO dm_recipients VALUES('dm','a'),('dm','b')");
  run("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m1','dm','a','oi','2026-01-01'),('m2','text','a','fica','2026-01-01')");
  run("INSERT INTO attachments(id,message_id,filename,size,content_type) VALUES('blob-dm','m1','a.txt',1,'text/plain'),('blob-text','m2','b.txt',1,'text/plain')");
  run("INSERT INTO relationships(user_id,other_id,status) VALUES('a','b','friend'),('b','a','friend')");
  for (const blob of ["blob-dm", "blob-text"]) { await mkdir(join(directory, "uploads", blob), { recursive: true }); await writeFile(join(directory, "uploads", blob, "blob"), "x"); }

  assert.deepEqual(await retireServerSocial(), { dms: 1, relationships: 2 });
  const count = (sql: string) => one<{ n: number }>(sql)!.n;
  assert.equal(count("SELECT COUNT(*) n FROM channels WHERE type = 'dm'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM relationships"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM messages WHERE id = 'm2'"), 1, "server channels keep their messages");
  await assert.rejects(access(join(directory, "uploads", "blob-dm")));
  await access(join(directory, "uploads", "blob-text"));
  // Only once: later DMs (an outdated app can't make them anyway) are not swept again.
  assert.equal(await retireServerSocial(), null);
});

test("members carry their Annoy public ID; local accounts don't", () => {
  assert.equal(getUser("a")?.annoyId, "UAAAAAAAAAA1");
  assert.equal(getUser("b")?.annoyId, undefined);
});

test("old social routes answer 410 with the reason", async () => {
  const app = Fastify();
  const { HttpError } = await import("../src/errors.ts");
  app.setErrorHandler((err, _req, reply) => { const e = err as InstanceType<typeof HttpError>; void reply.status(e.status ?? 500).send({ error: e.code, message: e.message }); });
  await app.register(async (api) => socialMovedRoutes(api), { prefix: "/api" });
  for (const [method, url] of [["GET", "/api/relationships"], ["POST", "/api/dms"], ["POST", "/api/calls"], ["DELETE", "/api/relationships/x"]] as const) {
    const res = await app.inject({ method, url, payload: method === "GET" || method === "DELETE" ? undefined : {} });
    assert.equal(res.statusCode, 410, url);
    assert.equal(res.json().error, "moved_to_annoy");
  }
  await app.close();
});
