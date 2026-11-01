import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, planModeMigration, applyModeMigration } from '../src/account-mode-migration.ts';

test('explicit mode migration validates backup, preserves identities and history, and supports offline restore', async () => {
  const dir=mkdtempSync(join(tmpdir(),'annoy-mode-'));
  const path=join(dir,'db.sqlite'); const saved=join(dir,'backup.sqlite');
  let db=new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE instance_settings(key TEXT PRIMARY KEY,value TEXT);
      INSERT INTO instance_settings VALUES('auth.accountMode','global');
      CREATE TABLE users(id TEXT, global_id TEXT, password_hash TEXT);
      INSERT INTO users VALUES('u','identity','!');
      CREATE TABLE messages(id TEXT,content TEXT); INSERT INTO messages VALUES('m','legacy');
      CREATE TABLE sessions(token_hash TEXT); INSERT INTO sessions VALUES('token');
      CREATE TABLE account_recovery(token_hash TEXT); INSERT INTO account_recovery VALUES('recovery');`);
    db.close();
    const plan=planModeMigration(path,'global','local');
    assert.equal(plan.recordedMode,'global');
    await assert.rejects(applyModeMigration(path,'global','local','0'.repeat(64),saved),/changed/);
    await applyModeMigration(path,'global','local',plan.fingerprint,saved);
    db=new DatabaseSync(path);
    assert.equal(db.prepare("SELECT value FROM instance_settings WHERE key='auth.accountMode'").get()?.value,'local');
    assert.deepEqual({...db.prepare('SELECT * FROM users').get()}, {id:'u',global_id:'identity',password_hash:'!'});
    assert.equal(db.prepare('SELECT content FROM messages').get()?.content,'legacy');
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n,0);
    const restored=new DatabaseSync(saved,{readOnly:true});
    try {
      assert.equal(restored.prepare("SELECT value FROM instance_settings WHERE key='auth.accountMode'").get()?.value,'global');
      assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
      assert.equal(fingerprint(restored),plan.fingerprint);
      assert.equal(restored.prepare('SELECT content FROM messages').get()?.content,'legacy');
    } finally {restored.close();}
    db.close();
    const next=planModeMigration(path,'local','global');
    await assert.rejects(applyModeMigration(path,'local','global',next.fingerprint,saved),/EEXIST/);
    db=new DatabaseSync(path);
    db.exec("INSERT INTO messages VALUES('new','changed')"); db.close();
    await assert.rejects(applyModeMigration(path,'local','global',next.fingerprint,join(dir,'new.sqlite')),/changed/);
    db=new DatabaseSync(path);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
