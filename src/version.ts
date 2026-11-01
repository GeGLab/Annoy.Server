import { readFileSync } from "node:fs";

/** package.json is the only place the server version is written. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Oldest client this server works with. A newer client always connects; an older one is told to update. */
export const MIN_CLIENT_VERSION = "0.8.0";

/** Numeric comparison of "major.minor.patch" versions: negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
export const isVersion = (value: unknown): value is string => typeof value === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
