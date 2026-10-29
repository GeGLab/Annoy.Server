// Instance-level state owned by the person hosting it: settings, admins and
// account sign-up invites. Server (guild) level control lives in perms.ts.
import type { InstanceSettings, RegistrationMode } from "@distopic/protocol";
import { config } from "./config.ts";
import { now, one, run } from "./db.ts";
import { forbidden, HttpError } from "./errors.ts";

const MODES: readonly RegistrationMode[] = ["open", "invite", "closed"];

function read(key: string): string | undefined {
  return one<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", `settings.${key}`)?.value;
}

function write(key: string, value: string): void {
  run("INSERT INTO instance_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", `settings.${key}`, value);
}

/** Admin-chosen values win over environment defaults. */
export function getSettings(): InstanceSettings {
  const registration = read("registration") as RegistrationMode | undefined;
  const maxServers = read("maxServersPerUser");
  const maxUpload = read("maxUploadMb");
  return {
    registration: registration && MODES.includes(registration) ? registration : config.defaults.registration,
    maxServersPerUser: maxServers === undefined ? config.defaults.maxServersPerUser : maxServers === "" ? null : Number(maxServers),
    maxUploadMb: maxUpload === undefined ? config.defaults.maxUploadMb : Number(maxUpload),
  };
}

export function updateSettings(patch: Partial<InstanceSettings>): InstanceSettings {
  if (patch.registration !== undefined) write("registration", patch.registration);
  if (patch.maxServersPerUser !== undefined) write("maxServersPerUser", patch.maxServersPerUser === null ? "" : String(patch.maxServersPerUser));
  if (patch.maxUploadMb !== undefined) write("maxUploadMb", String(patch.maxUploadMb));
  return getSettings();
}

export const maxUploadBytes = () => Math.min(getSettings().maxUploadMb * 1024 * 1024, config.uploadCeilingBytes);

export function isAdmin(userId: string): boolean {
  return one<{ is_admin: number }>("SELECT is_admin FROM users WHERE id = ?", userId)?.is_admin === 1;
}

export function requireAdmin(userId: string): void {
  if (!isAdmin(userId)) throw forbidden("Apenas o administrador da instância");
}

/** ANNOY_ADMIN, or else the very first account, administers the instance. */
export function grantBootstrapAdmin(userId: string, username: string): void {
  const named = config.adminUsername !== "" && config.adminUsername.toLowerCase() === username.toLowerCase();
  const noAdmin = !one("SELECT 1 AS x FROM users WHERE is_admin = 1 AND id != ?", userId);
  if (named || (config.adminUsername === "" && noAdmin)) run("UPDATE users SET is_admin = 1 WHERE id = ?", userId);
}

/**
 * Runs at startup. ANNOY_ADMIN is always an admin; otherwise an instance
 * with no admin (e.g. a database created before v0.2) promotes its oldest
 * active account, matching "the first account administers the instance".
 */
export function syncConfiguredAdmin(): void {
  if (config.adminUsername) {
    run("UPDATE users SET is_admin = 1 WHERE username = ?", config.adminUsername);
    return;
  }
  if (one("SELECT 1 AS x FROM users WHERE is_admin = 1")) return;
  run(
    `UPDATE users SET is_admin = 1 WHERE id = (
       SELECT id FROM users WHERE imported_from IS NULL AND banned_at IS NULL AND username NOT LIKE 'deleted.%'
        ORDER BY created_at LIMIT 1)`,
  );
}

const realUserCount = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE imported_from IS NULL")!.n;

/**
 * Decides whether a new account may be created. The first account is always
 * allowed so a fresh instance can bootstrap its admin.
 * Returns the invite code to consume once the account exists.
 */
export function checkRegistration(inviteCode: string | undefined): string | null {
  if (realUserCount() === 0) return null;
  const { registration } = getSettings();
  if (registration === "open") return null;
  if (registration === "closed") throw forbidden("Cadastro fechado nesta instância");
  if (!inviteCode) throw new HttpError(403, "invite_required", "Esta instância exige um convite para criar conta");
  const row = one<{ uses: number; max_uses: number | null; expires_at: string | null }>(
    "SELECT uses, max_uses, expires_at FROM signup_invites WHERE code = ?",
    inviteCode.trim(),
  );
  if (!row) throw new HttpError(403, "invite_invalid", "Convite de cadastro inválido");
  if (row.expires_at && row.expires_at < now()) throw new HttpError(403, "invite_expired", "Convite de cadastro expirado");
  if (row.max_uses !== null && row.uses >= row.max_uses) throw new HttpError(403, "invite_exhausted", "Convite de cadastro esgotado");
  return inviteCode.trim();
}

export function consumeSignupInvite(code: string | null): void {
  if (code) run("UPDATE signup_invites SET uses = uses + 1 WHERE code = ?", code);
}

/** Instance limit on how many servers one account may own; admins are exempt. */
export function requireServerQuota(userId: string): void {
  const { maxServersPerUser } = getSettings();
  if (maxServersPerUser === null || isAdmin(userId)) return;
  const owned = one<{ n: number }>("SELECT COUNT(*) AS n FROM servers WHERE owner_id = ?", userId)!.n;
  if (owned >= maxServersPerUser) throw forbidden(`Limite de ${maxServersPerUser} servidor(es) por conta nesta instância`);
}
