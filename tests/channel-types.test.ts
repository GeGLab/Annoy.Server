import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

const directory = await mkdtemp(join(tmpdir(), "annoy-channel-types-"));
process.env.ANNOY_DATA_DIR = directory;
process.env.DISTOPIC_DATA_DIR = directory;

// A database from 0.6: the channel type is limited by a CHECK that 0.7 has to drop.
{
  const old = new DatabaseSync(join(directory, "distopic.db"));
  old.exec(`CREATE TABLE channels (
    id TEXT PRIMARY KEY, server_id TEXT, type TEXT NOT NULL CHECK (type IN ('category', 'text', 'voice', 'dm')),
    name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', parent_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
    position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
  old.exec("INSERT INTO channels (id, server_id, type, name, created_at) VALUES ('old-dm', NULL, 'dm', '', '2026-01-01')");
  old.close();
}

const { db, run, one } = await import("../src/db.ts");
const { createSession } = await import("../src/auth.ts");
const { serverRoutes } = await import("../src/routes/servers.ts");
const { channelRoutes } = await import("../src/routes/channels.ts");
const { playbackRoutes } = await import("../src/playback.ts");
const { codeRoutes } = await import("../src/code.ts");
const { tempRoomRoutes, roomsOccupied } = await import("../src/rooms.ts");
const { HttpError } = await import("../src/errors.ts");
const { DEFAULT_EVERYONE_PERMISSIONS, TEMP_ROOM_IDLE_MS } = await import("@distopic/protocol");

const app = Fastify();
await app.register((await import("@fastify/multipart")).default);
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : ((e as { statusCode?: number }).statusCode ?? 500)).send({ message: (e as Error).message }));
serverRoutes(app);
channelRoutes(app);
playbackRoutes(app);
codeRoutes(app);
tempRoomRoutes(app);
const tokens: Record<string, string> = {};
for (const id of ["owner", "member"]) {
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')", id, id, id);
  tokens[id] = createSession(id);
}
run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('s','s','owner','2026-01-01')");
run("INSERT INTO roles(id,server_id,name,permissions,position) VALUES('s','s','everyone',?,0)", DEFAULT_EVERYONE_PERMISSIONS);
for (const member of ["owner", "member"]) run("INSERT INTO members(server_id,user_id,joined_at) VALUES('s',?,'2026-01-01')", member);
const auth = (id = "owner") => ({ authorization: `Bearer ${tokens[id]}` });
const create = async (type: string, name = type) => {
  const res = await app.inject({ method: "POST", url: "/servers/s/channels", headers: auth(), payload: { name, type } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { id: string; type: string; name: string; temporary?: boolean };
};
after(async () => {
  await app.close();
  db.close();
  await rm(directory, { recursive: true, force: true });
});

test("0.6 databases keep their channels and accept the new types", async () => {
  assert.equal(one<{ type: string }>("SELECT type FROM channels WHERE id = 'old-dm'")?.type, "dm");
  for (const type of ["files", "code", "theater", "song"]) assert.equal((await create(type)).type, type);
  assert.equal((await app.inject({ method: "POST", url: "/servers/s/channels", headers: auth(), payload: { name: "x", type: "bogus" } })).statusCode, 400);
});

test("files channels only take messages that carry files", async () => {
  const files = await create("files", "Arquivos Úteis");
  assert.equal(files.name, "arquivos-úteis");
  const text = await app.inject({ method: "POST", url: `/channels/${files.id}/messages`, headers: auth(), payload: { content: "oi" } });
  assert.equal(text.statusCode, 400);
  const boundary = "----annoy";
  const body = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="notes.txt"', "Content-Type: text/plain", "", "hello", `--${boundary}--`, ""].join("\r\n");
  const upload = await app.inject({ method: "POST", url: `/channels/${files.id}/messages`, headers: { ...auth("member"), "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(upload.statusCode, 200, upload.body);
  assert.equal(upload.json().attachments[0].filename, "notes.txt");
});

test("theater rooms keep one synced queue", async () => {
  const theater = await create("theater", "Cinema");
  const act = (payload: object, who = "owner") => app.inject({ method: "POST", url: `/channels/${theater.id}/playback`, headers: auth(who), payload });
  const added = await act({ op: "add", url: "https://example.com/movie.mp4" }, "member");
  assert.equal(added.statusCode, 200, added.body);
  let state = added.json();
  assert.equal(state.queue[0].kind, "direct");
  assert.equal(state.currentId, state.queue[0].id);
  assert.equal(state.paused, false);
  state = (await act({ op: "add", url: "https://example.com/watch/42" })).json();
  assert.equal(state.queue[1].kind, "site");
  state = (await act({ op: "pause", position: 12.5 })).json();
  assert.deepEqual([state.paused, state.position], [true, 12.5]);
  assert.equal((await act({ op: "next" }, "member")).statusCode, 200, "whoever added the current item may skip it");
  state = (await act({ op: "ended", itemId: state.queue[0].id })).json();
  assert.equal(state.currentId, state.queue[1].id, "a stale end report changes nothing");
  assert.equal((await act({ op: "remove", itemId: state.queue[1].id }, "member")).statusCode, 403);
  assert.equal((await act({ op: "add", url: "file:///etc/passwd" })).statusCode, 400);
  const get = await app.inject({ url: `/channels/${theater.id}/playback`, headers: auth("member") });
  assert.equal(get.json().queue.length, 2);
});

test("temporary rooms vanish after 10 idle minutes, or when the last person leaves", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const make = async () => {
      const res = await app.inject({ method: "POST", url: "/servers/s/temp-rooms", headers: auth("member"), payload: { name: "Sala do member" } });
      assert.equal(res.statusCode, 200, res.body);
      return res.json() as { id: string; temporary: boolean; type: string };
    };
    const idle = await make();
    assert.deepEqual([idle.type, idle.temporary], ["voice", true]);
    mock.timers.tick(TEMP_ROOM_IDLE_MS - 1000);
    assert.ok(one("SELECT 1 FROM channels WHERE id = ?", idle.id));
    mock.timers.tick(1000);
    await new Promise((r) => setImmediate(r));
    assert.equal(one("SELECT 1 FROM channels WHERE id = ?", idle.id), undefined);

    const used = await make();
    roomsOccupied("s", new Set([used.id]));
    mock.timers.tick(TEMP_ROOM_IDLE_MS * 2);
    await new Promise((r) => setImmediate(r));
    assert.ok(one("SELECT 1 FROM channels WHERE id = ?", used.id), "a room in use outlives the idle timer");
    roomsOccupied("s", new Set());
    await new Promise((r) => setImmediate(r));
    assert.equal(one("SELECT 1 FROM channels WHERE id = ?", used.id), undefined);

    for (let i = 0; i < 3; i++) await make();
    assert.equal((await app.inject({ method: "POST", url: "/servers/s/temp-rooms", headers: auth("member"), payload: { name: "mais uma" } })).statusCode, 400);
  } finally {
    mock.timers.reset();
  }
});

test("code channels only link public https remotes and stay inside the working copy", async () => {
  const code = await create("code", "site");
  const link = (url: string, who = "owner") => app.inject({ method: "PUT", url: `/channels/${code.id}/code`, headers: auth(who), payload: { url } });
  for (const url of ["http://github.com/a/b", "https://localhost/a.git", "https://127.0.0.1/a.git", "https://192.168.0.10/a.git", "https://[::1]/a.git", "file:///etc", "https://user:token@github.com/a/b"]) {
    assert.equal((await link(url)).statusCode, 400, url);
  }
  assert.equal((await link("https://github.com/octocat/Hello-World", "member")).statusCode, 403);

  const linked = await link("https://github.com/octocat/Hello-World");
  assert.equal(linked.statusCode, 200, linked.body);
  let repo = linked.json();
  for (let i = 0; i < 300 && repo.status === "cloning"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    repo = (await app.inject({ url: `/channels/${code.id}/code`, headers: auth() })).json();
  }
  if (repo.status === "error" && /resolve|connect|network/i.test(repo.error ?? "")) return; // offline machine
  assert.equal(repo.status, "ready", repo.error);

  const tree = (await app.inject({ url: `/channels/${code.id}/code/tree`, headers: auth("member") })).json();
  assert.ok(tree.some((e: { path: string }) => e.path === "README"));
  assert.ok(!tree.some((e: { path: string }) => e.path.startsWith(".git")));
  const file = (await app.inject({ url: `/channels/${code.id}/code/file?path=README`, headers: auth("member") })).json();
  const save = (payload: object) => app.inject({ method: "PUT", url: `/channels/${code.id}/code/file`, headers: auth("member"), payload });
  assert.equal((await save({ path: "README", content: "edited\n", baseHash: file.hash })).statusCode, 200);
  assert.equal((await save({ path: "README", content: "stale\n", baseHash: file.hash })).statusCode, 409);
  for (const path of ["../outside", ".git/config", "a/.git/x", "a/../../x"]) assert.equal((await save({ path, content: "x" })).statusCode, 400, path);

  await symlink("/etc/hostname", join(directory, "code", code.id, "repo", "leak"));
  assert.equal((await app.inject({ url: `/channels/${code.id}/code/file?path=leak`, headers: auth() })).statusCode, 400);
  await symlink("/tmp", join(directory, "code", code.id, "repo", "escape"));
  assert.equal((await save({ path: "escape/pwned", content: "x" })).statusCode, 400);

  const status = (await app.inject({ url: `/channels/${code.id}/code/status`, headers: auth() })).json();
  assert.ok(status.files.some((f: { path: string; code: string }) => f.path === "README" && f.code === " M"), JSON.stringify(status.files));
  const commit = await app.inject({ method: "POST", url: `/channels/${code.id}/code/commit`, headers: auth("member"), payload: { message: "Edit README" } });
  assert.equal(commit.statusCode, 200, commit.body);
  const after = (await app.inject({ url: `/channels/${code.id}/code/status`, headers: auth() })).json();
  assert.equal(after.log[0].subject, "Edit README");
  assert.equal(after.log[0].author, "member");
  assert.equal(after.ahead, 1);

  const removed = await app.inject({ method: "DELETE", url: `/channels/${code.id}`, headers: auth() });
  assert.equal(removed.statusCode, 200);
});
