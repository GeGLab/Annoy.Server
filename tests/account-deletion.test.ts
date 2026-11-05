import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "annoy-deletion-"));
process.env.ANNOY_ACCOUNT_MODE = "local";
process.env.ANNOY_DATA_DIR = directory;
const { db, run, one } = await import("../src/db.ts");
const { createSession } = await import("../src/auth.ts");
const { deleteAccount } = await import("../src/accounts.ts");
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

test("deleting an account erases everything linked to it and leaves no placeholder", async () => {
  for (const id of ["gone", "friend", "owner"]) run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')", id, id, id);
  run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('s','S','owner','2026-01-01')");
  for (const id of ["gone", "friend", "owner"]) run("INSERT INTO members(server_id,user_id,joined_at) VALUES('s',?,'2026-01-01')", id);
  run("INSERT INTO channels(id,server_id,type,name,created_at,created_by) VALUES('text','s','text','geral','2026-01-01','gone')");
  run("INSERT INTO channels(id,type,name,created_at) VALUES('dm','dm','','2026-01-01')");
  run("INSERT INTO dm_recipients VALUES('dm','gone'),('dm','friend')");
  run("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m1','text','gone','minha mensagem','2026-01-01'),('m2','dm','friend','resposta do amigo','2026-01-01'),('m3','text','friend','fica','2026-01-01')");
  run("INSERT INTO attachments(id,message_id,filename,size,content_type) VALUES('blob-mine','m1','a.txt',1,'text/plain'),('blob-dm','m2','b.txt',1,'text/plain')");
  run("INSERT INTO message_reactions(message_id,user_id,emoji) VALUES('m3','gone','👍')");
  run("INSERT INTO invites(code,server_id,creator_id,created_at) VALUES('inv','s','gone','2026-01-01')");
  run("INSERT INTO relationships(user_id,other_id,status) VALUES('gone','friend','friend'),('friend','gone','friend')");
  run("INSERT INTO overwrites(channel_id,target_id,target_type,allow,deny) VALUES('text','gone','member',0,0)");
  createSession("gone");
  for (const blob of ["blob-mine", "blob-dm", "blob-other"]) { await mkdir(join(directory, "uploads", blob), { recursive: true }); await writeFile(join(directory, "uploads", blob, "blob"), "x"); }

  await deleteAccount("gone");

  const count = (sql: string, ...params: string[]) => (one<{ n: number }>(sql, ...params)?.n ?? 0);
  assert.equal(count("SELECT COUNT(*) n FROM users WHERE id = 'gone' OR username LIKE 'deleted.%'"), 0, "no user row and no placeholder");
  assert.equal(count("SELECT COUNT(*) n FROM messages WHERE author_id = 'gone'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM channels WHERE id = 'dm'"), 0, "the direct conversation goes with the account");
  assert.equal(count("SELECT COUNT(*) n FROM messages WHERE id = 'm2'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM messages WHERE id = 'm3'"), 1, "other people's server messages stay");
  for (const table of ["sessions", "members", "message_reactions"]) assert.equal(count(`SELECT COUNT(*) n FROM ${table} WHERE user_id = 'gone'`), 0, table);
  assert.equal(count("SELECT COUNT(*) n FROM relationships WHERE user_id = 'gone' OR other_id = 'gone'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM invites WHERE creator_id = 'gone'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM overwrites WHERE target_id = 'gone'"), 0);
  assert.equal(one<{ created_by: string | null }>("SELECT created_by FROM channels WHERE id = 'text'")?.created_by, null);
  await assert.rejects(access(join(directory, "uploads", "blob-mine")));
  await assert.rejects(access(join(directory, "uploads", "blob-dm")));
  await access(join(directory, "uploads", "blob-other"));
  // Owners hand their servers over first.
  await assert.rejects(deleteAccount("owner"), /transfira/);
});
