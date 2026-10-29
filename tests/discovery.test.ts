import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { once } from "node:events";
const root = resolve(tmpdir()),
  directory = await mkdtemp(join(root, "distopic-discovery-"));
process.env.ANNOY_DATA_DIR = directory;
process.env.DISTOPIC_DATA_DIR = directory;
const { db, run } = await import("../src/db.ts"),
  { createSession } = await import("../src/auth.ts"),
  { searchRoutes } = await import("../src/routes/search.ts"),
  { socialRoutes } = await import("../src/routes/social.ts"),
  { registerGateway } = await import("../src/gateway.ts"),
  { HttpError } = await import("../src/errors.ts"),
  { Permission } = await import("@distopic/protocol");
const app = Fastify();
await app.register(websocket);
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : 500).send({ message: (e as Error).message }));
searchRoutes(app);
socialRoutes(app);
registerGateway(app);
const users = ["alice", "bob", "stranger"],
  tokens: Record<string, string> = {};
for (const id of users) {
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (?,?,?,'!','2026-01-01')", id, id, id);
  tokens[id] = createSession(id);
}
run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Test','alice','2026-01-01')");
for (const id of users) run("INSERT INTO members(server_id,user_id,joined_at) VALUES('server',?,'2026-01-01')", id);
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
test("real gateway sends activity only to mutual friends, clears on unfriend/disconnect and restores on accept", async (t) => {
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
  const activity = { kind: "game", provider: "steam", name: "Synthetic Game", appId: "480" };
  sockets.alice.send(JSON.stringify({ op: "activity", activities: [activity] }));
  await waitFor(() => streams.bob!.some((e) => e.t === "ACTIVITY_UPDATE" && e.d.activities.length === 1));
  assert.equal(
    streams.stranger!.some((e) => e.t === "ACTIVITY_UPDATE"),
    false,
  );
  assert.equal(streams.stranger!.find((e) => e.t === "READY").d.activities.alice, undefined);
  await app.inject({ method: "DELETE", url: "/relationships/alice", headers: auth("bob") });
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
