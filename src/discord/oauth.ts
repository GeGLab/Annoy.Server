// "Entrar com Discord" through Discord's official OAuth2 (identify scope).
//
// Desktop clients can't receive the redirect themselves, so the server keeps a
// short-lived pending login: the client opens the authorize URL in a browser,
// Discord redirects back here, and the client collects the result by polling
// with a secret handoff code only it knows.
import { randomBytes } from "node:crypto";
import { LIMITS, type DiscordLoginBegin, type DiscordLoginPoll } from "@distopic/protocol";
import { createSession } from "../auth.ts";
import { checkRegistration, consumeSignupInvite, grantBootstrapAdmin } from "../instance.ts";
import { config } from "../config.ts";
import { all, now, one, run, tx } from "../db.ts";
import { sendToAudience } from "../events.ts";
import { newId } from "../ids.ts";
import { getUser } from "../repo.ts";
import { avatarUrlOf, type DUser } from "./rest.ts";

const API = "https://discord.com/api/v10";
const TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;

interface Pending {
  handoff: string;
  redirectUri: string;
  /** Set when an already signed-in user links Discord to their account. */
  linkUserId: string | null;
  /** Sign-up invite for instances that require one; checked only if a new account is needed. */
  inviteCode: string | undefined;
  expiresAt: number;
  result: DiscordLoginPoll;
}

const byState = new Map<string, Pending>();
const byHandoff = new Map<string, string>();

export const discordLoginEnabled = () => config.discord.clientId !== "" && config.discord.clientSecret !== "";

const secret = () => randomBytes(32).toString("base64url");

function prune(): void {
  const t = Date.now();
  for (const [state, p] of byState) {
    if (p.expiresAt < t) {
      byState.delete(state);
      byHandoff.delete(p.handoff);
    }
  }
}

/** `origin` is how the client reached us; ANNOY_PUBLIC_URL overrides it behind proxies. */
export function beginLogin(origin: string, linkUserId: string | null, inviteCode?: string): DiscordLoginBegin {
  prune();
  if (byState.size >= MAX_PENDING) throw new Error("Logins pendentes demais; tente de novo em alguns minutos");
  const state = secret();
  const handoff = secret();
  const redirectUri = `${config.publicUrl || origin}/api/auth/discord/callback`;
  byState.set(state, { handoff, redirectUri, linkUserId, inviteCode, expiresAt: Date.now() + TTL_MS, result: { status: "pending" } });
  byHandoff.set(handoff, state);
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    response_type: "code",
    scope: "identify",
    redirect_uri: redirectUri,
    state,
    prompt: "none",
  });
  return { url: `https://discord.com/oauth2/authorize?${params}`, handoff, redirectUri };
}

/** One-shot: a finished result is handed out once, then forgotten. */
export function pollLogin(handoff: string): DiscordLoginPoll {
  const state = byHandoff.get(handoff);
  const pending = state ? byState.get(state) : undefined;
  if (!state || !pending || pending.expiresAt < Date.now()) return { status: "error", message: "Login expirado; tente de novo" };
  if (pending.result.status !== "pending") {
    byState.delete(state);
    byHandoff.delete(handoff);
  }
  return pending.result;
}

async function fetchDiscordUser(code: string, redirectUri: string): Promise<DUser> {
  const basic = Buffer.from(`${config.discord.clientId}:${config.discord.clientSecret}`).toString("base64");
  const tokenRes = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!tokenRes.ok || !token.access_token) throw new Error(token.error_description ?? "O Discord recusou a autorização");
  // The Discord access token is used for this single request and then dropped.
  const userRes = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!userRes.ok) throw new Error("Não foi possível ler o perfil do Discord");
  return (await userRes.json()) as DUser;
}

/** Discord usernames already fit our rules; "dc." stays reserved for imported profiles. */
function uniqueUsername(discordName: string): string {
  let base = discordName.toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, LIMITS.usernameMax - 4);
  if (/^dc\./.test(base)) base = `u_${base}`.slice(0, LIMITS.usernameMax - 4);
  if (base.length < LIMITS.usernameMin) base = `user_${base}`;
  const taken = new Set(all<{ username: string }>("SELECT username FROM users WHERE username LIKE ?", `${base}%`).map((r) => r.username.toLowerCase()));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** Links (or creates) the Annoy account for a Discord identity. Returns the user id. */
function resolveAccount(d: DUser, linkUserId: string | null, inviteCode: string | undefined): string {
  const displayName = (d.global_name || d.username).slice(0, LIMITS.usernameMax);
  const avatar = avatarUrlOf(d);
  return tx(() => {
    const linked = one<{ id: string }>("SELECT id FROM users WHERE discord_id = ?", d.id)?.id;
    const ghost = one<{ id: string }>("SELECT id FROM users WHERE imported_from = ?", `discord:${d.id}`)?.id;

    if (linkUserId) {
      if (linked && linked !== linkUserId) throw new Error("Esta conta do Discord já está vinculada a outro usuário do Annoy");
      if (ghost) {
        // Imported history written by this Discord account becomes the user's own.
        run("UPDATE messages SET author_id = ? WHERE author_id = ?", linkUserId, ghost);
        run("DELETE FROM users WHERE id = ?", ghost);
      }
      run("UPDATE users SET discord_id = ?, display_name = ?, avatar_url = ? WHERE id = ?", d.id, displayName, avatar, linkUserId);
      return linkUserId;
    }

    if (linked) {
      const banned = one<{ banned_at: string | null }>("SELECT banned_at FROM users WHERE id = ?", linked)?.banned_at;
      if (banned) throw new Error("Conta suspensa nesta instância");
      run("UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?", displayName, avatar, linked);
      return linked;
    }
    if (ghost) {
      // Claim the imported profile: it becomes a real account that signs in with Discord.
      run(
        "UPDATE users SET discord_id = ?, imported_from = NULL, username = ?, display_name = ?, avatar_url = ? WHERE id = ?",
        d.id,
        uniqueUsername(d.username),
        displayName,
        avatar,
        ghost,
      );
      return ghost;
    }
    // A brand-new account follows the instance's sign-up rules; claiming an imported profile does not.
    const invite = checkRegistration(inviteCode);
    const id = newId();
    // Discord-only accounts have no password; "!" never verifies.
    run(
      "INSERT INTO users (id, username, display_name, password_hash, created_at, discord_id, avatar_url) VALUES (?, ?, ?, '!', ?, ?, ?)",
      id,
      uniqueUsername(d.username),
      displayName,
      now(),
      d.id,
      avatar,
    );
    consumeSignupInvite(invite);
    grantBootstrapAdmin(id, d.username);
    return id;
  });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f25;color:#e4e4e9;font-family:system-ui,sans-serif}
main{max-width:420px;padding:32px;background:#25262d;border-radius:12px;text-align:center}h1{font-size:1.3rem;margin:0 0 8px}p{color:#9a9ba6;margin:0}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

/** Handles Discord's redirect and returns the HTML shown in the browser tab. */
export async function completeLogin(state: string, code: string | undefined, error: string | undefined): Promise<string> {
  const pending = byState.get(state);
  if (!pending || pending.expiresAt < Date.now()) return page("Login expirado", "Volte ao Annoy e tente de novo.");
  if (pending.result.status !== "pending") return page("Já concluído", "Pode voltar ao Annoy.");
  if (error || !code) {
    pending.result = { status: "error", message: error === "access_denied" ? "Autorização cancelada no Discord" : "O Discord não autorizou o login" };
    return page("Login cancelado", "Volte ao Annoy para tentar de novo.");
  }
  try {
    const discordUser = await fetchDiscordUser(code, pending.redirectUri);
    const userId = resolveAccount(discordUser, pending.linkUserId, pending.inviteCode);
    const user = getUser(userId)!;
    sendToAudience(userId, { t: "USER_UPDATE", d: user });
    pending.result = { status: "done", auth: pending.linkUserId ? null : { token: createSession(userId), user }, user };
    return page(pending.linkUserId ? "Discord vinculado" : `Olá, ${user.displayName}!`, "Pronto. Pode fechar esta aba e voltar ao Annoy.");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha no login com Discord";
    pending.result = { status: "error", message };
    return page("Não foi possível entrar", message);
  }
}
