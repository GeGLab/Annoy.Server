import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";

const directory = await mkdtemp(join(tmpdir(), "annoy-activity-presence-"));
process.env.ANNOY_DATA_DIR = directory;
process.env.DISTOPIC_DATA_DIR = directory;
const { db, run } = await import("../src/db.ts");
const { Connection, register, unregister } = await import("../src/events.ts");
const { addConnection, removeConnection, setConnectionIdle, presenceOf } = await import("../src/presence.ts");
const { updateActivity, activitiesFor, activityOf, refreshActivityPresence, clearActivity } = await import("../src/activity.ts");
const events: Record<string, any[]> = { alice: [], bob: [] };
const connections = ["alice", "bob"].map((id) => {
  run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')", id, id, id);
  const conn = new Connection({ readyState: 1, OPEN: 1, send(raw: string) { events[id]!.push(JSON.parse(raw)); } } as unknown as WebSocket);
  conn.features = new Set(["manualPresence", "idlePresence", "developmentActivity"]);
  register(conn, id); addConnection(id);
  return conn;
});
for (const [a, b] of [["alice", "bob"], ["bob", "alice"]]) run("INSERT INTO relationships(user_id,other_id,status) VALUES(?,?,'friend')", a!, b!);
after(async () => {
  for (const conn of connections) { clearActivity(conn); unregister(conn); removeConnection(conn.userId!, conn.id); }
  db.close(); await rm(directory, { recursive: true, force: true });
});

test("invisible presence hides local and Steam fallback games from both updates and snapshots", () => {
  const alice = connections[0]!;
  for (const game of [
    { kind: "game", provider: "steam", name: "Local game", appId: "570" },
    { kind: "game", provider: "steam", name: "Online fallback", appId: "730" },
  ]) {
    assert.equal(updateActivity(alice, [game]), true);
    assert.equal(activityOf("alice")[0]?.appId, game.appId);
    assert.equal(activitiesFor("bob").alice?.[0]?.appId, game.appId);
    assert.equal(setConnectionIdle("alice", alice.id, false, "offline"), true);
    refreshActivityPresence("alice");
    assert.deepEqual(activityOf("alice"), []);
    assert.deepEqual(activitiesFor("bob").alice, []);
    assert.deepEqual(events.bob!.filter((event) => event.t === "ACTIVITY_UPDATE").at(-1).d.activities, []);
    assert.equal(updateActivity(alice, [game]), true);
    assert.deepEqual(activityOf("alice"), []);
    assert.equal(setConnectionIdle("alice", alice.id, false, "online"), true);
    refreshActivityPresence("alice");
    assert.equal(events.bob!.filter((event) => event.t === "ACTIVITY_UPDATE").at(-1).d.activities[0].appId, game.appId);
  }
});

test("manual DND and idle survive automatic idle updates until explicitly reset", () => {
  const alice = connections[0]!;
  setConnectionIdle("alice", alice.id, true, "dnd");
  assert.equal(presenceOf("alice"), "dnd");
  setConnectionIdle("alice", alice.id, false);
  assert.equal(presenceOf("alice"), "dnd");
  setConnectionIdle("alice", alice.id, false, "idle");
  assert.equal(presenceOf("alice"), "idle");
  setConnectionIdle("alice", alice.id, false, "online");
  assert.equal(presenceOf("alice"), "online");
});
