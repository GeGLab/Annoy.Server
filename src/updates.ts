// Server updates from the app. The server never touches Docker itself: the
// "updater" Compose service does, and the two talk through files in a shared
// folder. The server writes "auto" (on/off) and "request" (update now); the
// updater answers with status.json every few seconds.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UpdateStatus } from "@distopic/protocol";
import { config } from "./config.ts";
import { VERSION } from "./version.ts";

const RELEASES = "https://api.github.com/repos/GeGLab/annoy-server/releases/latest";
const LATEST_TTL_MS = 30 * 60_000;
/** The updater writes status.json every 10 s; older than this, it's gone. */
const STALE_MS = 60_000;

interface UpdaterStatus {
  heartbeat: string;
  auto: boolean;
  channel: string;
  intervalHours: number;
  lastCheck: string | null;
  lastError: string | null;
  updating: boolean;
}

let latest: { version: string | null; at: number } = { version: null, at: 0 };

async function latestRelease(): Promise<string | null> {
  if (Date.now() - latest.at < LATEST_TTL_MS) return latest.version;
  try {
    const res = await fetch(RELEASES, { headers: { Accept: "application/vnd.github+json", "User-Agent": `annoy-server/${VERSION}` }, signal: AbortSignal.timeout(5000) });
    const body = res.ok ? ((await res.json()) as { tag_name?: string }) : null;
    latest = { version: body?.tag_name?.replace(/^v/, "") ?? null, at: Date.now() };
  } catch {
    latest = { version: null, at: Date.now() - LATEST_TTL_MS + 60_000 };
  }
  return latest.version;
}

async function updater(): Promise<UpdaterStatus | null> {
  if (!config.updateControlDir) return null;
  try {
    const status = JSON.parse(await readFile(join(config.updateControlDir, "status.json"), "utf8")) as UpdaterStatus;
    return Date.now() - Date.parse(status.heartbeat) < STALE_MS ? status : null;
  } catch {
    return null;
  }
}

export async function updateStatus(): Promise<UpdateStatus> {
  const [release, status] = await Promise.all([latestRelease(), updater()]);
  return {
    current: VERSION,
    latest: release,
    available: status !== null,
    auto: status?.auto ?? false,
    channel: status?.channel ?? null,
    intervalHours: status?.intervalHours ?? null,
    lastCheck: status?.lastCheck ?? null,
    lastError: status?.lastError ?? null,
    updating: status?.updating ?? false,
  };
}

async function control(file: string, value: string): Promise<boolean> {
  if (!(await updater())) return false;
  await mkdir(config.updateControlDir, { recursive: true });
  await writeFile(join(config.updateControlDir, file), value);
  return true;
}

export const setAutoUpdate = (on: boolean) => control("auto", on ? "on" : "off");
export const requestUpdate = () => control("request", new Date().toISOString());
