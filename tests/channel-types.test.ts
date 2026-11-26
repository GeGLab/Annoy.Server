import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

const directory = await mkdtemp(join(tmpdir(), "annoy-channel-types-"));
process.env.ANNOY_ACCOUNT_MODE = "local";
process.env.ANNOY_DATA_DIR = directory;

// A database from 0.6: the channel type is limited by a CHECK that 0.7 has to drop.
{
  const old = new DatabaseSync(join(directory, "annoy.db"));
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
const { DEFAULT_EVERYONE_PERMISSIONS, TEMP_ROOM_IDLE_MS } = await import("@annoy/protocol");

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
  assert.equal(text.statusCode,400);
  const boundary = "----annoy";
  const body = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="notes.txt"', "Content-Type: text/plain", "", "hello", `--${boundary}--`, ""].join("\r\n");
  const upload = await app.inject({ method: "POST", url: `/channels/${files.id}/messages`, headers: { ...auth("member"), "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(upload.statusCode,200,upload.body);
  assert.equal(upload.json().attachments[0].filename,"notes.txt");
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

test("song room options keep the clock running and the room knows who listens", async () => {
  const song = await create("song", "Rock");
  const act = (payload: object, who = "owner") => app.inject({ method: "POST", url: `/channels/${song.id}/playback`, headers: auth(who), payload });
  let state = (await act({ op: "add", url: "https://example.com/track.mp3" })).json();
  state = (await act({ op: "seek", position: 30 })).json();
  // Some time passes in the song, then someone flips an option: the song must not go back.
  const started = state.updatedAt as number;
  await new Promise((r) => setTimeout(r, 120));
  for (const option of [{ op: "dj", value: true }, { op: "dj", value: true, style: "echo" }, { op: "ducking", value: false }, { op: "autoplay", value: true }, { op: "add", url: "https://example.com/next.mp3" }]) {
    state = (await act(option, "member")).json();
    assert.ok(state.position >= 30 + (state.updatedAt - started) / 1000 - 0.05, `${JSON.stringify(option)} kept the clock (${state.position})`);
  }
  assert.deepEqual([state.dj, state.djStyle, state.ducking], [true, "echo", false], "anyone who can send can set the room's options");
  assert.deepEqual(state.listeners, []);

  const listen = (value: boolean, who = "owner") => app.inject({ method: "POST", url: `/channels/${song.id}/playback/listen`, headers: auth(who), payload: { value } });
  assert.deepEqual((await listen(true)).json().listeners, ["owner"]);
  assert.deepEqual((await listen(true, "member")).json().listeners, ["owner", "member"]);
  assert.deepEqual((await listen(true)).json().listeners, ["owner", "member"], "a heartbeat keeps the place");
  assert.deepEqual((await listen(false)).json().listeners, ["member"]);
  const theater = await create("theater", "Telão");
  assert.equal((await app.inject({ method: "POST", url: `/channels/${theater.id}/playback/listen`, headers: auth(), payload: { value: true } })).statusCode, 404);
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

test("code channels only link public https remotes and stay inside the working copy", async (t) => {
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

  // Links to an existing file and directory outside the working copy (portable to Windows).
  const outside = join(directory, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "outside");
  await t.test("file symlinks cannot escape the working copy", async (context) => {
    try { await symlink(join(outside, "secret.txt"), join(directory, "code", code.id, "repo", "leak"), "file"); }
    catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Windows requires Developer Mode or symlink privileges; the junction escape is still tested below.");
        return;
      }
      throw error;
    }
    assert.equal((await app.inject({ url: `/channels/${code.id}/code/file?path=leak`, headers: auth() })).statusCode, 400);
  });
  await symlink(outside, join(directory, "code", code.id, "repo", "escape"), "junction");
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

test("server admins set how long new messages live in a text channel", async () => {
  const text = await create("text", "efemero");
  const voice = await create("voice", "sala-ttl");
  const patch = (id: string, payload: object, user = "owner") => app.inject({ method: "PATCH", url: `/channels/${id}`, headers: auth(user), payload });
  const day = await patch(text.id, { messageTtlMs: 86_400_000 });
  assert.equal(day.statusCode, 200, day.body);
  assert.equal(day.json().messageTtlMs, 86_400_000);
  assert.equal((await patch(text.id, { messageTtlMs: 5_000 })).statusCode, 400);
  assert.equal((await patch(voice.id, { messageTtlMs: 3_600_000 })).statusCode, 400);
  assert.equal((await patch(text.id, { messageTtlMs: 3_600_000 }, "member")).statusCode, 403);
  const permanent = await patch(text.id, { messageTtlMs: null });
  assert.equal(permanent.statusCode, 200);
  assert.equal("messageTtlMs" in permanent.json(), false);
});

test("song rooms can drop played tracks into a history, go back to them and queue them again", async () => {
  const song = await create("song", "Rádio com histórico");
  const act = (payload: object, who = "owner") => app.inject({ method: "POST", url: `/channels/${song.id}/playback`, headers: auth(who), payload });
  for (const n of [1, 2, 3]) await act({ op: "add", url: `https://example.com/${n}.mp3` });
  let state = (await act({ op: "next" })).json();
  const [one, two, three] = state.queue;
  assert.equal(state.currentId, two.id, "off: played tracks stay in the queue");
  // Only whoever manages the room turns it on; that clears what already played.
  assert.equal((await act({ op: "removePlayed", value: true }, "member")).statusCode, 403);
  state = (await act({ op: "removePlayed", value: true })).json();
  assert.deepEqual(state.queue.map((i: { id: string }) => i.id), [two.id, three.id]);
  assert.deepEqual(state.history.map((i: { id: string }) => i.id), [one.id]);
  // A finished track leaves the queue for the history, newest first.
  state = (await act({ op: "ended", itemId: two.id })).json();
  assert.deepEqual([state.currentId, state.queue.length, state.history.map((i: { id: string }) => i.id)], [three.id, 1, [two.id, one.id]]);
  // Back: the last played track returns in front of the current one and plays.
  state = (await act({ op: "previous" })).json();
  assert.deepEqual([state.currentId, state.queue.map((i: { id: string }) => i.id), state.history.map((i: { id: string }) => i.id), state.paused], [two.id, [two.id, three.id], [one.id], false]);
  // Anyone who may add can queue a played track again (a new entry, at the end).
  state = (await act({ op: "requeue", itemId: one.id }, "member")).json();
  assert.equal(state.queue.at(-1).url, one.url);
  assert.notEqual(state.queue.at(-1).id, one.id);
  assert.equal(state.queue.at(-1).addedBy, "member");
  assert.equal((await act({ op: "requeue", itemId: "nope" })).statusCode, 404);
  // A track removed by hand is not "played".
  state = (await act({ op: "remove", itemId: state.currentId })).json();
  assert.ok(!state.history.some((i: { id: string }) => i.id === two.id));
  // Without autoplay the room stops at the end, but the track still leaves the queue.
  await act({ op: "autoplay", value: false });
  state = (await act({ op: "ended", itemId: state.currentId })).json();
  assert.equal(state.paused, true);
  assert.equal(state.history[0].id, three.id);
  // Theater rooms don't have it.
  const theater = await create("theater", "Cinema sem histórico");
  assert.equal((await app.inject({ method: "POST", url: `/channels/${theater.id}/playback`, headers: auth(), payload: { op: "removePlayed", value: true } })).statusCode, 400);
});

test("song rooms pull a whole YouTube playlist from the request field, until the queue is full", async () => {
  const song = await create("song", "Rádio de playlist");
  const act = (payload: object, who = "member") => app.inject({ method: "POST", url: `/channels/${song.id}/playback`, headers: auth(who), payload });
  const id = (n: number) => `vid${String(n).padStart(8, "0")}`;
  const lockups = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ lockupViewModel: { contentId: id(from + i), contentType: "LOCKUP_CONTENT_TYPE_VIDEO", metadata: { lockupMetadataViewModel: { title: { content: `Faixa ${from + i}` } } } } }));
  const more = (token: string) => ({ continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: { token } } } } });
  const page = { header: { pageHeaderRenderer: { content: { metadata: { text: { content: "230 videos" } } } } }, contents: [...lockups(0, 100), more("page2")] };
  const calls: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/playlist?list=PLgood")) return new Response(`<script>var ytInitialData = ${JSON.stringify(page)};</script><script>"INNERTUBE_CLIENT_VERSION":"2.1"</script>`);
    if (url.includes("/youtubei/v1/browse")) {
      const token = JSON.parse(String(init?.body)).continuation;
      return Response.json(token === "page2" ? { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [...lockups(100, 200), more("page3")] } }] } : { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: lockups(200, 230) } }] });
    }
    if (url.includes("oembed")) return Response.json({ title: "Só o vídeo" });
    return new Response("", { status: 404 });
  });
  try {
    // Anyone who may add pulls a playlist, also from music.youtube.com.
    await act({ op: "add", url: "https://example.com/first.mp3" });
    const res = await act({ op: "add", url: "https://music.youtube.com/playlist?list=PLgood" });
    assert.equal(res.statusCode, 200, res.body);
    let state = res.json();
    assert.deepEqual([state.added, state.skipped, state.queue.length], [199, 31, 200]);
    assert.deepEqual([state.queue[1].url, state.queue[1].title, state.queue[1].kind, state.queue[1].addedBy], [`https://www.youtube.com/watch?v=${id(0)}`, "Faixa 0", "youtube", "member"]);
    assert.ok(calls.some((u) => u.includes("/youtubei/v1/browse")), "reads the next pages");
    // A full queue takes nothing more.
    assert.equal((await act({ op: "add", url: "https://www.youtube.com/playlist?list=PLgood" })).statusCode, 400);
    // A list that can't be read: an error, or the video the link also names.
    const other = await create("song", "Rádio vazia");
    const add = (url: string) => app.inject({ method: "POST", url: `/channels/${other.id}/playback`, headers: auth(), payload: { op: "add", url } });
    assert.equal((await add("https://www.youtube.com/playlist?list=PLgone")).statusCode, 400);
    state = (await add("https://www.youtube.com/watch?v=abcdefghijk&list=PLgone")).json();
    assert.deepEqual([state.queue.length, state.queue[0].title, state.added], [1, "Só o vídeo", undefined]);
    // Theater rooms keep taking the link as one item.
    const theater = await create("theater", "Cinema de playlist");
    state = (await app.inject({ method: "POST", url: `/channels/${theater.id}/playback`, headers: auth(), payload: { op: "add", url: "https://www.youtube.com/playlist?list=PLgood" } })).json();
    assert.equal(state.queue.length, 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test("song rooms have a random mode and a one-time shuffle that can go back to the original order", async () => {
  const song = await create("song", "Rádio aleatória");
  const act = (payload: object, who = "owner") => app.inject({ method: "POST", url: `/channels/${song.id}/playback`, headers: auth(who), payload });
  for (let n = 0; n < 8; n++) await act({ op: "add", url: `https://example.com/${n}.mp3` });
  let state = (await act({ op: "autoplay", value: true })).json();
  const order = state.queue.map((i: { id: string }) => i.id);
  // Only whoever manages the room uses them; theater rooms don't have them.
  for (const op of [{ op: "shuffle", value: true }, { op: "shuffleQueue" }, { op: "unshuffle" }]) assert.equal((await act(op, "member")).statusCode, 403);
  const theater = await create("theater", "Cinema aleatório");
  assert.equal((await app.inject({ method: "POST", url: `/channels/${theater.id}/playback`, headers: auth(), payload: { op: "shuffle", value: true } })).statusCode, 400);

  // Embaralhar: the tracks after the current one change places; the original order is kept.
  state = (await act({ op: "shuffleQueue" })).json();
  assert.equal(state.queue[0].id, order[0], "the current track stays");
  assert.deepEqual([...state.queue.map((i: { id: string }) => i.id)].sort(), [...order].sort());
  assert.deepEqual(state.originalOrder, order);
  // A second shuffle still remembers the first order; a new track joins it at the end.
  await act({ op: "shuffleQueue" });
  state = (await act({ op: "add", url: "https://example.com/late.mp3" })).json();
  const late = state.queue.at(-1).id;
  assert.deepEqual(state.originalOrder, [...order, late]);
  state = (await act({ op: "unshuffle" })).json();
  assert.deepEqual(state.queue.map((i: { id: string }) => i.id), [...order, late]);
  assert.equal(state.originalOrder, null);

  // Random mode: the queue keeps its order, the next track is drawn ahead from those not played.
  state = (await act({ op: "shuffle", value: true })).json();
  assert.deepEqual(state.queue.map((i: { id: string }) => i.id), [...order, late]);
  const seen = [state.currentId];
  for (let n = 0; n < 8; n++) {
    const next = state.upNextId;
    assert.ok(next && !seen.includes(next), "draws a track that did not play in this round");
    state = (await act({ op: "ended", itemId: state.currentId })).json();
    assert.equal(state.currentId, next, "plays the drawn track");
    seen.push(next);
  }
  assert.equal(state.upNextId, null, "all played: the round ends after this one");
  // Back: the track that played before, and the one left behind is next again.
  const leaving = state.currentId;
  state = (await act({ op: "previous" })).json();
  assert.deepEqual([state.currentId, state.upNextId], [seen.at(-2), leaving]);
  // Off: the next track is the one below in the queue again.
  state = (await act({ op: "shuffle", value: false })).json();
  assert.deepEqual([state.shuffle, state.upNextId, state.played], [false, null, []]);
});
