import type { FastifyInstance } from "fastify";
import { config } from "./config.ts";
import { all, one, run, tx } from "./db.ts";
import { HttpError } from "./errors.ts";
import { discardBlobs } from "./uploads.ts";

/**
 * TODO item 1: with Annoy accounts (ANNOY_ACCOUNT_MODE=global) friends, DMs,
 * status and direct calls belong to the Annoy cloud (usersannoy, chatannoy),
 * not to any server. A server keeps only what happens inside it.
 * Servers with local accounts keep the old flows unchanged.
 */
export const annoySocial = config.accountMode === "global";

const MOVED = "Amigos, DMs, status e chamadas privadas agora ficam na conta Annoy, fora dos servidores. Atualize o Annoy.";

const PROFILE_MOVED = "Perfil, contatos, histórico de atividade e Steam agora ficam na conta Annoy, fora dos servidores. Atualize o Annoy.";

/**
 * User settings belong to the Annoy account, not to a server: profile contacts,
 * activity history, the Steam link and extra sign-in methods (Discord). The
 * server keeps only a copy of name, bio and photo, written by the app from the
 * Annoy profile, so members can see them.
 */
export function userSettingsMovedRoutes(app: FastifyInstance): void {
  const gone = async () => {
    throw new HttpError(410, "moved_to_annoy", PROFILE_MOVED);
  };
  for (const [method, url] of [
    ["GET", "/users/:id/profile"],
    ["PATCH", "/users/@me/profile"],
    ["DELETE", "/users/@me/activity-history"],
    ["GET", "/users/@me/steam"],
    ["DELETE", "/users/@me/steam"],
    ["GET", "/users/@me/steam/activity"],
    ["POST", "/auth/steam/begin"],
    ["POST", "/auth/steam/poll"],
    ["GET", "/auth/steam/callback"],
    ["POST", "/auth/discord/begin"],
    ["POST", "/auth/discord/poll"],
    ["GET", "/auth/discord/callback"],
  ] as const)
    app.route({ method, url, handler: gone });
}

/** Once per server: the user settings it held go away; they live in the Annoy account now. */
export function retireServerUserSettings(): { steam: number; fields: number; history: number } | null {
  if (!annoySocial || one("SELECT 1 AS x FROM instance_settings WHERE key = 'profile.movedToAnnoy'")) return null;
  const count = (table: string) => one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
  const result = { steam: count("steam_connections"), fields: count("profile_fields"), history: count("activity_history") };
  tx(() => {
    run("DELETE FROM steam_connections");
    run("DELETE FROM profile_fields");
    run("DELETE FROM profile_privacy");
    run("DELETE FROM activity_history");
    run("UPDATE users SET discord_id = NULL WHERE discord_id IS NOT NULL");
    run("INSERT INTO instance_settings (key, value) VALUES ('profile.movedToAnnoy', ?)", new Date().toISOString());
  });
  return result;
}

/** Old routes answer 410 so an outdated app says why instead of failing silently. */
export function socialMovedRoutes(app: FastifyInstance): void {
  const gone = async () => {
    throw new HttpError(410, "moved_to_annoy", MOVED);
  };
  for (const [method, url] of [
    ["GET", "/relationships"],
    ["POST", "/relationships"],
    ["PUT", "/relationships/:userId"],
    ["DELETE", "/relationships/:userId"],
    ["PATCH", "/relationships/:userId/nickname"],
    ["POST", "/dms"],
    ["POST", "/calls"],
  ] as const)
    app.route({ method, url, handler: gone });
}

/**
 * Once per server: the DMs and friend lists it held go away (the user chose
 * to start over; nothing is copied). Their files on disk go too.
 */
export async function retireServerSocial(): Promise<{ dms: number; relationships: number } | null> {
  if (!annoySocial || one("SELECT 1 AS x FROM instance_settings WHERE key = 'social.movedToAnnoy'")) return null;
  const dms = all<{ id: string }>("SELECT id FROM channels WHERE type = 'dm'").map((r) => r.id);
  const files = dms.length
    ? all<{ id: string }>(`SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id IN (${dms.map(() => "?").join(",")})`, ...dms).map((r) => r.id)
    : [];
  const relationships = one<{ n: number }>("SELECT count(*) AS n FROM relationships")!.n;
  tx(() => {
    if (dms.length) run(`DELETE FROM channels WHERE id IN (${dms.map(() => "?").join(",")})`, ...dms);
    run("DELETE FROM relationships");
    run("INSERT INTO instance_settings (key, value) VALUES ('social.movedToAnnoy', ?)", new Date().toISOString());
  });
  await discardBlobs(files);
  return { dms: dms.length, relationships };
}
