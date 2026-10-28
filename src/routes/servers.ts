import {
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  has,
  LIMITS,
  Permission,
  type Ban,
  type Invite,
  type ServerState,
} from "@distopic/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.ts";
import { all, now, one, run, tx } from "../db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../errors.ts";
import { sendToUser, serverChanged } from "../events.ts";
import { inviteCode, newId } from "../ids.ts";
import { channelPermissions, rank, requireOutranks, requireServer } from "../perms.ts";
import { getChannels, getMembers, getRole, getRoles, getServer, getUsers, isMember } from "../repo.ts";
import { parse, type Params } from "../validate.ts";
import { disconnectUser, setServerMute, voiceStatesFor } from "../voice.ts";

const name = z.string().trim().min(1).max(LIMITS.nameMax);
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable();
const permissions = z.number().int().min(0).max(ALL_PERMISSIONS);

const createServer = z.object({ name });
const patchServer = z.object({ name });
const createChannel = z.object({
  name,
  type: z.enum(["category", "text", "voice"]),
  parentId: z.string().nullable().optional(),
  topic: z.string().max(LIMITS.topicMax).optional(),
});
const createRole = z.object({ name, color: color.optional(), permissions: permissions.optional() });
const patchRole = z.object({
  name: name.optional(),
  color: color.optional(),
  permissions: permissions.optional(),
  position: z.number().int().min(1).optional(),
});
const patchMember = z.object({ nick: z.string().trim().max(LIMITS.usernameMax).nullable() });
const createInvite = z.object({
  maxUses: z.number().int().min(1).max(10_000).nullable().optional(),
  expiresInHours: z.number().min(0.5).max(24 * 30).nullable().optional(),
});
const banBody = z.object({ reason: z.string().max(512).optional() });
const voiceMod = z.object({ serverMute: z.boolean().optional(), disconnect: z.boolean().optional() });

/** Channel names in the Discord style: lowercase, dashes, no spaces. */
const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, LIMITS.nameMax) || "canal";

export function serverState(serverId: string, userId: string): ServerState {
  const { server, perms } = requireServer(serverId, userId);
  const channels = getChannels(serverId).filter((c) => has(channelPermissions(c, userId), Permission.VIEW_CHANNEL));
  return {
    server,
    channels,
    roles: getRoles(serverId),
    members: getMembers(serverId),
    voiceStates: voiceStatesFor(serverId).filter((v) => channels.some((c) => c.id === v.channelId)),
    permissions: perms,
  };
}

function insertChannel(serverId: string, type: "category" | "text" | "voice", channelName: string, parentId: string | null, topic = ""): string {
  const id = newId();
  const pos = one<{ p: number | null }>("SELECT MAX(position) AS p FROM channels WHERE server_id = ?", serverId)?.p ?? -1;
  run(
    "INSERT INTO channels (id, server_id, type, name, topic, parent_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    serverId,
    type,
    type === "text" ? slug(channelName) : channelName.trim(),
    topic,
    parentId,
    pos + 1,
    now(),
  );
  return id;
}

/** Granting permissions the actor lacks would let MANAGE_ROLES escalate itself. */
function requireGrantable(actorPerms: number, requested: number): void {
  if (!has(actorPerms, Permission.ADMINISTRATOR) && (requested & ~actorPerms) !== 0) {
    throw forbidden("Você não pode conceder permissões que não possui");
  }
}

function removeMember(serverId: string, userId: string): void {
  run("DELETE FROM members WHERE server_id = ? AND user_id = ?", serverId, userId);
  disconnectUser(serverId, userId);
  sendToUser(userId, { t: "SERVER_REMOVE", d: { serverId } });
  serverChanged(serverId);
}

export function serverRoutes(app: FastifyInstance): void {
  // Servers ----------------------------------------------------------------

  app.post("/servers", async (req) => {
    const userId = requireUser(req);
    const body = parse(createServer, req.body);
    const id = newId();
    tx(() => {
      const t = now();
      run("INSERT INTO servers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)", id, body.name, userId, t);
      // @everyone shares the server id, like Discord.
      run("INSERT INTO roles (id, server_id, name, color, permissions, position) VALUES (?, ?, '@everyone', NULL, ?, 0)", id, id, DEFAULT_EVERYONE_PERMISSIONS);
      run("INSERT INTO members (server_id, user_id, nick, joined_at) VALUES (?, ?, NULL, ?)", id, userId, t);
      const text = insertChannel(id, "category", "Canais de texto", null);
      insertChannel(id, "text", "geral", text);
      const voice = insertChannel(id, "category", "Canais de voz", null);
      insertChannel(id, "voice", "Geral", voice);
    });
    const server = getServer(id)!;
    sendToUser(userId, { t: "SERVER_CREATE", d: server });
    return server;
  });

  app.get<Params<"id">>("/servers/:id", async (req) => serverState(req.params.id, requireUser(req)));

  app.patch<Params<"id">>("/servers/:id", async (req) => {
    const userId = requireUser(req);
    requireServer(req.params.id, userId, Permission.MANAGE_SERVER);
    const body = parse(patchServer, req.body);
    run("UPDATE servers SET name = ? WHERE id = ?", body.name, req.params.id);
    serverChanged(req.params.id);
    return getServer(req.params.id);
  });

  app.delete<Params<"id">>("/servers/:id", async (req) => {
    const userId = requireUser(req);
    const { server } = requireServer(req.params.id, userId);
    if (server.ownerId !== userId) throw forbidden("Apenas o dono pode excluir o servidor");
    const members = all<{ user_id: string }>("SELECT user_id FROM members WHERE server_id = ?", server.id);
    for (const m of members) disconnectUser(server.id, m.user_id);
    run("DELETE FROM servers WHERE id = ?", server.id);
    for (const m of members) sendToUser(m.user_id, { t: "SERVER_REMOVE", d: { serverId: server.id } });
    return {};
  });

  // Channels ---------------------------------------------------------------

  app.post<Params<"id">>("/servers/:id/channels", async (req) => {
    const userId = requireUser(req);
    const serverId = req.params.id;
    requireServer(serverId, userId, Permission.MANAGE_CHANNELS);
    const body = parse(createChannel, req.body);
    let parentId = body.parentId ?? null;
    if (body.type === "category") parentId = null;
    if (parentId && !one("SELECT 1 AS x FROM channels WHERE id = ? AND server_id = ? AND type = 'category'", parentId, serverId)) {
      throw badRequest("Categoria inválida");
    }
    const id = insertChannel(serverId, body.type, body.name, parentId, body.topic ?? "");
    serverChanged(serverId);
    return getChannels(serverId).find((c) => c.id === id);
  });

  // Roles ------------------------------------------------------------------

  app.post<Params<"id">>("/servers/:id/roles", async (req) => {
    const userId = requireUser(req);
    const serverId = req.params.id;
    const { perms } = requireServer(serverId, userId, Permission.MANAGE_ROLES);
    const body = parse(createRole, req.body);
    requireGrantable(perms, body.permissions ?? 0);
    const id = newId();
    tx(() => {
      // New roles start at the bottom of the hierarchy.
      run("UPDATE roles SET position = position + 1 WHERE server_id = ? AND position >= 1", serverId);
      run(
        "INSERT INTO roles (id, server_id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?, 1)",
        id,
        serverId,
        body.name,
        body.color ?? null,
        body.permissions ?? 0,
      );
    });
    serverChanged(serverId);
    return getRole(id);
  });

  app.patch<Params<"id" | "roleId">>("/servers/:id/roles/:roleId", async (req) => {
    const userId = requireUser(req);
    const serverId = req.params.id;
    const { perms } = requireServer(serverId, userId, Permission.MANAGE_ROLES);
    const role = getRole(req.params.roleId);
    if (!role || role.serverId !== serverId) throw notFound("Cargo");
    const body = parse(patchRole, req.body);
    const isEveryone = role.id === serverId;
    if (!isEveryone) requireOutranks(serverId, userId, role.position);
    if (isEveryone && (body.name !== undefined || body.position !== undefined)) throw badRequest("@everyone só pode mudar permissões");
    if (body.permissions !== undefined) requireGrantable(perms, body.permissions);

    tx(() => {
      if (body.position !== undefined && body.position !== role.position) {
        if (rank(serverId, userId) <= body.position) throw forbidden("Não é possível mover acima do seu cargo");
        const max = one<{ p: number }>("SELECT MAX(position) AS p FROM roles WHERE server_id = ?", serverId)!.p;
        const target = Math.min(body.position, max);
        // Swap with the role currently at the target slot to keep positions unique.
        run("UPDATE roles SET position = ? WHERE server_id = ? AND position = ?", role.position, serverId, target);
        run("UPDATE roles SET position = ? WHERE id = ?", target, role.id);
      }
      if (body.name !== undefined) run("UPDATE roles SET name = ? WHERE id = ?", body.name, role.id);
      if (body.color !== undefined) run("UPDATE roles SET color = ? WHERE id = ?", body.color, role.id);
      if (body.permissions !== undefined) run("UPDATE roles SET permissions = ? WHERE id = ?", body.permissions, role.id);
    });
    serverChanged(serverId);
    return getRole(role.id);
  });

  app.delete<Params<"id" | "roleId">>("/servers/:id/roles/:roleId", async (req) => {
    const userId = requireUser(req);
    const serverId = req.params.id;
    requireServer(serverId, userId, Permission.MANAGE_ROLES);
    const role = getRole(req.params.roleId);
    if (!role || role.serverId !== serverId) throw notFound("Cargo");
    if (role.id === serverId) throw badRequest("@everyone não pode ser excluído");
    requireOutranks(serverId, userId, role.position);
    tx(() => {
      run("DELETE FROM roles WHERE id = ?", role.id);
      run("DELETE FROM overwrites WHERE target_id = ?", role.id);
      run("UPDATE roles SET position = position - 1 WHERE server_id = ? AND position > ?", serverId, role.position);
    });
    serverChanged(serverId);
    return {};
  });

  app.put<Params<"id" | "userId" | "roleId">>("/servers/:id/members/:userId/roles/:roleId", async (req) => {
    const actor = requireUser(req);
    const { id: serverId, userId, roleId } = req.params;
    requireServer(serverId, actor, Permission.MANAGE_ROLES);
    const role = getRole(roleId);
    if (!role || role.serverId !== serverId || role.id === serverId) throw notFound("Cargo");
    if (!isMember(serverId, userId)) throw notFound("Membro");
    requireOutranks(serverId, actor, role.position);
    run("INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)", serverId, userId, roleId);
    serverChanged(serverId);
    return {};
  });

  app.delete<Params<"id" | "userId" | "roleId">>("/servers/:id/members/:userId/roles/:roleId", async (req) => {
    const actor = requireUser(req);
    const { id: serverId, userId, roleId } = req.params;
    requireServer(serverId, actor, Permission.MANAGE_ROLES);
    const role = getRole(roleId);
    if (!role || role.serverId !== serverId) throw notFound("Cargo");
    requireOutranks(serverId, actor, role.position);
    run("DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?", serverId, userId, roleId);
    serverChanged(serverId);
    return {};
  });

  // Members ----------------------------------------------------------------

  app.patch<Params<"id" | "userId">>("/servers/:id/members/:userId", async (req) => {
    const actor = requireUser(req);
    const { id: serverId } = req.params;
    const userId = req.params.userId === "@me" ? actor : req.params.userId;
    const { server, perms } = requireServer(serverId, actor);
    if (!isMember(serverId, userId)) throw notFound("Membro");
    if (userId !== actor) {
      if (!has(perms, Permission.MANAGE_SERVER) || server.ownerId === userId) throw forbidden();
      requireOutranks(serverId, actor, rank(serverId, userId));
    }
    const body = parse(patchMember, req.body);
    run("UPDATE members SET nick = ? WHERE server_id = ? AND user_id = ?", body.nick || null, serverId, userId);
    serverChanged(serverId);
    return {};
  });

  app.delete<Params<"id" | "userId">>("/servers/:id/members/:userId", async (req) => {
    const actor = requireUser(req);
    const { id: serverId } = req.params;
    const { server } = requireServer(serverId, actor);
    if (req.params.userId === "@me" || req.params.userId === actor) {
      if (server.ownerId === actor) throw badRequest("O dono não pode sair; exclua o servidor");
      removeMember(serverId, actor);
      return {};
    }
    const target = req.params.userId;
    requireServer(serverId, actor, Permission.KICK_MEMBERS);
    if (!isMember(serverId, target)) throw notFound("Membro");
    if (server.ownerId === target) throw forbidden("O dono não pode ser expulso");
    requireOutranks(serverId, actor, rank(serverId, target));
    removeMember(serverId, target);
    return {};
  });

  app.patch<Params<"id" | "userId">>("/servers/:id/members/:userId/voice", async (req) => {
    const actor = requireUser(req);
    const { id: serverId, userId } = req.params;
    requireServer(serverId, actor, Permission.MUTE_MEMBERS);
    if (userId !== actor) requireOutranks(serverId, actor, rank(serverId, userId));
    const body = parse(voiceMod, req.body);
    if (body.serverMute !== undefined) await setServerMute(serverId, userId, body.serverMute);
    if (body.disconnect) disconnectUser(serverId, userId);
    return {};
  });

  // Bans -------------------------------------------------------------------

  app.get<Params<"id">>("/servers/:id/bans", async (req): Promise<Ban[]> => {
    requireServer(req.params.id, requireUser(req), Permission.BAN_MEMBERS);
    const rows = all<{ user_id: string; reason: string }>("SELECT user_id, reason FROM bans WHERE server_id = ?", req.params.id);
    const users = getUsers(rows.map((r) => r.user_id));
    return rows.flatMap((r) => {
      const user = users.get(r.user_id);
      return user ? [{ user, reason: r.reason }] : [];
    });
  });

  app.put<Params<"id" | "userId">>("/servers/:id/bans/:userId", async (req) => {
    const actor = requireUser(req);
    const { id: serverId, userId } = req.params;
    const { server } = requireServer(serverId, actor, Permission.BAN_MEMBERS);
    if (userId === actor || server.ownerId === userId) throw forbidden("Não é possível banir este usuário");
    if (isMember(serverId, userId)) requireOutranks(serverId, actor, rank(serverId, userId));
    const body = parse(banBody, req.body);
    run("INSERT OR REPLACE INTO bans (server_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)", serverId, userId, body.reason ?? "", now());
    if (isMember(serverId, userId)) removeMember(serverId, userId);
    return {};
  });

  app.delete<Params<"id" | "userId">>("/servers/:id/bans/:userId", async (req) => {
    requireServer(req.params.id, requireUser(req), Permission.BAN_MEMBERS);
    run("DELETE FROM bans WHERE server_id = ? AND user_id = ?", req.params.id, req.params.userId);
    return {};
  });

  // Invites ----------------------------------------------------------------

  app.post<Params<"id">>("/servers/:id/invites", async (req) => {
    const userId = requireUser(req);
    const { server } = requireServer(req.params.id, userId, Permission.CREATE_INVITE);
    const body = parse(createInvite, req.body);
    const code = inviteCode();
    const expiresAt = body.expiresInHours ? new Date(Date.now() + body.expiresInHours * 3_600_000).toISOString() : null;
    run(
      "INSERT INTO invites (code, server_id, creator_id, uses, max_uses, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
      code,
      server.id,
      userId,
      body.maxUses ?? null,
      expiresAt,
      now(),
    );
    return invitePreview(code);
  });

  app.get<Params<"code">>("/invites/:code", async (req) => invitePreview(req.params.code));

  app.post<Params<"code">>("/invites/:code", async (req) => {
    const userId = requireUser(req);
    const invite = invitePreview(req.params.code);
    const serverId = invite.server.id;
    if (isMember(serverId, userId)) return invite.server;
    if (one("SELECT 1 AS x FROM bans WHERE server_id = ? AND user_id = ?", serverId, userId)) {
      throw forbidden("Você está banido deste servidor");
    }
    tx(() => {
      run("INSERT INTO members (server_id, user_id, nick, joined_at) VALUES (?, ?, NULL, ?)", serverId, userId, now());
      run("UPDATE invites SET uses = uses + 1 WHERE code = ?", invite.code);
    });
    sendToUser(userId, { t: "SERVER_CREATE", d: invite.server });
    serverChanged(serverId);
    return invite.server;
  });
}

function invitePreview(code: string): Invite {
  const row = one<{ code: string; server_id: string; uses: number; max_uses: number | null; expires_at: string | null }>(
    "SELECT code, server_id, uses, max_uses, expires_at FROM invites WHERE code = ?",
    code,
  );
  const server = row && getServer(row.server_id);
  if (!row || !server) throw notFound("Convite");
  if (row.expires_at && row.expires_at < now()) throw new HttpError(410, "invite_expired", "Convite expirado");
  if (row.max_uses !== null && row.uses >= row.max_uses) throw new HttpError(410, "invite_exhausted", "Convite esgotado");
  const count = one<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE server_id = ?", server.id)!.n;
  return { code: row.code, server, uses: row.uses, maxUses: row.max_uses, expiresAt: row.expires_at, memberCount: count };
}

