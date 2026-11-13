import type { FastifyInstance, HTTPMethods } from "fastify";
import { z } from "zod";
import { db, all, one, run } from "../db.ts";
import { badRequest, forbidden, notFound } from "../errors.ts";
import { config } from "../config.ts";
import { legacyConnections, legacyState, prepareLegacyRetirement } from '../handoff.ts';
import { getChannel, getServer, getUser } from "../repo.ts";
import { ADMIN_TOKEN_HEADER } from "../admin-control.ts";
import { deleteAccount, disconnectEverywhere } from "../accounts.ts";
import { connectionsOf, sendToAudience } from "../events.ts";
import { parse, type Params } from "../validate.ts";

const catalogue: { method: string; path: string }[] = [];
const controllable = /^\/(servers|channels|invites|stickers|sticker-info|uploads|import)(\/|$)/;

export function captureControlRoutes(app: FastifyInstance): void {
  app.addHook("onRoute", route => {
    const path = route.url.replace(/^\/api(?=\/)/, "");
    if (!controllable.test(path)) return;
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method !== "HEAD" && !catalogue.some(r => r.method === method && r.path === path)) catalogue.push({ method, path });
    }
  });
}

const dispatch = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(4096),
  actorId: z.string().max(128).optional(),
  body: z.unknown().optional(),
  bodyBase64: z.string().optional(),
  contentType: z.string().max(256).optional(),
});

const sensitive = /password|token|secret|private|credential|authorization|recovery|salt/i;

/** Registered underneath adminRoutes: every route inherits requireHostAdmin. */
export async function hostDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/host/capabilities", async () => ({ version: 1, accountMode: config.accountMode, scope: 'instance', legacyGateway: legacyState(), routes: catalogue }));
  app.post('/admin/host/handoff/prepare',async req=>{
    const body=parse(z.object({slot:z.enum(['annoy','annoy-b']),target:z.enum(['annoy','annoy-b'])}).strict(),req.body);
    if(body.slot!==process.env.ANNOY_SLOT)throw badRequest('Contêiner de origem incorreto');
    const filename=new URL('../../scripts/handoff/legacy.mjs',import.meta.url).href;
    return(await import(filename)).install(body);
  });
  app.post('/admin/host/handoff/retire',async()=>({ready:await prepareLegacyRetirement()}));

  app.post("/admin/host/request", { bodyLimit: 700 * 1024 * 1024 }, async req => {
    const body = parse(dispatch, req.body);
    if (!body.path.startsWith("/") || body.path.startsWith("//") || /[\\#\r\n]|%2f|%5c|%2e/i.test(body.path)) throw badRequest("Caminho inválido");
    const url = new URL(body.path, "http://host.invalid");
    if (url.pathname !== body.path.split("?")[0] || !controllable.test(url.pathname)) throw badRequest("Recurso fora da administração de comunidades");
    const known = catalogue.some(r => r.method === body.method && new RegExp("^" + r.path.split("/").map(p => p.startsWith(":") ? "[^/]+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/") + "$" ).test(url.pathname));
    if (!known) throw notFound("Operação");
    const parts = url.pathname.split("/");
    const resourceId = decodeURIComponent(parts[2] ?? "");
    let actorId = body.actorId;
    if (parts[1] === "servers" && resourceId) actorId = getServer(resourceId)?.ownerId;
    if (parts[1] === "channels" && resourceId) {
      const channel = getChannel(resourceId);
      if (!channel?.serverId) throw badRequest("O painel administra canais de comunidades deste servidor");
      actorId = getServer(channel.serverId)?.ownerId;
    }
    if (parts[1] === "uploads" && resourceId) {
      const row = one<{ owner_id: string }>("SELECT s.owner_id FROM attachments a JOIN messages m ON m.id=a.message_id JOIN channels c ON c.id=m.channel_id JOIN servers s ON s.id=c.server_id WHERE a.id=?", resourceId);
      if (!row) throw notFound("Arquivo da comunidade");
      actorId = row.owner_id;
    }
    actorId ??= one<{ id: string }>("SELECT id FROM users WHERE imported_from IS NULL AND username NOT LIKE 'deleted.%' ORDER BY is_admin DESC, created_at LIMIT 1")?.id;
    if (!actorId || !getUser(actorId)) throw badRequest("Selecione uma conta existente como proprietário");
    const actor = actorId;
    const response = await app.inject({
      method: body.method as HTTPMethods,
      url: `/api${body.path}`,
      remoteAddress: "127.0.0.1",
      headers: { [ADMIN_TOKEN_HEADER]: String(req.headers[ADMIN_TOKEN_HEADER]), 'x-annoy-host-actor': actor, ...(body.bodyBase64 ? { "content-type": body.contentType ?? "application/octet-stream" } : body.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body.bodyBase64 ? { payload: Buffer.from(body.bodyBase64, "base64") } : body.body === undefined ? {} : { payload: JSON.stringify(body.body) }),
    });
    const contentType = String(response.headers["content-type"] ?? "application/json");
    return { status: response.statusCode, contentType, ...(contentType.includes("json") ? { data: response.json() } : { bodyBase64: response.rawPayload.toString("base64") }) };
  });

  app.get<Params<"id">>("/admin/host/users/:id", async req => {
    const user = getUser(req.params.id);
    if (!user) throw notFound("Usuário");
    const sessions = all<{ created_at: string; expires_at: string; account_mode: string }>("SELECT created_at, expires_at, account_mode FROM sessions WHERE user_id = ? ORDER BY created_at DESC", user.id);
    return { user, sessions, connections: connectionsOf(user.id).size + legacyConnections(user.id), memberships: all("SELECT m.server_id, s.name, m.nick, m.joined_at FROM members m JOIN servers s ON s.id=m.server_id WHERE m.user_id=?", user.id) };
  });

  app.patch<Params<"id">>("/admin/host/users/:id", async req => {
    if (config.accountMode !== 'local') throw forbidden('Perfis Global são gerenciados na conta Annoy. Este painel administra somente a instância.');
    if (!getUser(req.params.id)) throw notFound("Usuário");
    const body = parse(z.object({ displayName: z.string().trim().min(1).max(64).optional(), bio: z.string().max(2000).optional() }).strict(), req.body);
    if (body.displayName !== undefined) run("UPDATE users SET display_name=? WHERE id=?", body.displayName, req.params.id);
    if (body.bio !== undefined) run("UPDATE users SET bio=? WHERE id=?", body.bio, req.params.id);
    const updated = getUser(req.params.id)!;
    sendToAudience(req.params.id, { t: 'USER_UPDATE', d: updated });
    return updated;
  });

  app.delete<Params<"id">>("/admin/host/users/:id/sessions", async req => {
    if (!getUser(req.params.id)) throw notFound("Usuário");
    disconnectEverywhere(req.params.id, "Sessões revogadas pela administração");
    return {};
  });

  app.get("/admin/host/invites", async () => all("SELECT i.*, s.name AS server_name FROM invites i JOIN servers s ON s.id=i.server_id ORDER BY i.created_at DESC LIMIT 1000"));
  app.post<Params<"id">>("/admin/host/users/:id/remove-from-instance", async req => {
    parse(z.object({ confirm: z.literal('REMOVER_DESTA_INSTANCIA') }).strict(), req.body);
    if (!getUser(req.params.id)) throw notFound('Usuário desta instância');
    await deleteAccount(req.params.id);
    return { removedFrom: 'instance', globalAccountDeleted: false };
  });
  app.delete<Params<"code">>("/admin/host/invites/:code", async req => { run("DELETE FROM invites WHERE code=?", req.params.code); return {}; });

  app.get("/admin/host/storage", async () => {
    const tables = all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    return { integrity: db.prepare("PRAGMA quick_check").get(), tables: tables.map(t => ({ name: t.name, rows: (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replaceAll('"', '""')}"`).get() as { n: number }).n })) };
  });
  app.get<Params<"table">>("/admin/host/storage/:table", async req => {
    const table = req.params.table;
    if (!/^[a-z][a-z0-9_]*$/.test(table) || !one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table)) throw notFound("Tabela");
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    const rows = db.prepare(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`).all(query.limit, query.offset);
    return { rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, sensitive.test(key) || (key === 'value' && sensitive.test(String(row.key ?? ''))) ? "[protegido]" : value]))), columns: db.prepare(`PRAGMA table_info("${table}")`).all() };
  });
}
