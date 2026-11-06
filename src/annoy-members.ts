// With Annoy accounts (ANNOY_ACCOUNT_MODE=global):
// - the Global learns who is in each server here (by Annoy ID), so the Annoy
//   account can show "friends and communities in common" contacts and can ask
//   for a transfer before an account with owned servers is deleted;
// - an Annoy account deleted in the cloud is deleted here too: it leaves every
//   server, its messages stay with the author "Usuário desconhecido", and the
//   servers where it was the only member are deleted.
import { config } from "./config.ts";
import { all, now, one, run, tx } from "./db.ts";
import { onServerChanged, sendToUser, serverChanged } from "./events.ts";
import { disconnectEverywhere } from "./accounts.ts";
import { discardAvatar } from "./avatars.ts";

export const UNKNOWN_USER = "unknown-user";

const setting = (key: string) => one<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", key)?.value ?? null;
const store = (key: string, value: string) =>
  run("INSERT INTO instance_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);

/** The author shown for messages of people who left or deleted their account. */
export function ensureUnknownUser(): string {
  run(
    "INSERT OR IGNORE INTO users (id, username, display_name, password_hash, created_at) VALUES (?, 'usuario-desconhecido', 'Usuário desconhecido', '!', ?)",
    UNKNOWN_USER, now(),
  );
  return UNKNOWN_USER;
}

/** The person's messages in one server (or everywhere) stay, by "Usuário desconhecido". */
export function anonymizeMessages(userId: string, serverId: string | null): void {
  const unknown = ensureUnknownUser();
  if (serverId) run("UPDATE messages SET author_id = ? WHERE author_id = ? AND channel_id IN (SELECT id FROM channels WHERE server_id = ?)", unknown, userId, serverId);
  else run("UPDATE messages SET author_id = ? WHERE author_id = ?", unknown, userId);
}

function serverAuth(): string | null {
  const id = setting("global.serverId"), secret = setting("global.serverSecret");
  return id && secret ? `Server ${id}:${secret}` : null;
}

/** Every server here, its owner and members, by Annoy ID. Names let the account page say which server needs a transfer. */
export async function reportMembers(): Promise<void> {
  const auth = serverAuth();
  if (!config.global.enabled || !auth) return;
  const servers = all<{ id: string; name: string; owner: string | null }>(
    "SELECT s.id, s.name, u.global_public_id AS owner FROM servers s LEFT JOIN users u ON u.id = s.owner_id",
  );
  const members = all<{ server_id: string; annoy_id: string }>(
    "SELECT m.server_id, u.global_public_id AS annoy_id FROM members m JOIN users u ON u.id = m.user_id WHERE u.global_public_id IS NOT NULL",
  );
  const byServer = new Map<string, string[]>();
  for (const m of members) byServer.set(m.server_id, [...(byServer.get(m.server_id) ?? []), m.annoy_id]);
  const total = all<{ server_id: string; n: number }>("SELECT server_id, count(*) AS n FROM members GROUP BY server_id");
  const counts = new Map(total.map((r) => [r.server_id, r.n]));
  const body = { guilds: servers.map((s) => ({ id: s.id, name: s.name, ownerId: s.owner, memberCount: counts.get(s.id) ?? 0, members: byServer.get(s.id) ?? [] })) };
  const res = await fetch(`${config.global.url}/v1/servers/self/members`, {
    method: "PUT",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Global members: HTTP ${res.status}`);
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** Membership changes are sent a few seconds later, once. */
export function scheduleMemberReport(log: (msg: string) => void): void {
  if (!config.global.enabled || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void reportMembers().catch((err) => log(`Membros para o Annoy: ${(err as Error).message}`));
  }, 10_000);
  timer.unref();
}

/** Deletes one local user whose Annoy account was deleted. */
export async function deleteForAnnoyAccount(userId: string, deleteServer: (serverId: string, actorId: string) => Promise<void>, log: (msg: string) => void): Promise<void> {
  const owned = all<{ id: string; n: number }>(
    "SELECT s.id, (SELECT count(*) FROM members m WHERE m.server_id = s.id) AS n FROM servers s WHERE s.owner_id = ?", userId,
  );
  for (const server of owned) {
    if (server.n <= 1) await deleteServer(server.id, userId);
    // The cloud asked for a transfer first; someone joined after that.
    else log(`Conta Annoy excluída ainda é dona do servidor ${server.id} com outros membros; o servidor ficou.`);
  }
  const avatar = one<{ avatar_url: string | null }>("SELECT avatar_url FROM users WHERE id = ?", userId)?.avatar_url ?? null;
  const memberships = all<{ server_id: string }>("SELECT server_id FROM members WHERE user_id = ?", userId).map((r) => r.server_id);
  const stillOwner = all<{ id: string }>("SELECT id FROM servers WHERE owner_id = ?", userId).length > 0;
  disconnectEverywhere(userId, "Conta excluída");
  tx(() => {
    anonymizeMessages(userId, null);
    run("DELETE FROM invites WHERE creator_id = ?", userId);
    run("DELETE FROM overwrites WHERE target_type = 'member' AND target_id = ?", userId);
    run("UPDATE channels SET created_by = NULL WHERE created_by = ?", userId);
    if (one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'code_repos'")) run("UPDATE code_repos SET linked_by = NULL WHERE linked_by = ?", userId);
    if (stillOwner) {
      // The user row has to stay for the server it still owns; everything else about the person goes.
      run("DELETE FROM members WHERE user_id = ? AND server_id NOT IN (SELECT id FROM servers WHERE owner_id = ?)", userId, userId);
      run("DELETE FROM sessions WHERE user_id = ?", userId);
      run("UPDATE users SET display_name = 'Usuário desconhecido', avatar_url = NULL, bio = '', global_id = NULL, global_public_id = NULL WHERE id = ?", userId);
    } else {
      // Sessions, memberships, roles, bans, reactions and the rest cascade.
      run("DELETE FROM users WHERE id = ?", userId);
    }
  });
  await discardAvatar(avatar);
  for (const serverId of memberships) {
    sendToUser(userId, { t: "SERVER_REMOVE", d: { serverId } });
    serverChanged(serverId);
  }
}

/** Annoy accounts deleted since the last check: their users here are deleted too. */
export async function applyAnnoyDeletions(deleteServer: (serverId: string, actorId: string) => Promise<void>, log: (msg: string) => void): Promise<void> {
  const auth = serverAuth();
  if (!config.global.enabled || !auth) return;
  for (;;) {
    const after = Number(setting("global.deletionsCursor") ?? "0");
    const res = await fetch(`${config.global.url}/v1/servers/self/deletions?after=${after}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Global deletions: HTTP ${res.status}`);
    const { deletions, more } = (await res.json()) as { deletions: { id: string; seq: number }[]; more: boolean };
    for (const deletion of deletions) {
      const user = one<{ id: string }>("SELECT id FROM users WHERE global_public_id = ?", deletion.id);
      if (user) {
        await deleteForAnnoyAccount(user.id, deleteServer, log);
        log(`Conta Annoy excluída: usuário ${user.id} removido deste servidor.`);
      }
      store("global.deletionsCursor", String(deletion.seq));
    }
    if (!more || !deletions.length) return;
  }
}

/** Starts the reports: now, after membership changes and with the hourly Global check. */
export function startAnnoyMembers(log: (msg: string) => void): void {
  if (!config.global.enabled) return;
  onServerChanged(() => scheduleMemberReport(log));
  scheduleMemberReport(log);
}
