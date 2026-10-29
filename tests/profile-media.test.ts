import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { Readable } from "node:stream";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import sharp from "sharp";

const tempRoot = resolve(tmpdir());
const directory = await mkdtemp(join(tempRoot, "distopic-profile-test-"));
process.env.ANNOY_DATA_DIR = directory;
process.env.DISTOPIC_DATA_DIR = directory;
const { authRoutes } = await import("../src/routes/auth.ts");
const { channelRoutes } = await import("../src/routes/channels.ts");
const { HttpError } = await import("../src/errors.ts");
const { db, run } = await import("../src/db.ts");
const { createSession } = await import("../src/auth.ts");
const { writeBlob } = await import("../src/uploads.ts");
const app = Fastify();
await app.register(multipart);
app.setErrorHandler((error, _req, reply) =>
  reply
    .status(error instanceof HttpError ? error.status : ((error as { statusCode?: number }).statusCode ?? 500))
    .send({ message: (error as Error).message }),
);
authRoutes(app);
channelRoutes(app);
run("INSERT INTO users(id, username, display_name, password_hash, created_at) VALUES ('person', 'person', 'Pessoa', '!', '2026-01-01')");
const authorization = `Bearer ${createSession("person")}`;
const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#de9862" } })
  .png()
  .toBuffer();
const boundary = "distopic-avatar-test";
const upload = (bytes: Buffer) =>
  Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
after(async () => {
  await app.close();
  db.close();
  if (dirname(resolve(directory)) !== tempRoot || !basename(directory).startsWith("distopic-profile-test-"))
    throw new Error("Unsafe test path");
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("avatar upload validates, re-encodes, serves and deletes the user's image", async () => {
  const request = (bytes: Buffer, auth = authorization) =>
    app.inject({
      method: "POST",
      url: "/users/@me/avatar",
      headers: { authorization: auth, host: "localhost:8787", "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: upload(bytes),
    });
  assert.equal((await request(photo, "Bearer invalid")).statusCode, 401);
  assert.equal((await request(Buffer.from("not an image"))).statusCode, 400);
  const response = await request(photo);
  assert.equal(response.statusCode, 200, response.body);
  const user = response.json();
  const url = new URL(user.avatarUrl);
  assert.match(url.pathname, /^\/api\/avatars\/[a-f0-9]{32}\.webp$/);
  const image = await app.inject({ url: url.pathname.replace("/api", "") });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/webp");
  const info = await sharp(image.rawPayload).metadata();
  assert.equal(info.width, 512);
  assert.equal(info.height, 512);
  const second = await request(photo);
  assert.equal(second.statusCode, 200);
  assert.equal((await app.inject({ url: url.pathname.replace("/api", "") })).statusCode, 404);
  const removed = await app.inject({ method: "PATCH", url: "/users/@me", headers: { authorization }, payload: { avatarUrl: null } });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().avatarUrl, null);
  assert.equal((await app.inject({ url: new URL(second.json().avatarUrl).pathname.replace("/api", "") })).statusCode, 404);
  const arbitrary = await app.inject({
    method: "PATCH",
    url: "/users/@me",
    headers: { authorization },
    payload: { avatarUrl: "https://example.com/photo" },
  });
  assert.equal(arbitrary.statusCode, 400);
});

test("uploaded media supports full, partial, suffix and unsatisfiable ranges", async () => {
  const id = "a".repeat(32);
  const data = Buffer.from("0123456789");
  await writeBlob(id, Readable.from(data));
  run("INSERT INTO channels(id, type, name, created_at) VALUES ('dm', 'dm', '', '2026-01-01')");
  run("INSERT INTO messages(id, channel_id, author_id, content, created_at) VALUES ('message', 'dm', 'person', '', '2026-01-01')");
  run("INSERT INTO attachments(id, message_id, filename, size, content_type) VALUES (?, 'message', 'song.wav', 10, 'audio/wav')", id);
  const url = `/uploads/${id}/song.wav`;
  const partial = await app.inject({ url, headers: { range: "bytes=2-5" } });
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.body, "2345");
  assert.equal(partial.headers["content-range"], "bytes 2-5/10");
  const suffix = await app.inject({ url, headers: { range: "bytes=-3" } });
  assert.equal(suffix.statusCode, 206);
  assert.equal(suffix.body, "789");
  assert.equal((await app.inject({ url })).body, "0123456789");
  const invalid = await app.inject({ url, headers: { range: "bytes=99-100" } });
  assert.equal(invalid.statusCode, 416);
  assert.equal(invalid.headers["content-range"], "bytes */10");
});
