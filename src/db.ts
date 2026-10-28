import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.ts";

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(join(config.dataDir, "distopic.db"));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nick      TEXT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_by_user ON members(user_id);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,
  permissions INTEGER NOT NULL,
  position    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS member_roles (
  server_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id),
  FOREIGN KEY (server_id, user_id) REFERENCES members(server_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  server_id  TEXT REFERENCES servers(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('category', 'text', 'voice', 'dm')),
  name       TEXT NOT NULL,
  topic      TEXT NOT NULL DEFAULT '',
  parent_id  TEXT REFERENCES channels(id) ON DELETE SET NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_by_server ON channels(server_id);

CREATE TABLE IF NOT EXISTS overwrites (
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('role', 'member')),
  allow       INTEGER NOT NULL,
  deny        INTEGER NOT NULL,
  PRIMARY KEY (channel_id, target_id)
);

CREATE TABLE IF NOT EXISTS dm_recipients (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS dm_by_user ON dm_recipients(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id         TEXT NOT NULL REFERENCES users(id),
  content           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  edited_at         TEXT,
  reply_to_id       TEXT,
  mention_ids       TEXT NOT NULL DEFAULT '[]',
  mentions_everyone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_by_channel ON messages(channel_id, id);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_by_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  uses       INTEGER NOT NULL DEFAULT 0,
  max_uses   INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bans (
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

-- One row per direction: requester sees 'outgoing', target sees 'incoming',
-- both rows become 'friend' on acceptance.
CREATE TABLE IF NOT EXISTS relationships (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status   TEXT NOT NULL CHECK (status IN ('friend', 'incoming', 'outgoing')),
  PRIMARY KEY (user_id, other_id)
);
`);

// Additive migrations for databases created by earlier versions.
const userColumns = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
if (!userColumns.includes("imported_from")) {
  // "discord:<snowflake>" for authors recreated by the importer; they cannot log in.
  db.exec("ALTER TABLE users ADD COLUMN imported_from TEXT");
}
if (!userColumns.includes("discord_id")) db.exec("ALTER TABLE users ADD COLUMN discord_id TEXT");
if (!userColumns.includes("avatar_url")) db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_imported_from ON users(imported_from) WHERE imported_from IS NOT NULL");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id ON users(discord_id) WHERE discord_id IS NOT NULL");

type Row = Record<string, SQLInputValue>;

export function one<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: SQLInputValue[]): number {
  return Number(db.prepare(sql).run(...params).changes);
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const now = () => new Date().toISOString();
