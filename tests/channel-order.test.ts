import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

const directory = await mkdtemp(join(tmpdir(), "annoy-channel-order-"));
process.env.ANNOY_ACCOUNT_MODE = "local";
process.env.ANNOY_DATA_DIR = directory;

const { db, run } = await import("../src/db.ts");
const { createSession } = await import("../src/auth.ts");
const { serverRoutes } = await import("../src/routes/servers.ts");
const { channelRoutes } = await import("../src/routes/channels.ts");
const { tempRoomRoutes } = await import("../src/rooms.ts");
const { getChannels } = await import("../src/repo.ts");
const { HttpError } = await import("../src/errors.ts");
const { DEFAULT_EVERYONE_PERMISSIONS } = await import("@annoy/protocol");

const app = Fastify();
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : ((e as { statusCode?: number }).statusCode ?? 500)).send({ message: (e as Error).message, code: (e as { code?: string }).code }));
serverRoutes(app);
channelRoutes(app);
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
const post = (url: string, payload: object, who = "owner") => app.inject({ method: "POST", url, headers: auth(who), payload });
const create = async (type: string, name: string, parentId: string | null = null) => {
  const res = await post("/servers/s/channels", { name, type, parentId });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { id: string }).id;
};
/** The list as the sidebar draws it: loose rooms, then each category with its rooms. */
const layout = () => {
  const channels = getChannels("s").sort((a, b) => a.position - b.position);
  return [
    ...channels.filter((c) => c.type !== "category" && !c.parentId).map((c) => c.name),
    ...channels.filter((c) => c.type === "category").map((cat) => `${cat.name}: ${channels.filter((c) => c.parentId === cat.id).map((c) => c.name).join(", ")}`),
  ];
};
after(async () => {
  await app.close();
  db.close();
  await rm(directory, { recursive: true, force: true });
});

const text = await create("category", "Texto");
const voice = await create("category", "Voz");
const geral = await create("text", "geral", text);
const memes = await create("text", "memes", text);
const regras = await create("text", "regras", text);
const sala = await create("voice", "Sala", voice);
const jogo = await create("voice", "Jogo", voice);
let vazia = "";

test("rooms move before another room, to the end of a category, and categories move among themselves", async () => {
  assert.deepEqual(layout(), ["Texto: geral, memes, regras", "Voz: Sala, Jogo"]);
  assert.equal((await post(`/channels/${regras}/move`, { beforeId: geral })).statusCode, 200);
  assert.deepEqual(layout(), ["Texto: regras, geral, memes", "Voz: Sala, Jogo"]);
  await post(`/channels/${jogo}/move`, { beforeId: sala });
  assert.deepEqual(layout(), ["Texto: regras, geral, memes", "Voz: Jogo, Sala"]);
  // Into another category (at its end), then out of every category.
  await post(`/channels/${memes}/move`, { parentId: voice, beforeId: null });
  assert.deepEqual(layout(), ["Texto: regras, geral", "Voz: Jogo, Sala, memes"]);
  await post(`/channels/${memes}/move`, { parentId: null, beforeId: null });
  assert.deepEqual(layout(), ["memes", "Texto: regras, geral", "Voz: Jogo, Sala"]);
  await post(`/channels/${voice}/move`, { beforeId: text });
  assert.deepEqual(layout(), ["memes", "Voz: Jogo, Sala", "Texto: regras, geral"]);
  await post(`/channels/${memes}/move`, { parentId: text, beforeId: geral });
  assert.deepEqual(layout(), ["Voz: Jogo, Sala", "Texto: regras, memes, geral"]);
  // An empty category takes a room right after itself.
  vazia = await create("category", "Vazia");
  await post(`/channels/${geral}/move`, { parentId: vazia, beforeId: null });
  assert.deepEqual(layout(), ["Voz: Jogo, Sala", "Texto: regras, memes", "Vazia: geral"]);
  const positions = getChannels("s").map((c) => c.position).sort((a, b) => a - b);
  assert.deepEqual(positions, positions.map((_, i) => i), "positions renumbered");
});

test("moves are checked: permission, the target place and the kind of row", async () => {
  assert.equal((await post(`/channels/${sala}/move`, { beforeId: null }, "member")).statusCode, 403);
  assert.equal((await post(`/channels/${sala}/move`, { beforeId: regras })).statusCode, 400, "before a room of another category");
  assert.equal((await post(`/channels/${sala}/move`, { beforeId: text })).statusCode, 400, "a room before a category");
  assert.equal((await post(`/channels/${text}/move`, { beforeId: sala })).statusCode, 400, "a category before a room");
  assert.equal((await post(`/channels/${sala}/move`, { parentId: sala, beforeId: null })).statusCode, 400, "a room as category");
  assert.equal((await post(`/channels/${sala}/move`, { beforeId: sala })).statusCode, 400);
  assert.equal((await post(`/channels/${sala}/move`, { beforeId: "nope" })).statusCode, 400);
});

test("names are unique per type and place; other types, places and temporary rooms may repeat them", async () => {
  const taken = await post("/servers/s/channels", { name: "Regras", type: "text", parentId: text });
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.json().code, "channel_name_taken");
  assert.equal((await post("/servers/s/channels", { name: "texto", type: "category" })).statusCode, 409, "categories, case aside");
  await create("voice", "regras", text);
  await create("text", "regras", voice);
  await create("files", "regras", text);
  // Renaming onto a taken name, or moving into a category that has the name, is refused.
  const outro = await create("text", "outro", text);
  assert.equal((await app.inject({ method: "PATCH", url: `/channels/${outro}`, headers: auth(), payload: { name: "memes" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "PATCH", url: `/channels/${outro}`, headers: auth(), payload: { name: "outro", topic: "x" } })).statusCode, 200, "its own name");
  const segundo = await create("text", "geral", text);
  assert.equal((await post(`/channels/${segundo}/move`, { parentId: vazia, beforeId: null })).statusCode, 409);
  assert.equal((await post(`/channels/${segundo}/move`, { beforeId: regras })).statusCode, 200, "moving within its category");
  // Rooms that already shared a name (made before this rule) stay editable.
  run("INSERT INTO channels (id, server_id, type, name, topic, parent_id, position, created_at) VALUES ('old-twin', 's', 'text', 'memes', '', ?, 99, '2026-01-01')", text);
  assert.equal((await app.inject({ method: "PATCH", url: "/channels/old-twin", headers: auth(), payload: { name: "memes", topic: "ainda editável" } })).statusCode, 200);
  const temp = await post("/servers/s/temp-rooms", { name: "Sala", parentId: voice });
  assert.equal(temp.statusCode, 200, temp.body);
});
