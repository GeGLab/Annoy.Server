import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Who uses the data directory. Two kinds of holders:
 * - "service": a running server. During a blue-green update two run for a few
 *   seconds on the same data; services never exclude each other.
 * - "offline": an administrative tool (account-mode migration). It excludes
 *   everything, and services refuse to start while it runs.
 * Each holder keeps a marker file fresh (every 5 s). A marker not refreshed for
 * 30 s belongs to a process that is gone (crash, kill, another container's PID
 * namespace) and is removed. Process IDs are never used: they are not
 * comparable across containers and are reused after a restart.
 */
export type LockKind = "service" | "offline";
const PREFIX = ".annoy-lock-";
const LEGACY = ".annoy-service.lock";
export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 30_000;

interface Marker { file: string; kind: LockKind }
function live(directory: string, now = Date.now()): Marker[] {
  const markers: Marker[] = [];
  for (const name of readdirSync(directory)) {
    const match = /^\.annoy-lock-(service|offline)-[a-f0-9]{16}\.json$/.exec(name);
    if (!match) continue;
    const file = join(directory, name);
    try {
      if (now - statSync(file).mtimeMs > STALE_MS) { unlinkSync(file); continue; }
    } catch { continue; }
    markers.push({ file, kind: match[1] as LockKind });
  }
  return markers;
}

export function acquireDataLock(directory: string, kind: LockKind = "offline"): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Up to 0.10.0-alpha.2 a single PID-based file was used; it is never refreshed, so it can't prove anything.
  try { unlinkSync(join(directory, LEGACY)); } catch { /* absent */ }
  const conflicts = (others: Marker[]) => others.some((m) => kind === "offline" || m.kind === "offline");
  if (conflicts(live(directory))) {
    throw new Error(kind === "offline" ? "Data directory is in use; stop the service before offline migration" : "An offline migration is using the data directory; wait for it to finish");
  }
  const file = join(directory, `${PREFIX}${kind}-${randomBytes(8).toString("hex")}.json`);
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ kind, since: new Date().toISOString() })); } finally { closeSync(fd); }
  // Two holders that started at the same moment both see the other now: the offline one gives way.
  if (conflicts(live(directory).filter((m) => m.file !== file))) {
    unlinkSync(file);
    throw new Error(kind === "offline" ? "Data directory is in use; stop the service before offline migration" : "An offline migration is using the data directory; wait for it to finish");
  }
  const timer = setInterval(() => {
    const now = new Date();
    try { utimesSync(file, now, now); } catch { /* removed by hand */ }
  }, HEARTBEAT_MS);
  timer.unref();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try { if (existsSync(file)) unlinkSync(file); } catch { /* already gone */ }
  };
}
