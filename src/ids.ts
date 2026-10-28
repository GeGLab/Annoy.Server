import { createHash, randomBytes } from "node:crypto";

let lastTime = 0;
let counter = 0;

const timePart = (ms: number) => ms.toString(36).padStart(9, "0");

/**
 * Time-ordered, fixed-width, lowercase base36 id. Lexicographic order equals
 * creation order, which message pagination relies on.
 */
export function newId(): string {
  const now = Date.now();
  if (now === lastTime) counter++;
  else {
    lastTime = now;
    counter = 0;
  }
  const seq = counter.toString(36).padStart(3, "0");
  const rand = randomBytes(4).readUInt32BE().toString(36).padStart(7, "0");
  return timePart(now) + seq + rand;
}

/**
 * Deterministic id in the same format for something that happened at `ms`,
 * e.g. an imported message keeping its original time. `key` must be unique
 * among everything created at that instant.
 */
export function idAt(ms: number, key: string): string {
  const digest = createHash("sha256").update(key).digest().readBigUInt64BE();
  return timePart(ms) + digest.toString(36).padStart(13, "0").slice(-10);
}

/** Unguessable id for publicly served resources such as uploads. */
export function secretId(): string {
  return randomBytes(16).toString("hex");
}

export function inviteCode(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let code = "";
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}
