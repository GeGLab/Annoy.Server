import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

/** Path of the SQLite database. Before 0.10 it was distopic.db; that file and its WAL files are moved on first use. */
export function databaseFile(dataDir: string): string {
  const file = join(dataDir, "annoy.db");
  const legacy = join(dataDir, "distopic.db");
  if (!existsSync(file) && existsSync(legacy)) {
    // WAL files first: a database without its WAL would lose uncheckpointed writes.
    for (const suffix of ["-wal", "-shm", ""]) if (existsSync(legacy + suffix)) renameSync(legacy + suffix, file + suffix);
  }
  return file;
}
