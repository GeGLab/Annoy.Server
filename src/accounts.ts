// Account lifecycle shared by self-service deletion and instance moderation.
import { deleteSessionsOf } from "./auth.ts";
import { all, run, tx } from "./db.ts";
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
