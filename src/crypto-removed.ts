import { all, db, one, run } from "./db.ts";
import { discardBlobs } from "./uploads.ts";

/**
 * TODO item 3: the MLS end-to-end layer of servers is gone. Messages in
 * channels are plain again (TLS in transit). Once per server, at start:
 * encrypted envelopes, their files, device keys and the triggers that blocked
 * plain messages are removed. Encrypted messages can't be read by the server,
 * so they are deleted (the user's decision, 2026-11-04). Plain history stays.
 * DMs of Annoy accounts keep their own encryption in the Annoy cloud.
 */
const TABLES = [
  "crypto_envelopes",
  "crypto_cancelled_envelopes",
  "crypto_channels",
  "crypto_blob_gc",
  "crypto_blobs",
  "device_key_packages",
  "device_challenges",
  "crypto_devices",
  "dpop_replay",
  "legacy_archive_receipts",
];

export async function removeServerCrypto(): Promise<{ tables: number; files: number } | null> {
  if (one("SELECT 1 AS x FROM instance_settings WHERE key = 'crypto.removed'")) return null;
  const exists = (name: string) => !!one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name);
  const files = exists("crypto_blobs") ? all<{ id: string }>("SELECT id FROM crypto_blobs").map((r) => r.id) : [];
  const triggers = all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'crypto_%'").map((r) => r.name);
  let tables = 0;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const name of triggers) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
    for (const name of TABLES)
      if (exists(name)) {
        db.exec(`DROP TABLE "${name}"`);
        tables++;
      }
    run("INSERT INTO instance_settings (key, value) VALUES ('crypto.removed', ?)", new Date().toISOString());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  await discardBlobs(files);
  return { tables, files: files.length };
}
