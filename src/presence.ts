import type { Presence } from "@distopic/protocol";

// Owned by the gateway: counts live connections per user.
const connections = new Map<string, number>();

/** Returns true when the user transitioned from offline to online. */
export function addConnection(userId: string): boolean {
  const n = (connections.get(userId) ?? 0) + 1;
  connections.set(userId, n);
  return n === 1;
}

/** Returns true when the user transitioned from online to offline. */
export function removeConnection(userId: string): boolean {
  const n = (connections.get(userId) ?? 0) - 1;
  if (n <= 0) {
    connections.delete(userId);
    return true;
  }
  connections.set(userId, n);
  return false;
}

export const presenceOf = (userId: string): Presence => (connections.has(userId) ? "online" : "offline");
