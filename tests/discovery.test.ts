import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { once } from "node:events";
import sharp from "sharp";
const root = resolve(tmpdir()),
  directory = await mkdtemp(join(root, "distopic-discovery-"));
process.env.ANNOY_DATA_DIR = directory;
process.env.DISTOPIC_DATA_DIR = directory;
const { db, run } = await import("../src/db.ts"),
  { createSession } = await import("../src/auth.ts"),
  { searchRoutes } = await import("../src/routes/search.ts"),
  { socialRoutes } = await import("../src/routes/social.ts"),
  { authRoutes } = await import("../src/routes/auth.ts"),
  { callRoutes } = await import("../src/calls.ts"),
  { registerGateway } = await import("../src/gateway.ts"),
  { HttpError } = await import("../src/errors.ts"),
  { Permission } = await import("@distopic/protocol");
const app = Fastify();
await app.register(websocket);
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : 500).send({ message: (e as Error).message }));
searchRoutes(app);
socialRoutes(app);
authRoutes(app);
callRoutes(app);
registerGateway(app);
const users = ["alice", "bob", "stranger", "outsider"],
  tokens: Record<string, string> = {};
for (const id of users) {
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (?,?,?,'!','2026-01-01')", id, id, id);
  tokens[id] = createSession(id);
}
run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Test','alice','2026-01-01')");
for (const id of users.filter((id) => id !== "outsider")) run("INSERT INTO members(server_id,user_id,joined_at) VALUES('server',?,'2026-01-01')", id);
run(
  "INSERT INTO roles(id,server_id,name,permissions,position) VALUES('server','server','everyone',?,0)",
  Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
);
for (const id of ["public", "private"])
  run("INSERT INTO channels(id,server_id,type,name,created_at) VALUES(?,'server','text',?,'2026-01-01')", id, id);
run(
  "INSERT INTO overwrites(channel_id,target_id,target_type,allow,deny) VALUES('private','stranger','member',0,?)",
  Permission.VIEW_CHANNEL,
);
for (const [a, b] of [
  ["alice", "bob"],
  ["bob", "alice"],
])
  run("INSERT INTO relationships(user_id,other_id,status) VALUES(?,?,'friend')", a!, b!);
for (const [id, channel, author, content] of [
  ["001", "public", "alice", "Planejamento café"],
  ["002", "private", "alice", "Planejamento secreto"],
  ["003", "public", "bob", "Planejamento vídeo"],
])
  run(
    "INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)",
    id!,
    channel!,
    author!,
    content!,
    "2026-10-28T15:00:00.000Z",
  );
run("INSERT INTO attachments(id,message_id,filename,size,content_type) VALUES('file','003','video.webm',10,'video/webm')");
const auth = (user: string) => ({ authorization: `Bearer ${tokens[user]}` });
after(async () => {
  await app.close();
  // Gateway sockets emit "close" after app.close resolves; their handlers still read the database.
  await new Promise((resolve) => setTimeout(resolve, 100));
  db.close();
  if (dirname(directory) !== root || !basename(directory).startsWith("distopic-discovery-")) throw new Error("Unsafe temp path");
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
test("search enforces channel membership, hidden channels, filters and index updates", async () => {
  assert.equal((await app.inject({ url: "/search/messages?q=planejamento" })).statusCode, 401);
  const search = async (user: string, query: string) => app.inject({ url: `/search/messages?${query}`, headers: auth(user) });
  assert.deepEqual(
    (await search("stranger", "q=planejamento")).json().items.map((r: any) => r.message.id),
    ["003", "001"],
  );
  assert.equal((await search("stranger", "q=secreto&channelId=private")).statusCode, 404);
  assert.deepEqual(
    (await search("bob", "q=planejamento&has=video&authorId=bob")).json().items.map((r: any) => r.message.id),
    ["003"],
  );
  assert.equal((await search("bob", "q=cafe")).json().items[0].message.id, "001");
  run("UPDATE messages SET content='Atualização do índice' WHERE id='001'");
  assert.equal((await search("bob", "q=cafe")).json().items.length, 0);
  assert.equal((await search("bob", "q=atualizacao")).json().items[0].message.id, "001");
  run("DELETE FROM messages WHERE id='001'");
  assert.equal((await search("bob", "q=atualizacao")).json().items.length, 0);
  assert.equal((await search("stranger", "q=planejamento&before=2026-01-01")).json().items.length, 0);
  assert.equal((await search("bob", 'q="%20OR%20*')).statusCode, 200);
});
test("real gateway shares activity with friends and server peers, revokes on last shared membership and restores on accept", async (t) => {
  const streams: Record<string, any[]> = {},
    sockets: Record<string, any> = {};
  t.after(async () => {
    await Promise.all(
      Object.values(sockets).map(async (socket) => {
        if (socket.readyState === WebSocket.CLOSED) return;
        const closed = once(socket, "close");
        socket.terminate();
        await closed;
      }),
    );
  });
  const waitFor = async (check: () => boolean) => {
    const until = Date.now() + 2500;
    while (!check()) {
      if (Date.now() > until) throw new Error(`Event timeout: ${JSON.stringify(streams)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  for (const id of users) {
    streams[id] = [];
    const socket = new WebSocket(`${address.replace("http:", "ws:")}/gateway`);
    sockets[id] = socket;
    socket.on("message", (raw: Buffer) => streams[id]!.push(JSON.parse(raw.toString())));
    await once(socket, "open");
    socket.send(JSON.stringify({ op: "identify", token: tokens[id] }));
    await waitFor(() => streams[id]!.some((e) => e.t === "READY"));
  }
  assert.equal(streams.alice!.find((event) => event.t === "READY").d.instance.activityArtwork, true);
  const activity = { kind: "game", provider: "steam", name: "Synthetic Game", appId: "480", artwork: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/480/header.jpg" };
  sockets.alice.send(JSON.stringify({ op: "activity", activities: [activity] }));
  await waitFor(() => streams.bob!.some((e) => e.t === "ACTIVITY_UPDATE" && e.d.activities.length === 1));
  const cover = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ab5342" } }).jpeg().toBuffer();
  const music = { kind: "music", provider: "spotify", name: "Synthetic Song", artist: "Artist", artwork: `data:image/jpeg;base64,${cover.toString("base64")}` };
  sockets.alice.send(JSON.stringify({ op: "activity", activities: [activity, music] }));
  await waitFor(() => streams.bob!.some((e) => e.t === "ACTIVITY_UPDATE" && e.d.activities.length === 2));
  const received = streams.bob!.find((e) => e.t === "ACTIVITY_UPDATE" && e.d.activities.length === 2).d.activities;
  assert.equal(received[0].artwork, activity.artwork);
  assert.equal(received[1].artwork, music.artwork);
  await waitFor(() => streams.stranger!.some((e) => e.t === "ACTIVITY_UPDATE" && e.d.userId === "alice" && e.d.activities.length === 2));
  assert.equal(streams.stranger!.find((e) => e.t === "READY").d.instance.groupActivity, true);
  assert.equal(streams.outsider!.some((e) => e.t === "ACTIVITY_UPDATE"), false);
  assert.equal(streams.outsider!.find((e) => e.t === "READY").d.activities.alice, undefined);
  await app.inject({ method: "DELETE", url: "/relationships/alice", headers: auth("bob") });
  await waitFor(() => streams.bob!.some((e) => e.t === "RELATIONSHIP_REMOVE"));
  assert.equal(streams.bob!.filter((e) => e.t === "ACTIVITY_UPDATE").at(-1).d.activities.length, 2);
  run("DELETE FROM members WHERE server_id='server' AND user_id='bob'");
  const { refreshActivityAccess } = await import("../src/activity.ts"); refreshActivityAccess();
  await waitFor(() => streams.bob!.some((e) => e.t === "ACTIVITY_UPDATE" && e.d.userId === "alice" && e.d.activities.length === 0));
  streams.bob = [];
  sockets.alice.send(JSON.stringify({ op: "activity", activities: [{ ...activity, name: "Changed game" }] }));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(
    streams.bob.some((e) => e.t === "ACTIVITY_UPDATE"),
    false,
  );
  await app.inject({ method: "POST", url: "/relationships", headers: auth("bob"), payload: { username: "alice" } });
  await app.inject({ method: "PUT", url: "/relationships/bob", headers: auth("alice") });
  await waitFor(() => streams.bob.some((e) => e.t === "ACTIVITY_UPDATE" && e.d.activities[0]?.name === "Changed game"));
  const accepted=streams.bob.findIndex(e=>e.t==="RELATIONSHIP_UPDATE"&&e.d.status==="friend");
  const restored=streams.bob.findIndex(e=>e.t==="ACTIVITY_UPDATE"&&e.d.activities[0]?.name==="Changed game");
  assert.ok(accepted>=0&&restored>accepted,"Relationship is delivered before private activity, so the client can authorize rendering");
  streams.bob = [];
  sockets.alice.close();
  await waitFor(() => streams.bob.some((e) => e.t === "ACTIVITY_UPDATE" && e.d.userId === "alice" && e.d.activities.length === 0));
  for (const socket of Object.values(sockets)) socket.close();
});

test("activity artwork rejects oversized images, executable data and non-Steam remote hosts", async () => {
  const { updateActivity } = await import("../src/activity.ts");
  const invalid = [
    { kind: "music", provider: "spotify", name: "Test", artwork: "data:image/svg+xml;base64,PHN2Zz4=" },
    { kind: "music", provider: "spotify", name: "Test", artwork: "data:image/jpeg;base64,/9j/" + "A".repeat(24_000) },
    { kind: "music", provider: "spotify", name: "Test", artwork: "https://example.com/cover.jpg" },
    { kind: "game", provider: "steam", name: "Test", appId: "480", artwork: "https://steamstatic.com.example.com/steam/apps/480/header.jpg" },
    { kind: "game", provider: "steam", name: "Test", appId: "480", artwork: "file:///local/image.jpg" },
  ];
  for (const activity of invalid) assert.equal(updateActivity({ userId: "alice", activityWindowAt: 0, activityCount: 0 } as any, [activity]), false);
});

test("manual presence is shared with self and friends, keeps idle overrides and hides invisible activity", async (t) => {
  if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as { port: number };
  const sockets: WebSocket[] = [], events: Record<string, any[]> = {};
  t.after(() => sockets.forEach((socket) => socket.terminate()));
  const waitFor = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error("Timed out waiting for manual presence"); await new Promise((resolve) => setTimeout(resolve, 10)); } };
  const connect = async (id: string, user: string, presence = "online") => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/gateway`); sockets.push(socket); events[id] = [];
    socket.on("message", (raw) => events[id]!.push(JSON.parse(raw.toString())));
    await once(socket, "open"); socket.send(JSON.stringify({ op: "identify", token: tokens[user], presence, features: ["manualPresence", "idlePresence", "developmentActivity"] }));
    await waitFor(() => events[id]!.some((event) => event.t === "READY")); return socket;
  };
  const alice = await connect("alice", "alice");
  await connect("bob", "bob");
  const { presenceOf } = await import("../src/presence.ts");
  const { activityOf } = await import("../src/activity.ts");
  alice.send(JSON.stringify({ op: "activity", activities: [{ kind: "development", provider: "vscode", name: "Annoy", file: "package.json", language: "json" }] }));
  await waitFor(() => activityOf("alice").length === 1);
  alice.send(JSON.stringify({ op: "presence", idle: false, status: "idle" }));
  await waitFor(() => presenceOf("alice") === "idle");
  alice.send(JSON.stringify({ op: "presence", idle: false }));
  alice.send(JSON.stringify({ op: "presence", idle: true, status: "dnd" }));
  await waitFor(() => events.bob!.some((event) => event.t === "PRESENCE_UPDATE" && event.d.userId === "alice" && event.d.presence === "dnd"));
  assert.ok(events.alice!.some((event) => event.t === "PRESENCE_UPDATE" && event.d.presence === "dnd"));
  alice.send(JSON.stringify({ op: "presence", idle: false, status: "offline" }));
  await waitFor(() => events.bob!.some((event) => event.t === "ACTIVITY_UPDATE" && event.d.userId === "alice" && event.d.activities.length === 0));
  assert.equal(presenceOf("alice"), "offline"); assert.deepEqual(activityOf("alice"), []);
  const observer = await connect("bob2", "bob");
  const ready = events.bob2!.find((event) => event.t === "READY");
  assert.equal(ready.d.presences.alice, "offline"); assert.deepEqual(ready.d.activities.alice, []);
  events.bob = [];
  alice.send(JSON.stringify({ op: "presence", idle: false, status: "online" }));
  await waitFor(() => presenceOf("alice") === "online" && events.bob!.some((event) => event.t === "ACTIVITY_UPDATE" && event.d.userId === "alice" && event.d.activities.length === 1));
  observer.close();
});

test("biographies and friend nicknames persist, validate and expose both directions", async () => {
  assert.equal((await app.inject({ method: "PATCH", url: "/users/@me", headers: auth("alice"), payload: { bio: "A".repeat(1000) } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: "/users/@me", headers: auth("alice"), payload: { bio: "A".repeat(1001) } })).statusCode, 400);
  const me = await app.inject({ method: "GET", url: "/users/@me", headers: auth("alice") });
  assert.equal(me.json().bio.length, 1000);
  const nickname = await app.inject({ method: "PATCH", url: "/relationships/bob/nickname", headers: auth("alice"), payload: { nickname: "Bobby" } });
  assert.equal(nickname.statusCode, 200);
  const bob = (await app.inject({ method: "GET", url: "/relationships", headers: auth("bob") })).json();
  assert.equal(bob.find((r: any) => r.user.id === "alice").nicknameByOther, "Bobby");
  assert.equal((await app.inject({ method: "PATCH", url: "/relationships/stranger/nickname", headers: auth("alice"), payload: { nickname: "No" } })).statusCode, 403);
});

test("private calls authorize friends, isolate signaling and end on disconnect; idle respects multiple sessions", async (t) => {
  if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as { port: number };
  const sockets: Record<string, WebSocket> = {}, streams: Record<string, any[]> = {};
  t.after(() => Object.values(sockets).forEach((socket) => socket.terminate()));
  const waitFor = async (check: () => boolean) => { const until = Date.now() + 3000; while (!check()) { if (Date.now() > until) throw new Error("Timed out waiting for call event"); await new Promise((resolve) => setTimeout(resolve, 10)); } };
  for (const id of ["alice", "bob", "stranger", "alice2"]) {
    streams[id] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/gateway`); sockets[id] = socket;
    socket.on("message", (raw) => streams[id]!.push(JSON.parse(raw.toString())));
    await once(socket, "open"); socket.send(JSON.stringify({ op: "identify", features: ["developmentActivity", "idlePresence", "directCalls"], deviceId: id === "alice" ? "a" : id === "bob" ? "b" : id, token: tokens[id === "alice2" ? "alice" : id] }));
    await waitFor(() => streams[id]!.some((event) => event.t === "READY"));
  }
  const { presenceOf } = await import("../src/presence.ts");
  sockets.alice!.send(JSON.stringify({ op: "presence", idle: true }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(presenceOf("alice"), "online");
  sockets.alice2!.send(JSON.stringify({ op: "presence", idle: true }));
  await waitFor(() => presenceOf("alice") === "idle");
  sockets.alice!.send(JSON.stringify({ op: "presence", idle: false }));
  await waitFor(() => presenceOf("alice") === "online");
  assert.equal((await app.inject({ method: "POST", url: "/calls", headers: auth("alice"), payload: { userId: "stranger", video: false, deviceId: "a" } })).statusCode, 403);
  const result = await app.inject({ method: "POST", url: "/calls", headers: auth("alice"), payload: { userId: "bob", video: true, deviceId: "a" } });
  assert.equal(result.statusCode, 200);
  const call = result.json();
  await waitFor(() => streams.bob!.some((event) => event.t === "CALL_UPDATE" && event.d.status === "ringing"));
  sockets.stranger!.send(JSON.stringify({ op: "call", callId: call.id, action: "accept", deviceId: "s" }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(streams.alice!.some((event) => event.t === "CALL_UPDATE" && event.d.status === "active"), false);
  sockets.bob!.send(JSON.stringify({ op: "call", callId: call.id, action: "accept", deviceId: "b" }));
  await waitFor(() => streams.alice!.some((event) => event.t === "CALL_UPDATE" && event.d.status === "active"));
  sockets.alice!.send(JSON.stringify({ op: "call", callId: call.id, action: "signal", deviceId: "wrong-device", signal: { description: { type: "offer", sdp: "wrong" } } }));
  sockets.alice!.send(JSON.stringify({ op: "call", callId: call.id, action: "signal", deviceId: "a", signal: { description: { type: "offer", sdp: "synthetic-offer" } } }));
  await waitFor(() => streams.bob!.some((event) => event.t === "CALL_SIGNAL"));
  assert.equal(streams.bob!.find((event) => event.t === "CALL_SIGNAL").d.signal.description.sdp, "synthetic-offer");
  assert.equal(streams.stranger!.some((event) => event.t.startsWith("CALL_")), false);
  sockets.bob!.close();
  await waitFor(() => streams.alice!.some((event) => event.t === "CALL_UPDATE" && event.d.status === "ended"));
});
