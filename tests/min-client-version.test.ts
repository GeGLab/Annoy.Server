import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";

const directory = await mkdtemp(join(tmpdir(), "annoy-min-version-"));
process.env.ANNOY_ACCOUNT_MODE = "local";
process.env.ANNOY_DATA_DIR = directory;
process.env.ANNOY_MIN_CLIENT_VERSION = "0.9.0";
const { compareVersions, isVersion } = await import("../src/version.ts");
const { db } = await import("../src/db.ts");
const { authRoutes } = await import("../src/routes/auth.ts");
const app = Fastify();
await app.register(async (api) => authRoutes(api), { prefix: "/api" });
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });

test("servers announce the oldest client they accept; newer clients always pass", async () => {
  assert.ok(compareVersions("0.8.9", "0.9.0") < 0);
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0, "numeric, not text, comparison");
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(isVersion("0.9.0"), true);
  for (const bad of ["0.9", "latest", "0.9.0-", "0.9.0-beta..1", 9]) assert.equal(isVersion(bad), false, String(bad));
  // Channel builds (TODO item 6): alpha, beta, nightly, unstable.
  for (const good of ["0.10.0-alpha.1", "0.10.0-beta", "0.10.1-nightly.202611040300"]) assert.equal(isVersion(good), true, good);
  assert.ok(compareVersions("0.10.0-alpha.1", "0.9.0") > 0, "an alpha of a newer version passes");
  assert.ok(compareVersions("0.10.0-alpha.1", "0.10.0") < 0, "an alpha is older than its release");
  assert.ok(compareVersions("0.10.0-alpha.10", "0.10.0-alpha.9") > 0);
  assert.ok(compareVersions("0.10.0-beta.1", "0.10.0-alpha.2") > 0);
  const info = (await app.inject({ url: "/api/info" })).json();
  assert.equal(info.minClientVersion, "0.9.0");
  // A malformed minimum stops the server at startup instead of locking clients out.
  const started = spawnSync(process.execPath, ["--import", "tsx", "-e", "await import('./src/config.ts')"], { env: { ...process.env, ANNOY_MIN_CLIENT_VERSION: "latest" }, encoding: "utf8" });
  assert.notEqual(started.status, 0);
  assert.match(started.stderr, /ANNOY_MIN_CLIENT_VERSION/);
});
