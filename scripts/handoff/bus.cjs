const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
module.exports = function openBus(filename) {
  const db = new DatabaseSync(filename);
  fs.chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,origin TEXT NOT NULL,recipients TEXT NOT NULL,event TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,action TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',result TEXT,created INTEGER NOT NULL,generation TEXT NOT NULL DEFAULT '');
  `);
  if(!db.prepare('PRAGMA table_info(commands)').all().some(c=>c.name==='generation'))db.exec("ALTER TABLE commands ADD COLUMN generation TEXT NOT NULL DEFAULT ''");
  return db;
};
