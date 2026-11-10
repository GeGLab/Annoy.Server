import { readFileSync } from "node:fs";

/** package.json is the only place the server version is written. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Oldest client this server works with. A newer client always connects; an older one is told to update. */
export const MIN_CLIENT_VERSION = "0.11.0-alpha.1";

/**
 * Semver precedence: negative when a is older than b. A pre-release sorts
 * before its release (0.10.0-alpha.1 < 0.10.0) and identifiers compare one by
 * one, numbers numerically (alpha.10 > alpha.9). Same rule as the client.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const plain = v.replace(/^v/, "").split("+", 1)[0]!;
    const dash = plain.indexOf("-");
    const core = dash < 0 ? plain : plain.slice(0, dash);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: dash < 0 ? [] : plain.slice(dash + 1).split(".") };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre.length && !y.pre.length) return -1;
  if (!x.pre.length && y.pre.length) return 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
/** "0.9.0" or a channel build like "0.10.0-alpha.1" / "0.10.1-nightly.202611040300". */
export const isVersion = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,3})?$/.test(value);
