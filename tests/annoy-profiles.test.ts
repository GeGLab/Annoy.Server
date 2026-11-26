// Profiles of Annoy accounts live only in usersannoy: the server lists, searches and orders
// members by names it reads there (with its Global registration), and sends no profile itself.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const reads: { authorization: string | undefined; ids: string[] }[] = [];
const profiles: Record<string, { id: string; username: string; displayName: string | null }> = {
  UA0000000001: { id: "UA0000000001", username: "zeca", displayName: "Zeca" },
  UB0000000002: { id: "UB0000000002", username: "bia", displayName: "Bia" },
};
const fakeUsers = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const ids = (JSON.parse(body || "{}").ids ?? []) as string[];
    reads.push({ authorization: req.headers.authorization, ids });
    if (req.url !== "/v1/servers/profiles" || req.headers.authorization !== "Server S1:segredo") return void res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ users: ids.flatMap((id) => (profiles[id] ? [profiles[id]] : [])) }));
  });
});
await new Promise<void>((r) => fakeUsers.listen(0, "127.0.0.1", r));
const directory = await mkdtemp(join(tmpdir(), "annoy-profiles-"));
process.env.ANNOY_ACCOUNT_MODE = "global";
process.env.ANNOY_DATA_DIR = directory;
process.env.ANNOY_GLOBAL_URL = "http://127.0.0.1:9";
process.env.ANNOY_USERS_URL = `http://127.0.0.1:${(fakeUsers.address() as AddressInfo).port}`;
const { run } = await import("../src/db.ts");
const { getMembersPage, getUser } = await import("../src/repo.ts");
after(async () => {
  fakeUsers.close();
  await rm(directory, { recursive: true, force: true });
});

run("INSERT INTO instance_settings (key, value) VALUES ('global.serverId', 'S1'), ('global.serverSecret', 'segredo')");
run("INSERT INTO users(id,username,display_name,password_hash,created_at,global_id,global_public_id) VALUES ('z','annoy.z','','!','2026-01-01','gz','UA0000000001')");
run("INSERT INTO users(id,username,display_name,password_hash,created_at,global_id,global_public_id) VALUES ('b','annoy.b','','!','2026-01-01','gb','UB0000000002')");
run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES ('l','carla_local','Carla','!','2026-01-01')");
run("INSERT INTO servers(id,name,owner_id,created_at) VALUES ('s','s','z','2026-01-01')");
for (const id of ["z", "b", "l"]) run("INSERT INTO members(server_id,user_id,joined_at) VALUES ('s',?,'2026-01-01')", id);

test("an Annoy account goes out as ID and Annoy ID only; a local account with its own profile", () => {
  assert.deepEqual(getUser("z"), { id: "z", annoyId: "UA0000000001" });
  assert.deepEqual(getUser("l"), { id: "l", username: "carla_local", profile: { displayName: "Carla", avatarUrl: null, bio: "" } });
});

test("members are ordered and searched by the names read from usersannoy, with the server's registration", async () => {
  const page = await getMembersPage("s", 10, null);
  assert.deepEqual(page.members.map((m) => m.user.id), ["b", "l", "z"], "Bia, Carla, Zeca");
  assert.equal(reads.at(-1)!.authorization, "Server S1:segredo");
  assert.deepEqual(new Set(reads.at(-1)!.ids), new Set(["UA0000000001", "UB0000000002"]));
  assert.deepEqual((await getMembersPage("s", 10, null, "zeca")).members.map((m) => m.user.id), ["z"], "by Annoy @username");
  assert.deepEqual((await getMembersPage("s", 10, null, "bi")).members.map((m) => m.user.id), ["b"], "by Annoy name");
  assert.deepEqual((await getMembersPage("s", 10, null, "carla")).members.map((m) => m.user.id), ["l"], "local accounts by their own profile");
  const first = await getMembersPage("s", 2, null);
  const second = await getMembersPage("s", 2, first.nextCursor);
  assert.deepEqual([...first.members, ...second.members].map((m) => m.user.id), ["b", "l", "z"]);
  assert.equal(second.nextCursor, null);
});
