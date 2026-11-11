import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { MIN_CLIENT_VERSION } from "../src/version.ts";

const directory = await mkdtemp(join(tmpdir(), "annoy-min-client-gateway-"));
process.env.ANNOY_DATA_DIR = directory;
process.env.ANNOY_ACCOUNT_MODE = "local";
delete process.env.ANNOY_MIN_CLIENT_VERSION;
const { db, run } = await import("../src/db.ts");
const { createSession } = await import("../src/auth.ts");
const { registerGateway } = await import("../src/gateway.ts");
run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('version-user','version-user','Version user','!','2026-01-01')");
const token = createSession("version-user");
const app = Fastify();
await app.register(websocket);
registerGateway(app);
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
after(async () => {
  // The client can finish closing before the server's close handler releases
  // its presence and activity state. Keep the database open until both finish.
  const closed = [...app.websocketServer.clients].map((socket) => once(socket, "close"));
  await app.close();
  await Promise.all(closed);
  db.close();
  await rm(directory, { recursive: true, force: true });
});

test("the gateway rejects old, malformed and missing client versions", { timeout: 10_000 }, async () => {
  for (const clientVersion of [undefined, null, "latest", "0.10.0-alpha.7", "0.10.0-nightly.202611070927"]) {
    const socket = new WebSocket(origin.replace("http", "ws") + "/gateway");
    await once(socket, "open");
    const message = once(socket, "message"), closed = once(socket, "close");
    socket.send(JSON.stringify({ op: "identify", token, clientVersion }));
    const event = JSON.parse(String((await message)[0]));
    assert.equal(event.t, "INVALID_SESSION");
    assert.ok(event.d.reason.includes(MIN_CLIENT_VERSION));
    assert.equal((await closed)[0], 4011);
  }
});

test("the gateway accepts the new minimum and newer clients", { timeout: 10_000 }, async () => {
  for (const clientVersion of [MIN_CLIENT_VERSION, "0.11.0-alpha.2", "0.11.0"]) {
    const socket = new WebSocket(origin.replace("http", "ws") + "/gateway");
    await once(socket, "open");
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ op: "identify", token, clientVersion }));
    assert.equal(JSON.parse(String((await ready)[0])).t, "READY");
    const closed = once(socket, "close"); socket.close(); await closed;
  }
});
