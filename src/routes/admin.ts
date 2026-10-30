// Instance administration: only the person hosting the instance (is_admin).
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AdminOverview, AdminServer, AdminUser, SignupInvite } from "@distopic/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deleteAccount, disconnectEverywhere, ownedServerNames } from "../accounts.ts";
import { requireUser } from "../auth.ts";
import { config } from "../config.ts";
import { all, now, one, run } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { sendToAudience } from "../events.ts";
import { inviteCode } from "../ids.ts";
import { getSettings, requireAdmin, updateSettings } from "../instance.ts";
import { getServer, getUser, getUsers } from "../repo.ts";
import { usage as voiceUsage } from "../sfu-budget.ts";
import { parse, type Params } from "../validate.ts";
import { deleteServer } from "./servers.ts";

const settingsBody = z.object({
  registration: z.enum(["open", "invite", "closed"]).optional(),
  maxServersPerUser: z.number().int().min(1).max(10_000).nullable().optional(),
  maxUploadMb: z.number().int().min(1).max(500).optional(),
});
const inviteBody = z.object({
  maxUses: z.number().int().min(1).max(10_000).nullable().optional(),
  expiresInHours: z.number().min(0.5).max(24 * 365).nullable().optional(),
});
const banBody = z.object({ reason: z.string().max(512).optional() });
const patchUser = z.object({ isAdmin: z.boolean() });
const listQuery = z.object({ q: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
const deleteQuery = z.object({ deleteMessages: z.enum(["0", "1"]).default("0") });

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(path) : (await stat(path)).size;
  }
  return total;
}

interface UserRow {
  id: string;
  created_at: string;
  is_admin: number;
  banned_at: string | null;
  ban_reason: string;
  discord_id: string | null;
  imported_from: string | null;
  servers: number;
}

function toAdminUsers(rows: UserRow[]): AdminUser[] {
  const users = getUsers(rows.map((r) => r.id));
  return rows.flatMap((r) => {
    const user = users.get(r.id);
    return user
      ? [
          {
            user,
            createdAt: r.created_at,
            isAdmin: r.is_admin === 1,
            bannedAt: r.banned_at,
            banReason: r.ban_reason,
            serverCount: r.servers,
            discordLinked: r.discord_id !== null,
            imported: r.imported_from !== null,
          },
        ]
      : [];
  });
}

/** Admins can't act on themselves or on other admins in destructive ways; demote first. */
function requireTarget(actorId: string, targetId: string): void {
  if (actorId === targetId) throw badRequest("Use as configurações da sua conta para isso");
  const row = one<{ is_admin: number }>("SELECT is_admin FROM users WHERE id = ?", targetId);
  if (!row) throw notFound("Usuário");
  if (row.is_admin === 1) throw forbidden("Remova o cargo de administrador antes");
}

/** Register inside its own plugin scope so the admin check covers exactly these routes. */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req) => requireAdmin(requireUser(req)));

  app.get("/admin/overview", async (): Promise<AdminOverview> => ({
    settings: getSettings(),
    userCount: one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE imported_from IS NULL AND username NOT LIKE 'deleted.%'")!.n,
    serverCount: one<{ n: number }>("SELECT COUNT(*) AS n FROM servers")!.n,
    messageCount: one<{ n: number }>("SELECT COUNT(*) AS n FROM messages")!.n,
    uploadsBytes: await dirSize(join(config.dataDir, "uploads")),
    voiceUsage: config.voice.backend === "cloudflare" ? voiceUsage() : null,
  }));

  app.patch("/admin/settings", async (req) => updateSettings(parse(settingsBody, req.body)));

  // Sign-up invites -------------------------------------------------------------

  app.get("/admin/invites", async (): Promise<SignupInvite[]> => {
    const rows = all<{ code: string; uses: number; max_uses: number | null; expires_at: string | null; created_at: string; created_by: string | null }>(
      "SELECT * FROM signup_invites ORDER BY created_at DESC",
    );
    const users = getUsers(rows.flatMap((r) => (r.created_by ? [r.created_by] : [])));
    return rows.map((r) => ({
      code: r.code,
      uses: r.uses,
      maxUses: r.max_uses,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      createdBy: r.created_by ? (users.get(r.created_by) ?? null) : null,
    }));
  });

  app.post("/admin/invites", async (req) => {
    const userId = requireUser(req);
    const body = parse(inviteBody, req.body);
    const code = inviteCode();
    const expiresAt = body.expiresInHours ? new Date(Date.now() + body.expiresInHours * 3_600_000).toISOString() : null;
    run(
      "INSERT INTO signup_invites (code, created_by, uses, max_uses, expires_at, created_at) VALUES (?, ?, 0, ?, ?, ?)",
      code,
      userId,
      body.maxUses ?? null,
      expiresAt,
      now(),
    );
    return { code, uses: 0, maxUses: body.maxUses ?? null, expiresAt, createdAt: now(), createdBy: getUser(userId) ?? null } satisfies SignupInvite;
  });

  app.delete<Params<"code">>("/admin/invites/:code", async (req) => {
    run("DELETE FROM signup_invites WHERE code = ?", req.params.code);
    return {};
  });

  // Accounts --------------------------------------------------------------------

  app.get("/admin/users", async (req): Promise<AdminUser[]> => {
    const q = parse(listQuery, req.query);
    const like = `%${(q.q ?? "").replace(/[%_]/g, "")}%`;
    return toAdminUsers(
      all<UserRow>(
        `SELECT u.id, u.created_at, u.is_admin, u.banned_at, u.ban_reason, u.discord_id, u.imported_from,
                (SELECT COUNT(*) FROM servers s WHERE s.owner_id = u.id) AS servers
           FROM users u
          WHERE u.username NOT LIKE 'deleted.%' AND (u.username LIKE ? OR u.display_name LIKE ?)
          ORDER BY u.imported_from IS NOT NULL, u.created_at DESC
          LIMIT ?`,
        like,
        like,
        q.limit,
      ),
    );
  });

  app.patch<Params<"id">>("/admin/users/:id", async (req) => {
    const actor = requireUser(req);
    const body = parse(patchUser, req.body);
    if (req.params.id === actor && !body.isAdmin) throw badRequest("Você não pode remover o próprio cargo de administrador");
    const row = one<{ imported_from: string | null; banned_at: string | null }>("SELECT imported_from, banned_at FROM users WHERE id = ?", req.params.id);
    if (!row) throw notFound("Usuário");
    if (body.isAdmin && (row.imported_from || row.banned_at)) throw badRequest("Só contas ativas podem ser administradoras");
    run("UPDATE users SET is_admin = ? WHERE id = ?", body.isAdmin ? 1 : 0, req.params.id);
    return {};
  });

  app.post<Params<"id">>("/admin/users/:id/ban", async (req) => {
    const actor = requireUser(req);
    requireTarget(actor, req.params.id);
    const body = parse(banBody, req.body);
    run("UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?", now(), body.reason ?? "", req.params.id);
    disconnectEverywhere(req.params.id, "Conta suspensa nesta instância");
    sendToAudience(req.params.id, { t: "PRESENCE_UPDATE", d: { userId: req.params.id, presence: "offline" } });
    return {};
  });

  app.delete<Params<"id">>("/admin/users/:id/ban", async (req) => {
    run("UPDATE users SET banned_at = NULL, ban_reason = '' WHERE id = ?", req.params.id);
    return {};
  });

  app.delete<Params<"id">>("/admin/users/:id", async (req) => {
    const actor = requireUser(req);
    requireTarget(actor, req.params.id);
    const q = parse(deleteQuery, req.query);
    const owned = ownedServerNames(req.params.id);
    if (owned.length > 0) throw conflict(`Esta conta é dona de servidores; exclua-os antes: ${owned.join(", ")}`);
    await deleteAccount(req.params.id, { deleteMessages: q.deleteMessages === "1" });
    return {};
  });

  // Servers -----------------------------------------------------------------

  app.get("/admin/servers", async (): Promise<AdminServer[]> => {
    const rows = all<{ id: string; owner_id: string; created_at: string; members: number; channels: number }>(
      `SELECT s.id, s.owner_id, s.created_at,
              (SELECT COUNT(*) FROM members m WHERE m.server_id = s.id) AS members,
              (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channels
         FROM servers s ORDER BY s.created_at DESC`,
    );
    const owners = getUsers(rows.map((r) => r.owner_id));
    return rows.flatMap((r) => {
      const server = getServer(r.id);
      return server
        ? [{ server, owner: owners.get(r.owner_id) ?? null, memberCount: r.members, channelCount: r.channels, createdAt: r.created_at }]
        : [];
    });
  });

  app.delete<Params<"id">>("/admin/servers/:id", async (req) => {
    if (!getServer(req.params.id)) throw notFound("Servidor");
    await deleteServer(req.params.id, requireUser(req));
    return {};
  });
}
