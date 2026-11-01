import {acquireDataLock} from './data-lock.ts';
import {dirname} from 'node:path';
// Administrative offline migration. Never imported by the running server.
import { createHash } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

type Mode = "global" | "local";
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export function fingerprint(db: DatabaseSync): string {
  const hash = createHash("sha256");
  for(const schema of db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").iterate())hash.update(JSON.stringify(schema));
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name: string; sql: string}[];
  for (const table of tables) {
    hash.update(JSON.stringify(table));
    const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as {name: string}[];
    for (const row of db.prepare(`SELECT * FROM ${quote(table.name)} ORDER BY ${columns.map(c => quote(c.name)).join(',')}`).iterate()) {
      hash.update(JSON.stringify(row, (_, value) => typeof value === 'bigint' ? {bigint: String(value)} : value));
    }
  }
  return hash.digest("hex");
}
function previousMode(db: DatabaseSync): string | undefined {
  return (db.prepare("SELECT value FROM instance_settings WHERE key='auth.accountMode'").get() as {value: string} | undefined)?.value;
}
export function planModeMigration(path: string, from: Mode, to: Mode) {
  const db = new DatabaseSync(path, {readOnly:true});
  try {
    db.exec('BEGIN');
    const previous = previousMode(db);
    if (previous && previous !== from) throw new Error('Source mode does not match database');
    if (from === to) throw new Error('Source and destination modes must differ');
    return {from, to, recordedMode: previous ?? null, fingerprint: fingerprint(db),
      users: db.prepare('SELECT count(*) AS count FROM users').get(),
      sessions: db.prepare('SELECT count(*) AS count FROM sessions').get(),
      warning: 'Stop the service before applying. All sessions will be revoked. Identities, passwords and history are preserved. Account enrollment remains explicit.'};
  } finally { db.close(); }
}
export async function applyModeMigration(path:string,from:Mode,to:Mode,expected:string,backupPath:string):Promise<void>{
 const release=acquireDataLock(dirname(resolve(path)));try{await applyLockedModeMigration(path,from,to,expected,backupPath);}finally{release();}
}
async function applyLockedModeMigration(path: string, from: Mode, to: Mode, expected: string, backupPath: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Expected plan fingerprint is required');
  if (resolve(path) === resolve(backupPath)) throw new Error('Backup must have a different path');
  const plan = planModeMigration(path, from, to);
  if (plan.fingerprint !== expected) throw new Error('Database changed since planning');
  // Reserve a new owner-only path; never overwrite an existing backup.
  closeSync(openSync(backupPath, 'wx', 0o600));
  const source = new DatabaseSync(path, {readOnly:true});
  try { await backup(source, backupPath); } finally { source.close(); }
  const saved = new DatabaseSync(backupPath, {readOnly:true});
  try {
    if (saved.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || fingerprint(saved) !== expected) {
      throw new Error('Backup validation failed; no mode change applied');
    }
  } finally { saved.close(); }
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    if (fingerprint(db) !== expected) throw new Error('Database changed during backup; plan again with service stopped');
    db.prepare("INSERT INTO instance_settings(key,value) VALUES('auth.accountMode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(to);
    db.prepare("INSERT INTO instance_settings(key,value) VALUES('auth.lastModeMigration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({from,to,at:new Date().toISOString(),source:expected}));
    db.exec('DELETE FROM sessions; DELETE FROM account_recovery; COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}
