import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import Fastify from "fastify";
const root = resolve(tmpdir()),
  directory = await mkdtemp(join(root, "annoy-privacy-"));
process.env.ANNOY_DATA_DIR = directory;
process.env.DISTOPIC_DATA_DIR = directory;
const { db, run } = await import("../src/db.ts"),
  { createSession } = await import("../src/auth.ts"),
  { profileRoutes } = await import("../src/routes/profiles.ts"),
  { HttpError } = await import("../src/errors.ts"),
  { getUser } = await import("../src/repo.ts"),
  history = await import("../src/activity-history.ts");
const app = Fastify();
profileRoutes(app);
app.setErrorHandler((error, _req, reply) =>
  reply
    .status(error instanceof HttpError ? error.status : 500)
    .send({ message: (error as Error).message }),
);
const tokens: Record<string, string> = {};
for (const id of ["owner", "friend", "common", "dm", "pending"]) {
  run(
    "INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'!','2026-01-01')",
    id,
    id,
    id,
  );
  tokens[id] = createSession(id);
}
run(
  "INSERT INTO servers(id,name,owner_id,created_at) VALUES('s','Test','owner','2026-01-01')",
);
for (const id of ["owner", "common"])
  run(
    "INSERT INTO members(server_id,user_id,joined_at) VALUES('s',?,'2026-01-01')",
    id,
  );
run(
  "INSERT INTO channels(id,type,name,created_at) VALUES('dm','dm','dm','2026-01-01')",
);
for (const id of ["owner", "dm"])
  run("INSERT INTO dm_recipients(channel_id,user_id) VALUES('dm',?)", id);
for (const [a, b, status] of [
  ["owner", "friend", "friend"],
  ["friend", "owner", "friend"],
  ["owner", "pending", "incoming"],
  ["pending", "owner", "outgoing"],
])
  run(
    "INSERT INTO relationships(user_id,other_id,status) VALUES(?,?,?)",
    a!,
    b!,
    status!,
  );
const auth = (id: string) => ({ authorization: `Bearer ${tokens[id]}` });
const write = (payload: unknown) =>
  app.inject({
    method: "PATCH",
    url: "/users/@me/profile",
    headers: auth("owner"),
    payload,
  });
const read = async (viewer: string) =>
  (
    await app.inject({ url: "/users/owner/profile", headers: auth(viewer) })
  ).json();
after(async () => {
  await app.close();
  db.close();
  if (
    dirname(resolve(directory)) !== root ||
    !basename(directory).startsWith("annoy-privacy-")
  )
    throw new Error("Unsafe temporary directory");
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

test("profile fields default private and filter owner, mutual friend, shared community, pending and DM-only audiences", async () => {
  assert.equal(
    (
      await write({
        fields: [
          { kind: "email", value: "Contact@EXAMPLE.COM" },
          { kind: "phone", value: "+5511999999999", audience: "friends" },
          { kind: "github", value: "octocat", audience: "community" },
        ],
      })
    ).statusCode,
    200,
  );
  assert.equal((await read("owner")).fields.length, 3);
  assert.deepEqual(
    (await read("friend")).fields.map((field: any) => field.kind),
    ["github", "phone"],
  );
  assert.deepEqual(
    (await read("common")).fields.map((field: any) => field.kind),
    ["github"],
  );
  for (const viewer of ["dm", "pending"]) {
    const data = await read(viewer);
    assert.deepEqual(data.fields, []);
    assert.equal(data.hasPrivateFields, true);
    assert.equal(JSON.stringify(data).includes("Contact@"), false);
  }
  assert.equal(Object.hasOwn(getUser("owner")!, "fields"), false);
  assert.equal(
    (await app.inject({ url: "/users/owner/profile" })).statusCode,
    401,
  );
});
test("HTTPS platform normalization rejects credentials, foreign hosts, executable protocols and invalid optional contacts atomically", async () => {
  for (const [kind, value] of [
    ["github", "https://github.com.evil.test/me"],
    ["github", "https://user:pass@github.com/me"],
    ["website", "javascript:alert(1)"],
    ["website", "http://example.com"],
    ["email", "broken@"],
    ["phone", "11999999999"],
  ])
    assert.equal(
      (await write({ fields: [{ kind, value }] })).statusCode,
      400,
      `${kind}:${value}`,
    );
  assert.equal((await read("owner")).fields.length, 3);
  assert.equal(
    (await read("owner")).fields.find((field: any) => field.kind === "github")
      .value,
    "https://github.com/octocat",
  );
});
test("history requires separate consent, persists only observed metadata, bounds completed sessions and handles unknown endings", async () => {
  const activity = {
    kind: "development" as const,
    provider: "vscode" as const,
    name: "C:\\private\\project",
    file: "secret.ts",
    project: "private",
  };
  history.observeActivityHistory(1, "owner", "device-a", [activity]);
  history.observeActivityHistory(1, "owner", "device-a", []);
  assert.equal(history.activityHistory("owner").length, 0);
  assert.equal((await write({ historyEnabled: true })).statusCode, 200);
  for (let index = 0; index < 5; index++) {
    history.observeActivityHistory(1, "owner", "device-a", [
      { kind: "music", provider: "spotify", name: `Song ${index}` },
    ]);
    history.observeActivityHistory(1, "owner", "device-a", [], index !== 4);
  }
  const entries = history.activityHistory("owner");
  assert.equal(entries.length, 3);
  assert.equal(entries.find((entry) => entry.name === "Song 4")!.endedAt, null);
  history.observeActivityHistory(2, "owner", "device-b", [activity]);
  history.observeActivityHistory(2, "owner", "device-b", [activity]);
  history.observeActivityHistory(2, "owner", "device-b", []);
  const stored = JSON.stringify(
    db.prepare("SELECT * FROM activity_history WHERE user_id='owner'").all(),
  );
  assert.equal(stored.includes("secret.ts"), false);
  assert.equal(stored.includes("private"), false);
  assert.equal((await read("friend")).history.entries.length, 3);
  assert.equal((await read("common")).history.entries.length, 3);
  assert.equal((await read("dm")).history.visibility, "private");
  assert.deepEqual((await read("dm")).history.entries, []);
  run(
    "UPDATE activity_history SET last_seen_at='2000-01-01' WHERE completed=1",
  );
  assert.equal(history.activityHistory("owner").length, 0);
});
test("revocation, explicit deletion and disabling consent remove sensitive details and persisted sessions", async () => {
  run("DELETE FROM relationships WHERE user_id='friend' OR other_id='friend'");
  run("DELETE FROM members WHERE user_id='common'");
  for (const viewer of ["friend", "common"]) {
    assert.deepEqual((await read(viewer)).fields, []);
    assert.equal((await read(viewer)).history.visibility, "private");
  }
  history.observeActivityHistory(3, "owner", "c", [
    { kind: "game", provider: "steam", appId: "10", name: "Game" },
  ]);
  history.observeActivityHistory(3, "owner", "c", []);
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: "/users/@me/activity-history",
        headers: auth("owner"),
      })
    ).statusCode,
    200,
  );
  assert.equal(history.activityHistory("owner").length, 0);
  history.observeActivityHistory(4, "owner", "d", [
    { kind: "game", provider: "steam", appId: "10", name: "Game" },
  ]);
  await write({ historyEnabled: false });
  history.observeActivityHistory(4, "owner", "d", []);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM activity_history").get()!.count,
    0,
  );
  assert.equal((await read("owner")).history.enabled, false);
  await write({ fields: [] });
  assert.deepEqual((await read("owner")).fields, []);
});

test("extended activity requires capability and legacy clients only receive the three established categories", async () => {
  const { Connection } = await import("../src/events.ts"),
    { updateActivity } = await import("../src/activity.ts");
  const sent: any[] = [];
  const connection = new Connection({
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as any);
  connection.userId = "owner";
  const video = {
    kind: "video" as const,
    provider: "annoy-screen" as const,
    name: "Compartilhando tela",
  };
  assert.equal(updateActivity(connection, [video]), false);
  connection.features.add("extendedActivity");
  assert.equal(updateActivity(connection, [video]), true);
  const activities: any[] = [
    { kind: "game", provider: "steam", name: "Game", appId: "10" },
    { kind: "music", provider: "spotify", name: "Song" },
    { kind: "development", provider: "vscode", name: "Editor" },
    video,
    { kind: "generic", provider: "system-media", name: "Observed media" },
  ];
  connection.features.delete("extendedActivity");
  connection.features.add("developmentActivity");
  connection.send({ t: "ACTIVITY_UPDATE", d: { userId: "owner", activities } });
  assert.equal(sent.at(-1).d.activities.length, 3);
  connection.features.add("extendedActivity");
  connection.send({ t: "ACTIVITY_UPDATE", d: { userId: "owner", activities } });
  assert.equal(sent.at(-1).d.activities.length, 5);
});
