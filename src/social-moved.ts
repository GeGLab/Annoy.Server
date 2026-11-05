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
