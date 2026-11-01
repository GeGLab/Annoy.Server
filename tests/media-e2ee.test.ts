import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { GatewayEvent, VoiceMediaBinding } from "@distopic/protocol";
import { handleMedia, mediaJoin, mediaLeave, mediaSnapshot } from "../src/media-e2ee.ts";
import type { Connection } from "../src/events.ts";

let seq = 1000;
function peer(userId: string) {
  const events: GatewayEvent[] = [];
  const conn = { id: ++seq, userId, send: (e: GatewayEvent) => events.push(e) } as unknown as Connection;
  return { conn, events, media: () => events.filter((e) => e.t === "VOICE_MEDIA").map((e) => e.d as any) };
}
const bind = (userId: string, deviceId = userId + "-device"): VoiceMediaBinding => ({ userId, deviceId, mediaKey: "media-key-" + userId, signature: "sig-" + userId });
const CALL = "c".repeat(22);

test("the voice service only sequences call commits and never sees media keys", () => {
  const channel = "voice-a";
  const [a, b, c] = [peer("alice"), peer("bob"), peer("carol")];
  assert.deepEqual(mediaJoin(channel, a.conn, "sframe"), { protection: "sframe", callId: null, epoch: 0 });
  assert.throws(() => handleMedia(a.conn, channel, "mediaCreate", { callId: "short", binding: bind("alice") }), /inválido/);
  assert.throws(() => handleMedia(a.conn, channel, "mediaCreate", { callId: CALL, binding: bind("mallory") }), (e: any) => e.status === 403);
  assert.deepEqual(handleMedia(a.conn, channel, "mediaCreate", { callId: CALL, binding: bind("alice") }), { created: true, callId: CALL, epoch: 0 });
  // A late creator learns the existing call instead of forking it.
  assert.equal(mediaJoin(channel, b.conn, "sframe").callId, CALL);
  assert.deepEqual(handleMedia(b.conn, channel, "mediaCreate", { callId: "d".repeat(22), binding: bind("bob") }), { created: false, callId: CALL, epoch: 0 });
  // A legacy transport-only client cannot silently join an encrypted call, nor the reverse.
  assert.throws(() => mediaJoin(channel, c.conn, "transport_only_acknowledged"), (e: any) => e.status === 409 && e.code === "media_protection_mismatch");
  assert.throws(() => handleMedia(b.conn, channel, "mediaCommit", { callId: CALL, epoch: 0, commit: "x" }), (e: any) => e.status === 403);
  handleMedia(b.conn, channel, "mediaPropose", { callId: CALL, keyPackage: "kp-bob", binding: bind("bob") });
  const proposals = a.media().at(-1);
  assert.equal(proposals.kind, "proposals");
  assert.deepEqual(proposals.adds.map((x: any) => [x.binding.deviceId, x.keyPackage]), [["bob-device", "kp-bob"]]);
  assert.equal(b.media().length, 0, "only the designated committer receives proposals");
  const ref = proposals.adds[0].ref;
  assert.throws(() => handleMedia(a.conn, channel, "mediaCommit", { callId: CALL, epoch: 1, commit: "x", welcome: "w", adds: [ref] }), (e: any) => e.code === "media_epoch_conflict");
  assert.throws(() => handleMedia(a.conn, channel, "mediaCommit", { callId: CALL, epoch: 0, commit: "x", welcome: "w", adds: [ref + 99] }), (e: any) => e.code === "media_epoch_conflict");
  assert.throws(() => handleMedia(a.conn, channel, "mediaCommit", { callId: CALL, epoch: 0, commit: "x", adds: [ref] }), /welcome/);
  assert.deepEqual(handleMedia(a.conn, channel, "mediaCommit", { callId: CALL, epoch: 0, commit: "commit-1", welcome: "welcome-1", adds: [ref] }), { epoch: 1 });
  const welcome = b.media().at(-1);
  assert.equal(welcome.kind, "welcome");
  assert.equal(welcome.welcome, "welcome-1");
  assert.deepEqual(welcome.bindings.map((x: VoiceMediaBinding) => x.deviceId), ["alice-device", "bob-device"]);
  // The second commit on the same epoch loses.
  assert.throws(() => handleMedia(b.conn, channel, "mediaCommit", { callId: CALL, epoch: 0, commit: "late" }), (e: any) => e.code === "media_epoch_conflict");
  const snapshot = JSON.stringify(mediaSnapshot(channel));
  assert.deepEqual(mediaSnapshot(channel), { callId: CALL, epoch: 1, members: ["alice-device", "bob-device"], pending: 0 });
  assert.ok(!/kp-bob|commit-1|welcome-1/.test(snapshot));

  // The creator leaves: the remaining member is told to remove it and commits.
  mediaLeave(channel, a.conn.id);
  const removal = b.media().at(-1);
  assert.equal(removal.kind, "proposals");
  assert.deepEqual(removal.removes.map((x: any) => x.binding.deviceId), ["alice-device"]);
  assert.deepEqual(handleMedia(b.conn, channel, "mediaCommit", { callId: CALL, epoch: 1, commit: "commit-2", removes: [removal.removes[0].ref] }), { epoch: 2 });
  assert.equal(a.media().filter((e: any) => e.kind === "commit").length, 0, "a departed device receives no further commits");

  // A device waiting to be admitted when the last member leaves restarts the call.
  const d = peer("dave");
  mediaJoin(channel, d.conn, "sframe");
  handleMedia(d.conn, channel, "mediaPropose", { callId: CALL, keyPackage: "kp-dave", binding: bind("dave") });
  mediaLeave(channel, b.conn.id);
  assert.equal(d.media().at(-1).kind, "restart");
  assert.deepEqual(mediaSnapshot(channel), { callId: null, epoch: 0, members: [], pending: 0 });
  assert.equal(handleMedia(d.conn, channel, "mediaCreate", { callId: "e".repeat(22), binding: bind("dave") }).created, true);
  mediaLeave(channel, d.conn.id);
  assert.equal(mediaSnapshot(channel), null);
  // Once empty, the channel can be used without E2EE by consenting clients.
  assert.equal(mediaJoin(channel, c.conn, "transport_only_acknowledged").protection, "transport_only_acknowledged");
  assert.throws(() => handleMedia(c.conn, channel, "mediaCreate", { callId: CALL, binding: bind("carol") }), /não usa E2EE/);
  mediaLeave(channel, c.conn.id);
});

test("a silent committer hands the turn to the next member", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const channel = "voice-b";
    const [a, b, c] = [peer("alice"), peer("bob"), peer("carol")];
    mediaJoin(channel, a.conn, "sframe");
    handleMedia(a.conn, channel, "mediaCreate", { callId: CALL, binding: bind("alice") });
    mediaJoin(channel, b.conn, "sframe");
    handleMedia(b.conn, channel, "mediaPropose", { callId: CALL, keyPackage: "kp-bob", binding: bind("bob") });
    const ref = a.media().at(-1).adds[0].ref;
    handleMedia(a.conn, channel, "mediaCommit", { callId: CALL, epoch: 0, commit: "c1", welcome: "w1", adds: [ref] });
    mediaJoin(channel, c.conn, "sframe");
    handleMedia(c.conn, channel, "mediaPropose", { callId: CALL, keyPackage: "kp-carol", binding: bind("carol") });
    assert.equal(a.media().at(-1).kind, "proposals");
    assert.equal(b.media().filter((e: any) => e.kind === "proposals").length, 0);
    mock.timers.tick(8_000);
    const handed = b.media().at(-1);
    assert.equal(handed.kind, "proposals");
    assert.deepEqual(handed.adds.map((x: any) => x.binding.deviceId), ["carol-device"]);
    for (const p of [a, b, c]) mediaLeave(channel, p.conn.id);
    assert.equal(mediaSnapshot(channel), null);
  } finally {
    mock.timers.reset();
  }
});
