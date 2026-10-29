import type { UserActivity } from "@distopic/protocol";
import { z } from "zod";
import { all } from "./db.ts";
import { sendToUser, type Connection } from "./events.ts";
import { relationshipStatus } from "./repo.ts";

const entry = z
  .object({
    kind: z.enum(["game", "music", "development"]),
    provider: z.enum(["steam", "spotify", "apple-music", "vscode", "intellij", "dbeaver", "ssms", "visual-studio"]),
    name: z.string().trim().min(1).max(160),
    artist: z.string().max(160).optional(),
    album: z.string().max(160).optional(),
    appId: z
      .string()
      .regex(/^\d{1,10}$/)
      .optional(),
    startedAt: z.number().int().min(0).optional(),
    artwork: z.string().max(24_000).optional(),
    file: z.string().max(160).optional(),
    project: z.string().max(160).optional(),
    language: z.string().max(32).optional(),
  })
  .strict();
const payload = z
  .array(entry)
  .max(3)
  .refine(
    (items) =>
      new Set(items.map((i) => i.kind)).size === items.length &&
      items.every((i) => i.kind === "game" ? i.provider === "steam" && !!i.appId : i.kind === "music" ? ["spotify", "apple-music"].includes(i.provider) : ["vscode", "intellij", "dbeaver", "ssms", "visual-studio"].includes(i.provider)) &&
      items.every((i) => !i.artwork || (i.kind === "music"
        ? /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(i.artwork)
        : /^https:\/\/[a-z0-9.-]+\.steamstatic\.com\/(?:store_item_assets\/)?steam\/apps\/\d+\/[a-zA-Z0-9_/.?=&%-]+$/.test(i.artwork))),
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
function broadcast(userId: string) {
  const activities = activityOf(userId);
  for (const id of [userId, ...friendIds(userId)]) sendToUser(id, { t: "ACTIVITY_UPDATE", d: { userId, activities } });
}
export function activitiesFor(userId: string) {
  return Object.fromEntries([userId, ...friendIds(userId)].map((id) => [id, activityOf(id)]));
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
/** Friendship changes are immediate; no server membership or DM grants activity access. */
export function refreshFriendActivities(a: string, b: string) {
  for (const [viewer, subject] of [
    [a, b],
    [b, a],
  ])
    sendToUser(viewer!, { t: "ACTIVITY_UPDATE", d: { userId: subject!, activities: areFriends(a, b) ? activityOf(subject!) : [] } });
}
