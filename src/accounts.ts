// Account lifecycle shared by self-service deletion and instance moderation.
import { deleteSessionsOf } from "./auth.ts";
import { all, one, run, tx } from "./db.ts";
import { conflict } from "./errors.ts";
import { connectionsOf, sendToAudience, serverChanged } from "./events.ts";
import { getUser } from "./repo.ts";
import { discardBlobs } from "./uploads.ts";
import { discardAvatar } from "./avatars.ts";
import { clearUserActivity } from "./activity.ts";

/** Prefixes that registration refuses, so system-made usernames can't be claimed. */
export const RESERVED_USERNAME = /^(dc|deleted)\./i;

/** Ends every live session of the user (gateway sockets close; voice is released on close). */
export function disconnectEverywhere(userId: string, reason: string): void {
  clearUserActivity(userId);
  deleteSessionsOf(userId);
  for (const conn of [...connectionsOf(userId)]) {
    conn.send({ t: "INVALID_SESSION", d: { reason } });
    conn.socket.close(4004, "session ended");
  }
}

export function ownedServerNames(userId: string): string[] {
  return all<{ name: string }>("SELECT name FROM servers WHERE owner_id = ?", userId).map((r) => r.name);
}

/**
 * Deletes an account. The row stays as an anonymous "deleted user" so other
 * people's conversations keep their shape; personal data is erased. With
 * `deleteMessages`, the user's messages and attachments are removed too.
 */
export async function deleteAccount(userId: string, options: { deleteMessages: boolean }): Promise<void> {
  const avatar = getUser(userId)?.avatarUrl;
  const owned = ownedServerNames(userId);
  if (owned.length > 0) throw conflict(`Exclua ou transfira estes servidores antes: ${owned.join(", ")}`);
  const servers = all<{ server_id: string }>("SELECT server_id FROM members WHERE user_id = ?", userId).map((r) => r.server_id);
  const blobs = options.deleteMessages
    ? all<{ id: string }>("SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.author_id = ?", userId).map(
        (r) => r.id,
      )
    : [];
  disconnectEverywhere(userId, "Conta excluída");
  tx(() => {
    if (options.deleteMessages) run("DELETE FROM messages WHERE author_id = ?", userId);
    run("DELETE FROM members WHERE user_id = ?", userId);
    run("DELETE FROM relationships WHERE user_id = ? OR other_id = ?", userId, userId);
    run(
      `UPDATE users SET username = ?, display_name = 'Usuário excluído', password_hash = '!', discord_id = NULL,
              avatar_url = NULL, imported_from = NULL, is_admin = 0, banned_at = NULL, ban_reason = '' WHERE id = ?`,
      `deleted.${userId}`,
      userId,
    );
  });
  await discardBlobs(blobs);
  await discardAvatar(avatar);
  const user = getUser(userId);
  if (user) sendToAudience(userId, { t: "USER_UPDATE", d: user });
  for (const serverId of servers) serverChanged(serverId);
}

/**
 * Item 1.9: one person, two users on this server (a local one and the one their
 * global account made). Everything of `drop` moves to `keep`, which then signs
 * in with the global account too, and `drop` is removed. One transaction: it
 * all moves or nothing does.
 */
export function mergeUsers(keep: string, drop: string): void {
  const copy = (table: string, column: string, where = "") => {
    const cols = (all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name);
    const select = cols.map((c) => (c === column ? "?" : c)).join(", ");
    run(`INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) SELECT ${select} FROM ${table} WHERE ${column} = ?${where}`, keep, drop);
    run(`DELETE FROM ${table} WHERE ${column} = ?${where}`, drop);
  };
  const servers = all<{ server_id: string }>("SELECT server_id FROM members WHERE user_id IN (?, ?)", keep, drop).map((r) => r.server_id);
  const dropRow = one<{ global_id: string; is_admin: number; avatar_url: string | null }>("SELECT global_id, is_admin, avatar_url FROM users WHERE id = ?", drop)!;
  tx(() => {
    run("UPDATE servers SET owner_id = ? WHERE owner_id = ?", keep, drop);
    // Membership first, so the roles below have a member row to hang on.
    run("INSERT OR IGNORE INTO members (server_id, user_id, nick, joined_at) SELECT server_id, ?, nick, joined_at FROM members WHERE user_id = ?", keep, drop);
    copy("member_roles", "user_id");
    run("DELETE FROM members WHERE user_id = ?", drop);
    copy("bans", "user_id");
    copy("dm_recipients", "user_id");
    copy("overwrites", "target_id", " AND target_type = 'member'");
    // Friendships in both directions, minus the one between the two accounts.
    run("DELETE FROM relationships WHERE (user_id = ? AND other_id = ?) OR (user_id = ? AND other_id = ?)", keep, drop, drop, keep);
    copy("relationships", "user_id");
    copy("relationships", "other_id");
    run("UPDATE messages SET author_id = ? WHERE author_id = ?", keep, drop);
    run("UPDATE messages SET mention_ids = replace(mention_ids, ?, ?) WHERE mention_ids LIKE ?", `"${drop}"`, `"${keep}"`, `%"${drop}"%`);
    run("UPDATE invites SET creator_id = ? WHERE creator_id = ?", keep, drop);
    run("UPDATE signup_invites SET created_by = ? WHERE created_by = ?", keep, drop);
    run("UPDATE users SET global_id = NULL WHERE id = ?", drop);
    run(
      "UPDATE users SET global_id = ?, is_admin = max(is_admin, ?), avatar_url = coalesce(avatar_url, ?) WHERE id = ?",
      dropRow.global_id,
      dropRow.is_admin,
      dropRow.avatar_url,
      keep,
    );
    run("DELETE FROM users WHERE id = ?", drop);
  });
  disconnectEverywhere(drop, "Esta conta foi unificada com outra");
  const user = getUser(keep);
  if (user) sendToAudience(keep, { t: "USER_UPDATE", d: user });
  for (const serverId of new Set(servers)) serverChanged(serverId);
}
