import type { Presence } from "@distopic/protocol";

// Owned by the gateway: counts live connections per user.
const connections = new Map<string, number>();
const idle = new Map<string, Set<number>>();
const manual = new Map<string, Presence>();
export function setManualPresence(userId: string, status: unknown): void {
  if (["online", "idle", "dnd", "offline"].includes(status as string)) manual.set(userId, status as Presence);
}
export function setConnectionIdle(userId: string, connectionId: number, away: boolean, status?: Presence): boolean {
  const previous = presenceOf(userId);
  setManualPresence(userId, status);
  const ids = idle.get(userId) ?? new Set<number>();
  if (away) ids.add(connectionId); else ids.delete(connectionId);
  if (ids.size) idle.set(userId, ids); else idle.delete(userId);
  return previous !== presenceOf(userId);
}

/** Returns true when the user transitioned from offline to online. */
export function addConnection(userId: string): boolean {
  const n = (connections.get(userId) ?? 0) + 1;
  connections.set(userId, n);
  return n === 1;
}

/** Returns true when the user transitioned from online to offline. */
export function removeConnection(userId: string, connectionId?: number): boolean {
  if (connectionId !== undefined) idle.get(userId)?.delete(connectionId);
  const n = (connections.get(userId) ?? 0) - 1;
  if (n <= 0) {
    connections.delete(userId);
    idle.delete(userId);
    manual.delete(userId);
    return true;
  }
  connections.set(userId, n);
  return false;
}

export const presenceOf = (userId: string): Presence => !connections.has(userId) ? "offline" : manual.get(userId) && manual.get(userId) !== "online" ? manual.get(userId)! : (idle.get(userId)?.size ?? 0) >= (connections.get(userId) ?? 1) ? "idle" : "online";
