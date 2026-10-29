import type { FastifyInstance } from "fastify";
import { has, Permission, type MessageSearchPage } from "@distopic/protocol";
import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { requireUser } from "../auth.ts";
import { all } from "../db.ts";
import { badRequest } from "../errors.ts";
import { channelPermissions, requireChannel, requireServer } from "../perms.ts";
import { getChannel, hydrate, type MessageRow } from "../repo.ts";
import { parse } from "../validate.ts";
const query = z.object({
  q: z.string().trim().max(200).default(""),
  serverId: z.string().max(100).optional(),
  channelId: z.string().max(100).optional(),
  authorId: z.string().max(100).optional(),
  has: z.enum(["image", "video", "audio", "file", "link"]).optional(),
  before: z.iso.date().optional(),
  after: z.iso.date().optional(),
  cursor: z.string().max(100).optional(),
});
export function searchRoutes(app: FastifyInstance) {
  app.get("/search/messages", async (req): Promise<MessageSearchPage> => {
    const userId = requireUser(req),
      q = parse(query, req.query);
    if (q.serverId) requireServer(q.serverId, userId);
    if (q.channelId) requireChannel(q.channelId, userId);
    if (!q.q && !q.authorId && !q.has && !q.before && !q.after) throw badRequest("Digite uma busca ou escolha um filtro.");
    const candidates = all<{ id: string }>(
      `SELECT c.id FROM channels c WHERE c.type IN ('text','dm') AND (EXISTS(SELECT 1 FROM members m WHERE m.server_id=c.server_id AND m.user_id=?) OR EXISTS(SELECT 1 FROM dm_recipients d WHERE d.channel_id=c.id AND d.user_id=?)) ${q.serverId ? "AND c.server_id=?" : ""} ${q.channelId ? "AND c.id=?" : ""}`,
      userId,
      userId,
      ...(q.serverId ? [q.serverId] : []),
      ...(q.channelId ? [q.channelId] : []),
    );
    const allowed = candidates
      .map((r) => getChannel(r.id)!)
      .filter((c) => c && has(channelPermissions(c, userId), Permission.VIEW_CHANNEL));
    if (!allowed.length) return { items: [], nextCursor: null };
    const params: SQLInputValue[] = allowed.map((c) => c.id);
    const where = [`m.channel_id IN (${allowed.map(() => "?").join(",")})`];
    const terms = q.q.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (q.q && !terms.length) throw badRequest("Busque por uma palavra ou número.");
    if (terms.length) {
      where.push("m.rowid IN (SELECT rowid FROM messages_search WHERE messages_search MATCH ?)");
      params.push(terms.map((t) => `"${t}"*`).join(" AND "));
    }
    for (const [key, condition] of [
      ["authorId", "m.author_id=?"],
      ["cursor", "m.id<?"],
      ["before", "m.created_at<?"],
      ["after", "m.created_at>=?"],
    ] as const)
      if (q[key]) {
        where.push(condition);
        params.push(q[key]!);
      }
    if (q.has === "link") where.push("(instr(m.content,'https://')>0 OR instr(m.content,'http://')>0)");
    else if (q.has) {
      where.push("EXISTS(SELECT 1 FROM attachments a WHERE a.message_id=m.id" + (q.has === "file" ? ")" : " AND a.content_type LIKE ?)"));
      if (q.has !== "file") params.push(`${q.has}/%`);
    }
    const rows = all<MessageRow>(`SELECT m.* FROM messages m WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT 26`, ...params);
    const page = rows.slice(0, 25),
      channels = new Map(allowed.map((c) => [c.id, c]));
    return {
      items: hydrate(page).map((message) => ({
        message,
        channelName: channels.get(message.channelId)!.name || "Mensagem direta",
        serverId: channels.get(message.channelId)!.serverId,
      })),
      nextCursor: rows.length > 25 ? page.at(-1)!.id : null,
    };
  });
}
