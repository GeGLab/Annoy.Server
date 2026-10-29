import { has, Permission, type Channel, type GatewayEvent } from "@distopic/protocol";
import type { WebSocket } from "ws";
import { channelPermissions } from "./perms.ts";
import { audienceOf, dmRecipientIds, memberIds } from "./repo.ts";

/** One authenticated gateway connection. Voice sessions hang off it. */
export class Connection {
  private static seq = 0;
  readonly id = ++Connection.seq;
  userId: string | null = null;
  deviceId: string | null = null;
  features = new Set<string>();
  lastHeartbeat = Date.now();
  activityWindowAt = 0;
  activityCount = 0;

  constructor(readonly socket: WebSocket) {}

  send(event: GatewayEvent): void {
    if (!this.features.has("developmentActivity")) {
      if (event.t === "ACTIVITY_UPDATE") event = { ...event, d: { ...event.d, activities: event.d.activities.filter((activity) => activity.kind !== "development") } };
      else if (event.t === "READY") event = { ...event, d: { ...event.d, activities: Object.fromEntries(Object.entries(event.d.activities ?? {}).map(([id, activities]) => [id, activities.filter((activity) => activity.kind !== "development")])) } };
    }
    if (!this.features.has("idlePresence")) {
      if (event.t === "PRESENCE_UPDATE" && event.d.presence === "idle") event = { ...event, d: { ...event.d, presence: "online" } };
      else if (event.t === "READY") event = { ...event, d: { ...event.d, presences: Object.fromEntries(Object.entries(event.d.presences).map(([id, presence]) => [id, presence === "idle" ? "online" : presence])) } };
    }
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(event));
  }
}

const byUser = new Map<string, Set<Connection>>();

export function register(conn: Connection, userId: string): void {
  conn.userId = userId;
  const set = byUser.get(userId) ?? new Set();
  set.add(conn);
  byUser.set(userId, set);
}

export function unregister(conn: Connection): void {
  if (!conn.userId) return;
  const set = byUser.get(conn.userId);
  set?.delete(conn);
  if (set?.size === 0) byUser.delete(conn.userId);
}

export function connectionsOf(userId: string): ReadonlySet<Connection> {
  return byUser.get(userId) ?? new Set();
}

export function sendToUser(userId: string, event: GatewayEvent): void {
  for (const conn of byUser.get(userId) ?? []) conn.send(event);
}

export function sendToUsers(userIds: Iterable<string>, event: GatewayEvent): void {
  for (const id of new Set(userIds)) sendToUser(id, event);
}

export function sendToServer(serverId: string, event: GatewayEvent): void {
  sendToUsers(memberIds(serverId), event);
}

/** Delivers only to users who can currently see the channel. */
export function sendToChannel(channel: Channel, event: GatewayEvent, exceptUserId?: string): void {
  const candidates = channel.type === "dm" ? dmRecipientIds(channel.id) : channel.serverId ? memberIds(channel.serverId) : [];
  for (const userId of candidates) {
    if (userId === exceptUserId || !byUser.has(userId)) continue;
    if (has(channelPermissions(channel, userId), Permission.VIEW_CHANNEL)) sendToUser(userId, event);
  }
}

export function sendToAudience(userId: string, event: GatewayEvent): void {
  sendToUsers(audienceOf(userId), event);
}

// Structural changes ---------------------------------------------------------

type ServerHook = (serverId: string) => void;
const refreshHooks: ServerHook[] = [];

/** Lets owners of derived state (voice) re-check access after permission changes. */
export function onServerChanged(hook: ServerHook): void {
  refreshHooks.push(hook);
}

/** Single entry point for "structure, roles or membership changed". */
export function serverChanged(serverId: string): void {
  sendToServer(serverId, { t: "SERVER_REFRESH", d: { serverId } });
  for (const hook of refreshHooks) hook(serverId);
}
