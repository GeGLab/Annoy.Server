import type { UserActivity } from "@distopic/protocol";
import { z } from "zod";
import { all, one } from "./db.ts";
import { sendToUser, onServerChanged, type Connection } from "./events.ts";
import { relationshipStatus } from "./repo.ts";

const entry = z.object({
  kind: z.enum(["game", "music", "development"]),
  provider: z.enum(["steam", "spotify", "apple-music", "vscode", "intellij", "dbeaver", "ssms", "visual-studio"]),
  name: z.string().trim().min(1).max(160), artist: z.string().max(160).optional(), album: z.string().max(160).optional(),
  appId: z.string().regex(/^\d{1,10}$/).optional(), startedAt: z.number().int().min(0).optional(),
  artwork: z.string().max(24000).optional(), file: z.string().max(160).optional(), project: z.string().max(160).optional(), language: z.string().max(32).optional(),
}).strict();
const payload = z.array(entry).max(3).refine((items) =>
  new Set(items.map((item) => item.kind)).size === items.length &&
  items.every((item) => item.kind === "game" ? item.provider === "steam" && !!item.appId : item.kind === "music" ? ["spotify", "apple-music"].includes(item.provider) : ["vscode", "intellij", "dbeaver", "ssms", "visual-studio"].includes(item.provider)) &&
  items.every((item) => !item.artwork || (item.kind === "music" ? /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(item.artwork) : /^https:\/\/[a-z0-9.-]+\.steamstatic\.com\/(?:store_item_assets\/)?steam\/apps\/\d+\/[a-zA-Z0-9_/.?=&%-]+$/.test(item.artwork)))
);
const live = new Map<number, { userId: string; at: number; activities: UserActivity[] }>();
const TTL = 75_000;
export function areFriends(a: string, b: string) {
  return relationshipStatus(a, b) === "friend" && relationshipStatus(b, a) === "friend";
}
export function activityOf(userId: string): UserActivity[] {
  return [...live.values()].filter((v) => v.userId === userId && Date.now() - v.at < TTL).sort((a, b) => b.at - a.at)[0]?.activities ?? [];
}
function friendIds(userId: string) {
  return all<{ other_id: string }>(
    "SELECT a.other_id FROM relationships a JOIN relationships b ON b.user_id=a.other_id AND b.other_id=a.user_id WHERE a.user_id=? AND a.status='friend' AND b.status='friend'",
    userId,
  ).map((r) => r.other_id);
}
function groupIds(userId: string) {
  return all<{id: string}>("SELECT DISTINCT b.user_id AS id FROM members a JOIN members b ON a.server_id=b.server_id WHERE a.user_id=?", userId).map((row) => row.id);
}
export function canSeeActivity(viewer: string, subject: string): boolean {
  return viewer === subject || areFriends(viewer, subject) || !!one("SELECT 1 FROM members a JOIN members b ON a.server_id=b.server_id WHERE a.user_id=? AND b.user_id=? LIMIT 1", viewer, subject);
}
const viewers = new Map<string, Set<string>>();
function broadcast(userId: string) {
  const activities = activityOf(userId);
  const audience = new Set([userId, ...friendIds(userId), ...groupIds(userId)]);
  for (const id of viewers.get(userId) ?? []) if (!audience.has(id)) sendToUser(id, { t: "ACTIVITY_UPDATE", d: { userId, activities: [] } });
  for (const id of audience) sendToUser(id, { t: "ACTIVITY_UPDATE", d: { userId, activities } });
  if (activities.length) viewers.set(userId, audience);
  else viewers.delete(userId);
}
export function activitiesFor(userId: string) {
  return Object.fromEntries([...new Set([userId, ...friendIds(userId), ...groupIds(userId)])].map((id) => [id, activityOf(id)]));
}
export function updateActivity(conn: Connection, raw: unknown): boolean {
  if (!conn.userId) return false;
  if (Date.now() - conn.activityWindowAt >= 10_000) {
    conn.activityWindowAt = Date.now();
    conn.activityCount = 0;
  }
  if (++conn.activityCount > 10) return false;
  const parsed = payload.safeParse(raw);
  if (!parsed.success) return false;
  const at = Date.now();
  const previous = activityOf(conn.userId);
  const activities = parsed.data.map((item) => ({
    ...item,
    startedAt: item.startedAt === undefined ? undefined : Math.min(at, Math.max(at - 7 * 86400_000, item.startedAt)),
  }));
  if (activities.length) live.set(conn.id, { userId: conn.userId, at, activities });
  else live.delete(conn.id);
  if (JSON.stringify(previous) !== JSON.stringify(activityOf(conn.userId))) broadcast(conn.userId);
  return true;
}
export function clearActivity(conn: Connection) {
  if (live.delete(conn.id) && conn.userId) broadcast(conn.userId);
}
export function clearUserActivity(userId: string) {
  for (const [id, value] of live) if (value.userId === userId) live.delete(id);
  broadcast(userId);
}
export function expireActivities() {
  const changed = new Set<string>();
  for (const [id, v] of live)
    if (Date.now() - v.at >= TTL) {
      live.delete(id);
      changed.add(v.userId);
    }
  for (const id of changed) broadcast(id);
}
export function refreshActivityAccess() {
  for (const userId of new Set([...live.values()].map((entry) => entry.userId).concat([...viewers.keys()]))) broadcast(userId);
}
onServerChanged(refreshActivityAccess);
/** Friendships and shared server memberships both grant activity access. */
export function refreshFriendActivities(a: string, b: string) {
  for (const [viewer, subject] of [
    [a, b],
    [b, a],
  ])
    sendToUser(viewer!, { t: "ACTIVITY_UPDATE", d: { userId: subject!, activities: canSeeActivity(viewer!, subject!) ? activityOf(subject!) : [] } });
}
