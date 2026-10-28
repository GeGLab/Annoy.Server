import { computePermissions, has, Permission, type Channel, type ServerSummary } from "@distopic/protocol";
import { forbidden, notFound } from "./errors.ts";
import { dmRecipientIds, getChannel, getRoles, getServer, isMember, memberRoleIds } from "./repo.ts";

const DM_PERMISSIONS = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.ATTACH_FILES;

/** Server-level permissions, or null when the user is not a member. */
export function serverPermissions(serverId: string, userId: string): number | null {
  const server = getServer(serverId);
  if (!server || !isMember(serverId, userId)) return null;
  return computePermissions({
    ownerId: server.ownerId,
    userId,
    everyoneRoleId: serverId,
    roles: getRoles(serverId),
    memberRoleIds: memberRoleIds(serverId, userId),
  });
}

export function channelPermissions(channel: Channel, userId: string): number {
  if (channel.type === "dm") return dmRecipientIds(channel.id).includes(userId) ? DM_PERMISSIONS : 0;
  const serverId = channel.serverId;
  if (!serverId) return 0;
  const server = getServer(serverId);
  if (!server || !isMember(serverId, userId)) return 0;
  return computePermissions({
    ownerId: server.ownerId,
    userId,
    everyoneRoleId: serverId,
    roles: getRoles(serverId),
    memberRoleIds: memberRoleIds(serverId, userId),
    overwrites: channel.overwrites,
  });
}

export function requireServer(serverId: string, userId: string, flag = 0): { server: ServerSummary; perms: number } {
  const server = getServer(serverId);
  const perms = server ? serverPermissions(serverId, userId) : null;
  if (!server || perms === null) throw notFound("Servidor");
  if (flag !== 0 && !has(perms, flag)) throw forbidden();
  return { server, perms };
}

/** Members without VIEW_CHANNEL get 404 so hidden channels stay hidden. */
export function requireChannel(channelId: string, userId: string, flag = 0): { channel: Channel; perms: number } {
  const channel = getChannel(channelId);
  const perms = channel ? channelPermissions(channel, userId) : 0;
  if (!channel || !has(perms, Permission.VIEW_CHANNEL)) throw notFound("Canal");
  if (flag !== 0 && !has(perms, flag)) throw forbidden();
  return { channel, perms };
}

/** Owner ranks above every role; members without roles rank at 0 (@everyone). */
export function rank(serverId: string, userId: string): number {
  const server = getServer(serverId);
  if (server?.ownerId === userId) return Number.POSITIVE_INFINITY;
  const mine = new Set(memberRoleIds(serverId, userId));
  let top = 0;
  for (const role of getRoles(serverId)) if (mine.has(role.id)) top = Math.max(top, role.position);
  return top;
}

/** Moderation and role edits only flow downward in the role hierarchy. */
export function requireOutranks(serverId: string, actorId: string, targetRank: number): void {
  if (rank(serverId, actorId) <= targetRank) throw forbidden("Seu cargo mais alto precisa estar acima do alvo");
}
