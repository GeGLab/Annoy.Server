import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { HttpError } from "./errors.ts";

const WINDOW = 15 * 60_000;
const MAX_BUCKETS = 10_000;
const buckets = new Map<string, { count: number; until: number }>();
function consume(key: string, maximum: number): void {
  const time = Date.now();
  for (const [k, bucket] of buckets) if (bucket.until <= time) buckets.delete(k);
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) throw new HttpError(429, "auth_rate_limit", "Tente novamente mais tarde");
    bucket = { count: 0, until: time + WINDOW };
    buckets.set(key, bucket);
  }
  if (++bucket.count > maximum) throw new HttpError(429, "auth_rate_limit", "Tente novamente mais tarde");
}
/** req.ip accepts forwarding only through explicitly configured trusted peers. */
export function authAttempt(req: FastifyRequest): void {
  consume(`ip:${req.ip}`, 30);
  const body = req.body as { username?: unknown } | undefined;
  if (typeof body?.username === "string" && body.username.length <= 64) {
    const account = createHash("sha256").update(body.username.trim().toLowerCase()).digest("hex");
    consume(`account:${account}`, 10);
  }
}
