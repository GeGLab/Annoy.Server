import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDataLock, STALE_MS } from "../src/data-lock.ts";

const temp = () => mkdtempSync(join(tmpdir(), "annoy-lock-"));
const markers = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(".annoy-lock-"));

test("two services share the data directory (blue-green update)", () => {
  const dir = temp();
  try {
    const a = acquireDataLock(dir, "service"), b = acquireDataLock(dir, "service");
    assert.equal(markers(dir).length, 2);
    a(); b();
    assert.equal(markers(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an offline migration excludes services and services exclude it", () => {
  const dir = temp();
  try {
    const service = acquireDataLock(dir, "service");
    assert.throws(() => acquireDataLock(dir, "offline"), /in use/);
    service();
    const offline = acquireDataLock(dir, "offline");
    assert.throws(() => acquireDataLock(dir, "service"), /offline migration/);
    assert.throws(() => acquireDataLock(dir, "offline"), /in use/);
    offline();
    acquireDataLock(dir, "service")();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a marker not refreshed for 30 s is a dead process and never blocks; the old PID file is ignored", () => {
  const dir = temp();
  try {
    acquireDataLock(dir, "offline"); // never released: a crashed tool
    const [file] = markers(dir);
    const old = new Date(Date.now() - STALE_MS - 1000);
    utimesSync(join(dir, file!), old, old);
    // The PID file from 0.10.0-alpha.1 (PID 17 reused inside a restarted container).
    writeFileSync(join(dir, ".annoy-service.lock"), JSON.stringify({ pid: process.pid, token: "x" }));
    const service = acquireDataLock(dir, "service");
    assert.deepEqual(readdirSync(dir).filter((n) => n === ".annoy-service.lock"), []);
    assert.equal(markers(dir).length, 1);
    service();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
