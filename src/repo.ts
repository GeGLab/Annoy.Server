import type {
  Attachment,
  Channel,
  ChannelType,
  DmChannel,
  Member,
  Message,
  Overwrite,
  Relationship,
  RelationshipStatus,
  Role,
  ServerSummary,
  User,
} from "@distopic/protocol";
import { all, one } from "./db.ts";
import { presenceOf } from "./presence.ts";

// Row shapes ---------------------------------------------------------------

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

const USER_COLS = "id, username, display_name, avatar_url";
interface ServerRow {
  id: string;
  name: string;
  owner_id: string;
  icon_url: string | null;
}
interface ChannelRow {
  id: string;
  server_id: string | null;
  type: ChannelType;
  name: string;
  topic: string;
  parent_id: string | null;
  position: number;
}
interface OverwriteRow {
  channel_id: string;
  target_id: string;
  target_type: "role" | "member";
  allow: number;
  deny: number;
}
interface RoleRow {
  id: string;
  server_id: string;
  name: string;
  color: string | null;
  permissions: number;
  position: number;
}
export interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  created_at: string;
  edited_at: string | null;
  reply_to_id: string | null;
  mention_ids: string;
  mentions_everyone: number;
}
interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  size: number;
  content_type: string;
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

// Users ----------------------------------------------------------------------

const toUser = (r: UserRow): User => ({ id: r.id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url });

export function getUser(id: string): User | undefined {
  const row = one<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id);
  return row && toUser(row);
}

export function getUserByName(username: string): User | undefined {
  const row = one<UserRow>(`SELECT ${USER_COLS} FROM users WHERE username = ?`, username);
  return row && toUser(row);
}

export function getUsers(ids: readonly string[]): Map<string, User> {
  const out = new Map<string, User>();
  if (ids.length === 0) return out;
  const unique = [...new Set(ids)];
  for (const row of all<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id IN (${placeholders(unique.length)})`, ...unique)) {
    out.set(row.id, toUser(row));
  }
  return out;
}

// Servers ----------------------------------------------------------------------

const toServer = (r: ServerRow): ServerSummary => ({ id: r.id, name: r.name, ownerId: r.owner_id, iconUrl: r.icon_url ?? null });

export function getServer(id: string): ServerSummary | undefined {
  const row = one<ServerRow>("SELECT id, name, owner_id, icon_url FROM servers WHERE id = ?", id);
  return row && toServer(row);
}

export function serversForUser(userId: string): ServerSummary[] {
  return all<ServerRow>(
    "SELECT s.id, s.name, s.owner_id, s.icon_url FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ? ORDER BY m.joined_at",
    userId,
  ).map(toServer);
}

export function isMember(serverId: string, userId: string): boolean {
  return one("SELECT 1 AS x FROM members WHERE server_id = ? AND user_id = ?", serverId, userId) !== undefined;
}

export function memberIds(serverId: string): string[] {
  return all<{ user_id: string }>("SELECT user_id FROM members WHERE server_id = ?", serverId).map((r) => r.user_id);
}

export function memberRoleIds(serverId: string, userId: string): string[] {
  return all<{ role_id: string }>(
    "SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?",
    serverId,
    userId,
  ).map((r) => r.role_id);
}

export function getMembers(serverId: string): Member[] {
  const rows = all<UserRow & { nick: string | null; joined_at: string }>(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, m.nick, m.joined_at
       FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.server_id = ? ORDER BY u.display_name COLLATE NOCASE`,
    serverId,
  );
  const roleMap = new Map<string, string[]>();
  for (const r of all<{ user_id: string; role_id: string }>("SELECT user_id, role_id FROM member_roles WHERE server_id = ?", serverId)) {
    const list = roleMap.get(r.user_id) ?? [];
    list.push(r.role_id);
    roleMap.set(r.user_id, list);
  }
  return rows.map((r) => ({
    user: toUser(r),
    nick: r.nick,
    roleIds: roleMap.get(r.id) ?? [],
    joinedAt: r.joined_at,
    presence: presenceOf(r.id),
  }));
}

/** Users who share at least one server or a relationship with `userId`. */
export function audienceOf(userId: string): string[] {
  return all<{ id: string }>(
    `SELECT DISTINCT m2.user_id AS id FROM members m1 JOIN members m2 ON m2.server_id = m1.server_id WHERE m1.user_id = ?
     UNION SELECT other_id AS id FROM relationships WHERE user_id = ?
     UNION SELECT d2.user_id AS id FROM dm_recipients d1 JOIN dm_recipients d2 ON d2.channel_id = d1.channel_id WHERE d1.user_id = ?`,
    userId,
    userId,
    userId,
  ).map((r) => r.id);
}

// Roles ------------------------------------------------------------------------

const toRole = (r: RoleRow): Role => ({
  id: r.id,
  serverId: r.server_id,
  name: r.name,
  color: r.color,
  permissions: r.permissions,
  position: r.position,
});

export function getRoles(serverId: string): Role[] {
  return all<RoleRow>("SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC", serverId).map(toRole);
}

export function getRole(id: string): Role | undefined {
  const row = one<RoleRow>("SELECT * FROM roles WHERE id = ?", id);
  return row && toRole(row);
}

// Channels -------------------------------------------------------------------

function overwritesFor(channelIds: readonly string[]): Map<string, Overwrite[]> {
  const out = new Map<string, Overwrite[]>();
  if (channelIds.length === 0) return out;
  for (const r of all<OverwriteRow>(`SELECT * FROM overwrites WHERE channel_id IN (${placeholders(channelIds.length)})`, ...channelIds)) {
    const list = out.get(r.channel_id) ?? [];
    list.push({ targetId: r.target_id, targetType: r.target_type, allow: r.allow, deny: r.deny });
    out.set(r.channel_id, list);
  }
  return out;
}

const toChannel = (r: ChannelRow, overwrites: Overwrite[]): Channel => ({
  id: r.id,
  serverId: r.server_id,
  type: r.type,
  name: r.name,
  topic: r.topic,
  parentId: r.parent_id,
  position: r.position,
  overwrites,
});

export function getChannel(id: string): Channel | undefined {
  const row = one<ChannelRow>("SELECT * FROM channels WHERE id = ?", id);
  return row && toChannel(row, overwritesFor([id]).get(id) ?? []);
}

export function getChannels(serverId: string): Channel[] {
  const rows = all<ChannelRow>("SELECT * FROM channels WHERE server_id = ? ORDER BY position, id", serverId);
  const ow = overwritesFor(rows.map((r) => r.id));
  return rows.map((r) => toChannel(r, ow.get(r.id) ?? []));
}

// DMs ------------------------------------------------------------------------

export function dmRecipientIds(channelId: string): string[] {
  return all<{ user_id: string }>("SELECT user_id FROM dm_recipients WHERE channel_id = ?", channelId).map((r) => r.user_id);
}

export function getDmChannel(channelId: string, viewerId: string): DmChannel | undefined {
  const ids = dmRecipientIds(channelId);
  if (!ids.includes(viewerId)) return undefined;
  const users = getUsers(ids.filter((id) => id !== viewerId));
  const last = one<{ id: string }>("SELECT MAX(id) AS id FROM messages WHERE channel_id = ?", channelId);
  return { id: channelId, recipients: [...users.values()], lastMessageId: last?.id ?? null };
}

export function dmChannelsForUser(userId: string): DmChannel[] {
  return all<{ channel_id: string }>("SELECT channel_id FROM dm_recipients WHERE user_id = ?", userId)
    .map((r) => getDmChannel(r.channel_id, userId))
    .filter((c): c is DmChannel => c !== undefined)
    .sort((a, b) => (b.lastMessageId ?? "").localeCompare(a.lastMessageId ?? ""));
}

export function findDm(a: string, b: string): string | undefined {
  return one<{ channel_id: string }>(
    `SELECT d1.channel_id FROM dm_recipients d1 JOIN dm_recipients d2 ON d2.channel_id = d1.channel_id
      WHERE d1.user_id = ? AND d2.user_id = ?
        AND (SELECT COUNT(*) FROM dm_recipients d3 WHERE d3.channel_id = d1.channel_id) = 2`,
    a,
    b,
  )?.channel_id;
}

// Messages -------------------------------------------------------------------

const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  filename: r.filename,
  size: r.size,
  contentType: r.content_type,
  url: `/api/uploads/${r.id}/${encodeURIComponent(r.filename)}`,
});

export function hydrate(rows: MessageRow[]): Message[] {
  if (rows.length === 0) return [];
  const users = getUsers(rows.map((r) => r.author_id));
  const ids = rows.map((r) => r.id);
  const atts = new Map<string, Attachment[]>();
  for (const a of all<AttachmentRow>(`SELECT * FROM attachments WHERE message_id IN (${placeholders(ids.length)})`, ...ids)) {
    const list = atts.get(a.message_id) ?? [];
    list.push(toAttachment(a));
    atts.set(a.message_id, list);
  }
  const reactions = new Map<string, { emoji: string; userIds: string[] }[]>();
  for (const reaction of all<{message_id: string; user_id: string; emoji: string}>(`SELECT * FROM message_reactions WHERE message_id IN (${placeholders(ids.length)}) ORDER BY emoji, user_id`, ...ids)) {
    const groups = reactions.get(reaction.message_id) ?? [];
    let group = groups.find((item) => item.emoji === reaction.emoji);
    if (!group) { group = { emoji: reaction.emoji, userIds: [] }; groups.push(group); }
    group.userIds.push(reaction.user_id); reactions.set(reaction.message_id, groups);
  }
  return rows.map((r) => ({
    id: r.id,
    reactions: reactions.get(r.id) ?? [],
    channelId: r.channel_id,
    author: users.get(r.author_id) ?? { id: r.author_id, username: "unknown", displayName: "Usuário removido", avatarUrl: null },
    content: r.content,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    replyToId: r.reply_to_id,
    attachments: atts.get(r.id) ?? [],
    mentionIds: JSON.parse(r.mention_ids) as string[],
    mentionsEveryone: r.mentions_everyone === 1,
  }));
}

export function getMessage(id: string): Message | undefined {
  return hydrate(all<MessageRow>("SELECT * FROM messages WHERE id = ?", id))[0];
}

export function getMessages(channelId: string, before: string | null, limit: number): Message[] {
  const rows = before
    ? all<MessageRow>("SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?", channelId, before, limit)
    : all<MessageRow>("SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?", channelId, limit);
  return hydrate(rows.reverse());
}

// Relationships --------------------------------------------------------------

export function getRelationships(userId: string): Relationship[] {
  const rows = all<{ other_id: string; status: RelationshipStatus }>(
    "SELECT other_id, status FROM relationships WHERE user_id = ?",
    userId,
  );
  const users = getUsers(rows.map((r) => r.other_id));
  return rows.flatMap((r) => {
    const user = users.get(r.other_id);
    return user ? [{ user, status: r.status }] : [];
  });
}

export function relationshipStatus(userId: string, otherId: string): RelationshipStatus | undefined {
  return one<{ status: RelationshipStatus }>("SELECT status FROM relationships WHERE user_id = ? AND other_id = ?", userId, otherId)
    ?.status;
}
