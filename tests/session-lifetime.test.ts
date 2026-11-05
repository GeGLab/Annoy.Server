// Regression: 0.10.0-alpha.1 kept the E2EE "bootstrap" lifetime of five
// minutes after removing device-bind, so everyone was signed out mid-call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a new session stays valid after five minutes and a day", async () => {
  process.env.ANNOY_DATA_DIR = await mkdtemp(join(tmpdir(), "annoy-session-life-"));
  process.env.ANNOY_ACCOUNT_MODE = "local";
  const { run, one } = await import("../src/db.ts");
  const { createSession, userIdForToken, hashToken } = await import("../src/auth.ts");
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('u','alice','Alice','!','2026-01-01')");
  const token = createSession("u");
  assert.equal(userIdForToken(token), "u");
  const { expires_at } = one<{ expires_at: string }>("SELECT expires_at FROM sessions WHERE token_hash = ?", hashToken(token))!;
  assert.ok(Date.parse(expires_at) > Date.now() + 365 * 86_400_000, `expires ${expires_at}`);
});
