import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "annoy-integration-http-"));
process.env.ANNOY_DATA_DIR = directory;
const state = { addresses: [{ address: "104.21.63.72", family: 4 }], calls: 0 };
const globals = globalThis as typeof globalThis & { __annoyHttpAddresses?: typeof state };
globals.__annoyHttpAddresses = state;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "node:dns/promises" ? { url: "test:integration-dns", shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === "test:integration-dns" ? { format: "module", source: "export const lookup=async()=>globalThis.__annoyHttpAddresses.addresses;", shortCircuit: true } : next(url, context);
  },
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { state.calls++; return new Response('{"text":"Profile"}', { headers: { "content-type": "application/json" } }); };
const { transport } = await import("../src/integrations.ts");
const { db } = await import("../src/db.ts");
after(async () => { hooks.deregister(); globalThis.fetch = originalFetch; delete globals.__annoyHttpAddresses; db.close(); await rm(directory, { recursive: true, force: true }); });
beforeEach(() => { state.addresses = [{ address: "104.21.63.72", family: 4 }]; state.calls = 0; });
const request = { url: "https://steamprofiler.org/api/annoy", method: "POST" as const, headers: {}, body: "{}", maxBytes: 1024, timeoutMs: 5000 };

test("server integrations can reach public IPv4 and dual-stack endpoints", async () => {
  assert.equal((await transport.http(request)).status, 200);
  state.addresses.push({ address: "2606:4700:3036::6815:3f48", family: 6 });
  assert.equal((await transport.http(request)).status, 200);
  assert.equal(state.calls, 2);
});

test("server integrations still reject private and IPv4-mapped IPv6 DNS results", async () => {
  for (const [address, family] of [["127.0.0.1", 4], ["10.0.0.1", 4], ["::1", 6], ["fc00::1", 6], ["::ffff:104.21.63.72", 6]] as const) {
    state.addresses = [{ address, family }];
    await assert.rejects(transport.http(request), /not a public address/, address);
  }
  assert.equal(state.calls, 0);
});
