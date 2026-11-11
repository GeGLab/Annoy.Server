import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

// A stand-in for the store (devannoy): two published integrations.
const catalog: Record<string, unknown> = {
  eco: {
    id: "eco", name: "Eco", summary: "Repete", description: "", website: null, privacyUrl: null, icon: "https://dev.example/v1/store/integrations/eco/icon?v=1",
    developer: { id: "D0000000000A", name: "Ana" }, verified: false, firstParty: false, scopes: ["dm", "server"], key: { required: true },
    runtime: { type: "http", endpoint: "https://eco.example/annoy" }, commands: [{ name: "eco", description: "Repete", usage: "<texto>" }], mention: true,
    access: { history: true, attachments: false }, settings: [{ key: "idioma", label: "Idioma", type: "select", required: true, options: ["pt", "en"] }], updatedAt: "2026-11-11T00:00:00.000Z",
  },
  painel: {
    id: "painel", name: "Painel", summary: "Só perfil", description: "", website: null, privacyUrl: null, icon: null, developer: { id: "D0000000000A", name: "Ana" }, verified: false, firstParty: false,
    scopes: [], key: { required: false }, runtime: { type: "none" }, commands: [], mention: false, access: { history: false, attachments: false }, settings: [],
    profile: { connection: "steam", image: "https://eco.example/card.png?id={id}" }, updatedAt: "2026-11-11T00:00:00.000Z",
  },
};
const devCalls: { url: string; auth: string | undefined; body: any }[] = [];
const store = createServer(async (req, res) => {
  if (req.url?.startsWith("/v1/calls/") || req.url?.startsWith("/v1/servers/connections/")) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    devCalls.push({ url: `${req.method} ${req.url}`, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    const signed = req.url === "/v1/calls/sign" && req.headers.authorization === "Server S1:segredo";
    return void res.writeHead(signed || req.url !== "/v1/calls/sign" ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(signed ? { timestamp: 1700000000, signature: "c2lnbg==", keyId: "k1" } : {}));
  }
  const entry = catalog[/^\/v1\/store\/integrations\/([a-z-]+)$/.exec(req.url ?? "")?.[1] ?? ""];
  res.writeHead(entry ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(entry ?? { error: "not_found" }));
});
await new Promise<void>((r) => store.listen(0, "127.0.0.1", r));

const directory = await mkdtemp(join(tmpdir(), "annoy-integrations-"));
Object.assign(process.env, { ANNOY_ACCOUNT_MODE: "global", ANNOY_DATA_DIR: directory, ANNOY_STORE_URL: `http://127.0.0.1:${(store.address() as AddressInfo).port}` });
const { db, run, all } = await import("../src/db.ts");
const { createSession } = await import("../src/auth.ts");
const { HttpError } = await import("../src/errors.ts");
const { integrationRoutes } = await import("../src/routes/integrations.ts");
const { channelRoutes } = await import("../src/routes/channels.ts");
const { transport } = await import("../src/integrations.ts");
const { DEFAULT_EVERYONE_PERMISSIONS, Permission } = await import("@annoy/protocol");

const app = Fastify();
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : 500).send({ message: (e as Error).message }));
await app.register((await import("@fastify/multipart")).default);
integrationRoutes(app);
channelRoutes(app);
const tokens: Record<string, string> = {};
for (const id of ["owner", "member", "guest"]) {
  run("INSERT INTO users(id,username,display_name,password_hash,created_at,global_id) VALUES(?,?,?,'!','2026-01-01',?)", id, id, id === "member" ? "Bia" : id, `global-${id}`);
  tokens[id] = createSession(id);
}
run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('s','s','owner','2026-01-01')");
run("INSERT INTO roles(id,server_id,name,permissions,position) VALUES('s','s','everyone',?,0)", DEFAULT_EVERYONE_PERMISSIONS);
run("INSERT INTO roles(id,server_id,name,permissions,position) VALUES('r','s','bots',?,1)", Permission.USE_INTEGRATIONS);
for (const member of ["owner", "member", "guest"]) run("INSERT INTO members(server_id,user_id,joined_at) VALUES('s',?,'2026-01-01')", member);
run("INSERT INTO member_roles(server_id,user_id,role_id) VALUES('s','member','r')");
run("INSERT INTO channels(id,server_id,type,name,position,created_at) VALUES('c','s','text','geral',0,'2026-01-01')");
const auth = (id: string) => ({ authorization: `Bearer ${tokens[id]}` });
after(async () => { await app.close(); store.close(); db.close(); await rm(directory, { recursive: true, force: true }); });

// The integration endpoint as the transport sees it.
const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { text: "pong" } };
transport.http = async (request) => {
  calls.push({ url: request.url, headers: request.headers, body: request.body ? JSON.parse(request.body) : null });
  return { status: answer.status, type: "application/json", body: Buffer.from(JSON.stringify(answer.body)) };
};
const say = async (who: string, content: string) => {
  const res = await app.inject({ method: "POST", url: "/channels/c/messages", headers: auth(who), payload: { content } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};
const settle = () => new Promise((r) => setTimeout(r, 80));
const replies = () => all<{ content: string; author_id: string; integration: string | null; reply_to_id: string | null }>("SELECT content, author_id, integration, reply_to_id FROM messages WHERE integration IS NOT NULL ORDER BY id");

test("only the owner installs; the key and required settings are needed; the key is never listed", async () => {
  const put = (who: string, id: string, payload: unknown) => app.inject({ method: "PUT", url: `/servers/s/integrations/${id}`, headers: auth(who), payload: payload as object });
  assert.equal((await put("member", "eco", { apiKey: "k", settings: { idioma: "pt" } })).statusCode, 403);
  assert.equal((await put("owner", "eco", { settings: { idioma: "pt" } })).statusCode, 400);
  assert.equal((await put("owner", "eco", { apiKey: "secret-key", settings: { idioma: "xx" } })).statusCode, 400);
  assert.equal((await put("owner", "nope", { apiKey: "k" })).statusCode, 404);
  assert.equal((await put("owner", "painel", {})).statusCode, 400);
  const saved = await put("owner", "eco", { apiKey: "secret-key", settings: { idioma: "pt", extra: "x" } });
  assert.equal(saved.statusCode, 200, saved.body);
  const listed = (await app.inject({ url: "/servers/s/integrations", headers: auth("member") })).json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].integration.id, "eco");
  assert.equal(listed[0].hasKey, true);
  assert.deepEqual(listed[0].settings, { idioma: "pt" });
  assert.ok(!JSON.stringify(listed).includes("secret-key"));
  // Changing settings keeps the saved key.
  assert.equal((await put("owner", "eco", { settings: { idioma: "en" } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/servers/s/integrations", headers: auth("owner") })).json()[0].hasKey, true);
});

test("a member with the permission calls it; the answer is posted as the integration", async () => {
  await say("owner", "primeira mensagem");
  const calling = await say("member", "/eco olá mundo");
  await settle();
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "https://eco.example/annoy");
  assert.equal(call.headers.authorization, "Bearer secret-key");
  assert.equal(call.headers["x-annoy-integration"], "eco");
  assert.deepEqual({ ...call.body, history: undefined }, { v: 1, type: "command", command: "eco", text: "olá mundo", scope: "server", locale: "pt-BR", invoker: { name: "Bia" }, settings: { idioma: "en" }, history: undefined });
  assert.deepEqual(call.body.history.map((h: any) => [h.author.name, h.text]), [["owner", "primeira mensagem"]]);
  assert.ok(!JSON.stringify(call.body).includes("member"), "no account identifiers leave the server");
  const [reply] = replies();
  assert.equal(reply!.content, "pong");
  assert.equal(reply!.author_id, "member");
  assert.equal(reply!.reply_to_id, calling.id);
  assert.deepEqual(JSON.parse(reply!.integration!), { id: "eco", name: "Eco", iconUrl: "https://dev.example/v1/store/integrations/eco/icon?v=1" });
  const listed = (await app.inject({ url: "/channels/c/messages", headers: auth("guest") })).json();
  assert.equal(listed.at(-1).integration.name, "Eco");
  const edit = await app.inject({ method: "PATCH", url: `/channels/c/messages/${listed.at(-1).id}`, headers: auth("member"), payload: { content: "forjado" } });
  assert.equal(edit.statusCode, 403);
});

test("mention calls it too; the integration's own answers go back as its history", async () => {
  await say("member", "e agora, @eco?");
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.body.type, "mention");
  assert.equal(calls[1]!.body.text, "e agora, ?");
  assert.deepEqual(calls[1]!.body.history.at(-1), { author: { name: "Eco", self: true }, text: "pong", at: calls[1]!.body.history.at(-1).at });
});

test("without the permission nothing is called; an integration's answer never calls another", async () => {
  await say("guest", "/eco oi");
  answer = { status: 200, body: { text: "/eco de novo" } };
  await say("member", "/eco laço");
  await settle();
  assert.equal(calls.length, 3);
  assert.equal(replies().at(-1)!.content, "/eco de novo");
});

test("errors are shown in the channel: the integration's own text, or Annoy's", async () => {
  answer = { status: 500, body: { error: "Sem crédito na conta." } };
  await say("member", "/eco erro");
  await settle();
  assert.equal(replies().at(-1)!.content, "Sem crédito na conta.");
  answer = { status: 200, body: {} };
  await say("member", "/eco vazio");
  await settle();
  assert.equal(replies().at(-1)!.content, "A integração não tinha o que responder.");
  transport.http = async () => { throw new Error("offline"); };
  await say("member", "/eco fora");
  await settle();
  assert.equal(replies().at(-1)!.content, "A integração não respondeu.");
});

test("images come as attachments, checked by their bytes", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  transport.http = async (request) =>
    request.method === "GET"
      ? { status: 200, type: "image/png", body: png }
      : { status: 200, type: "application/json", body: Buffer.from(JSON.stringify({ images: [{ url: "https://eco.example/a.png" }, { data: png.toString("base64"), name: "../b.exe" }] })) };
  await say("member", "/eco imagem");
  await settle();
  const message = (await app.inject({ url: "/channels/c/messages", headers: auth("owner") })).json().at(-1);
  assert.equal(message.integration.id, "eco");
  assert.deepEqual(message.attachments.map((a: any) => [a.filename, a.contentType, a.size]), [["image-1.png", "image/png", png.length], ["b.png", "image/png", png.length]]);
  transport.http = async () => ({ status: 200, type: "application/json", body: Buffer.from(JSON.stringify({ images: [{ data: Buffer.from("<script>").toString("base64") }] })) });
  await say("member", "/eco ruim");
  await settle();
  assert.equal(replies().at(-1)!.content, "A integração respondeu algo que o Annoy não entende.");
});

test("with the Global credential, calls go signed by devannoy and failures are reported", async () => {
  run("INSERT INTO instance_settings (key, value) VALUES ('global.serverId', 'S1'), ('global.serverSecret', 'segredo')");
  const calls0 = calls.length;
  transport.http = async (request) => {
    calls.push({ url: request.url, headers: request.headers, body: request.body ? JSON.parse(request.body) : null });
    return { status: 500, type: "application/json", body: Buffer.from(JSON.stringify({ error: "falhou" })) };
  };
  await say("member", "/eco assinado");
  await settle();
  const call = calls[calls0]!;
  assert.equal(call.headers["x-annoy-signature"], "c2lnbg==");
  assert.equal(call.headers["x-annoy-timestamp"], "1700000000");
  assert.equal(call.headers["x-annoy-key-id"], "k1");
  const { createHash } = await import("node:crypto");
  const sign = devCalls.find((c) => c.url === "POST /v1/calls/sign")!;
  assert.equal(sign.auth, "Server S1:segredo");
  assert.deepEqual(sign.body, { integration: "eco", scope: "server", bodySha256: createHash("sha256").update(JSON.stringify(call.body)).digest("hex") });
  await settle();
  assert.deepEqual(devCalls.find((c) => c.url === "POST /v1/calls/result")?.body, { integration: "eco", scope: "server", ok: false });
});

test("removing: owner only; calls stop", async () => {
  assert.equal((await app.inject({ method: "DELETE", url: "/servers/s/integrations/eco", headers: auth("member") })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: "/servers/s/integrations/eco", headers: auth("owner") })).statusCode, 200);
  const before = replies().length;
  await say("member", "/eco oi");
  await settle();
  assert.equal(replies().length, before);
});
