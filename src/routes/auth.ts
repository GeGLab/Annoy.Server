import { LIMITS, PROTOCOL_VERSION, type AuthResponse, type InstanceInfo, type User } from "@distopic/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bearerToken, createSession, deleteSession, hashPassword, requireUser, verifyPassword } from "../auth.ts";
import { deleteAccount, mergeUsers, RESERVED_USERNAME } from "../accounts.ts";
import { config } from "../config.ts";
import { discordLoginEnabled } from "../discord/oauth.ts";
import { now, one, run, tx } from "../db.ts";
import { createAvatar, discardAvatar, MAX_AVATAR_BYTES, readAvatar } from "../avatars.ts";
import { badRequest, conflict, HttpError, notFound } from "../errors.ts";
import { checkRegistration, consumeSignupInvite, getSettings, grantBootstrapAdmin } from "../instance.ts";
import { sendToAudience } from "../events.ts";
import { newId } from "../ids.ts";
import { getUser } from "../repo.ts";
import { globalLoginAvailable, globalServerId, newChallenge, verifyGlobalProof } from "../global.ts";
import { parse } from "../validate.ts";

const username = z
  .string()
  .trim()
  .min(LIMITS.usernameMin)
  .max(LIMITS.usernameMax)
  .regex(/^[a-zA-Z0-9_.]+$/, "use apenas letras, números, _ e .");
const displayName = z.string().trim().min(1).max(LIMITS.usernameMax);

const registerBody = z.object({
  username,
  password: z.string().min(LIMITS.passwordMin).max(256),
  displayName: displayName.optional(),
    bio: z.string().max(1000).optional(),
  inviteCode: z.string().trim().max(64).optional(),
});
const deleteMe = z.object({
  /** Typed username, as confirmation (works for accounts without a password). */
  confirm: z.string(),
  password: z.string().optional(),
  deleteMessages: z.boolean().default(false),
});
const loginBody = z.object({ username: z.string(), password: z.string() });
const b64url = z.string().max(2048).regex(/^[A-Za-z0-9_-]+$/);
const globalProof = z.object({
  identity: b64url,
  challenge: b64url,
  signature: b64url,
  token: z.object({ kid: z.string().max(32), message: b64url, signature: b64url }),
});
const globalLogin = globalProof.extend({
  username: username.optional(),
  displayName: displayName.optional(),
  inviteCode: z.string().trim().max(64).optional(),
});

/** The signed-in user's own profile, which also says whether it signs in with Annoy Global. */
export function ownUser(id: string): User {
  const global = one<{ global_id: string | null }>("SELECT global_id FROM users WHERE id = ?", id)?.global_id;
  return { ...getUser(id)!, global: !!global };
}

function refuseBanned(row: { banned_at: string | null; ban_reason: string }): void {
  if (row.banned_at) throw new HttpError(403, "banned", `Conta suspensa nesta instância${row.ban_reason ? `: ${row.ban_reason}` : ""}`);
}
const patchMe = z
  .object({ displayName: displayName.optional(),
    bio: z.string().max(1000).optional(), avatarUrl: z.null().optional() })
  .refine((body) => body.displayName !== undefined || body.bio !== undefined || body.avatarUrl === null, "Nenhuma alteração informada");

export function authRoutes(app: FastifyInstance): void {
  app.get("/info", async (): Promise<InstanceInfo> => {
    const { registration } = getSettings();
    return {
      name: config.name,
      version: "0.5.0",
      protocol: PROTOCOL_VERSION,
      registrationOpen: registration !== "closed",
      registration,
      discordLogin: discordLoginEnabled(),
      globalServerId: globalLoginAvailable() ? globalServerId() : null,
    };
  });

  // Annoy Global login (Annoy-api-global DESIGN.md): the client signs a one-time
  // challenge with its identity for this server and shows a blind token.
  app.post("/auth/global/challenge", async () => ({ challenge: newChallenge() }));

  app.post("/auth/global", async (req): Promise<AuthResponse> => {
    const body = parse(globalLogin, req.body);
    const identity = verifyGlobalProof(body);
    const existing = one<{ id: string; banned_at: string | null; ban_reason: string }>("SELECT id, banned_at, ban_reason FROM users WHERE global_id = ?", identity);
    if (existing) {
      refuseBanned(existing);
      return { token: createSession(existing.id), user: ownUser(existing.id) };
    }
    // First time here: a new account on this server, under its registration rules.
    if (!body.username) throw new HttpError(404, "global_new_account", "Escolha um nome de usuário para este servidor");
    const invite = checkRegistration(body.inviteCode);
    if (RESERVED_USERNAME.test(body.username)) throw badRequest('Os prefixos "dc." e "deleted." são reservados');
    if (one("SELECT 1 AS x FROM users WHERE username = ?", body.username)) throw conflict("Nome de usuário em uso");
    const id = newId();
    // No password: "!" never matches a scrypt hash, so only the global login opens it.
    run(
      "INSERT INTO users (id, username, display_name, password_hash, global_id, created_at) VALUES (?, ?, ?, '!', ?, ?)",
      id,
      body.username,
      body.displayName ?? body.username,
      identity,
      now(),
    );
    consumeSignupInvite(invite);
    grantBootstrapAdmin(id, body.username);
    return { token: createSession(id), user: ownUser(id) };
  });

  // Items 1.7 and 1.9: a local account starts signing in with Annoy Global too.
  // Being logged in proves the local account; the proof, the global one.
  app.post("/users/@me/global", async (req) => {
    const userId = requireUser(req);
    const identity = verifyGlobalProof(parse(globalProof, req.body));
    const holder = one<{ username: string; id: string }>("SELECT id, username FROM users WHERE global_id = ?", identity);
    // The global account already made its own user here: that's a merge (item 1.9), not a link.
    if (holder && holder.id !== userId) throw new HttpError(409, "global_in_use", `Sua conta global já tem o usuário @${holder.username} neste servidor`);
    run("UPDATE users SET global_id = ? WHERE id = ?", identity, userId);
    return ownUser(userId);
  });

  // Item 1.9: the same person has a local user and a global-made user here.
  // Proven twice: logged in as the local one (and its password, if it has one),
  // and the global proof for the other. The local user keeps everything of both.
  app.post("/users/@me/global/merge", async (req) => {
    const userId = requireUser(req);
    const body = parse(globalProof.extend({ password: z.string().max(256).optional() }), req.body);
    const me = one<{ password_hash: string; global_id: string | null; banned_at: string | null; ban_reason: string }>(
      "SELECT password_hash, global_id, banned_at, ban_reason FROM users WHERE id = ?",
      userId,
    )!;
    if (me.password_hash.startsWith("scrypt$") && !(body.password && (await verifyPassword(body.password, me.password_hash)))) {
      throw new HttpError(401, "invalid_credentials", "Senha incorreta");
    }
    if (me.global_id) throw conflict("Esta conta já entra com uma conta global");
    const identity = verifyGlobalProof(body);
    const other = one<{ id: string; banned_at: string | null; ban_reason: string }>("SELECT id, banned_at, ban_reason FROM users WHERE global_id = ?", identity);
    if (!other) throw notFound("Usuário da conta global");
    if (other.id === userId) return { user: ownUser(userId), removedUserId: null };
    // A ban on either side must not be shed by merging.
    refuseBanned(me);
    refuseBanned(other);
    mergeUsers(userId, other.id);
    return { user: ownUser(userId), removedUserId: other.id };
  });

  app.delete("/users/@me/global", async (req) => {
    const userId = requireUser(req);
    const row = one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", userId)!;
    // Without a password the account would have no way in left.
    if (!row.password_hash.startsWith("scrypt$")) throw badRequest("Defina uma senha local antes de desligar a conta global");
    run("UPDATE users SET global_id = NULL WHERE id = ?", userId);
    return ownUser(userId);
  });

  app.post("/auth/register", async (req): Promise<AuthResponse> => {
    const body = parse(registerBody, req.body);
    const invite = checkRegistration(body.inviteCode);
    if (RESERVED_USERNAME.test(body.username)) throw badRequest('Os prefixos "dc." e "deleted." são reservados');
    if (one("SELECT 1 AS x FROM users WHERE username = ?", body.username)) throw conflict("Nome de usuário em uso");
    const id = newId();
    run(
      "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      body.username,
      body.displayName ?? body.username,
      await hashPassword(body.password),
      now(),
    );
    consumeSignupInvite(invite);
    grantBootstrapAdmin(id, body.username);
    return { token: createSession(id), user: ownUser(id) };
  });

  app.post("/auth/login", async (req): Promise<AuthResponse> => {
    const body = parse(loginBody, req.body);
    const row = one<{ id: string; password_hash: string; banned_at: string | null; ban_reason: string }>(
      "SELECT id, password_hash, banned_at, ban_reason FROM users WHERE username = ?",
      body.username,
    );
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      throw new HttpError(401, "invalid_credentials", "Usuário ou senha incorretos");
    }
    refuseBanned(row);
    return { token: createSession(row.id), user: ownUser(row.id) };
  });

  app.post("/auth/logout", async (req) => {
    const token = bearerToken(req);
    if (token) deleteSession(token);
    return {};
  });

  app.get("/users/@me", async (req) => ownUser(requireUser(req)));

  app.patch("/users/@me", async (req) => {
    const userId = requireUser(req);
    const body = parse(patchMe, req.body);
    const previous = tx(() => {
      const old = getUser(userId)!;
      if (body.displayName !== undefined) run("UPDATE users SET display_name = ? WHERE id = ?", body.displayName, userId);
      if (body.bio !== undefined) run("UPDATE users SET bio = ? WHERE id = ?", body.bio, userId);
      if (body.avatarUrl === null) run("UPDATE users SET avatar_url = NULL WHERE id = ?", userId);
      return old.avatarUrl;
    });
    const user = getUser(userId)!;
    sendToAudience(userId, { t: "USER_UPDATE", d: user });
    if (body.avatarUrl === null) await discardAvatar(previous).catch((error) => app.log.warn(error, "Could not remove old avatar"));
    return user;
  });

  app.post("/users/@me/avatar", async (req) => {
    const userId = requireUser(req);
    const file = await req.file({ limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 0 } });
    if (!file) throw badRequest("Selecione uma foto");
    const bytes = await file.toBuffer();
    if (file.file.truncated) throw new HttpError(413, "too_large", "A foto deve ter no máximo 8 MB");
    const path = await createAvatar(bytes);
    const origin = config.publicUrl || `${req.protocol}://${req.host}`;
    let previous: string | null = null;
    try {
      tx(() => {
        const current = getUser(userId);
        if (!current || current.username.startsWith("deleted.")) throw notFound("Usuário");
        previous = current.avatarUrl;
        run("UPDATE users SET avatar_url = ? WHERE id = ?", new URL(path, origin).toString(), userId);
      });
    } catch (error) {
      await discardAvatar(path);
      throw error;
    }
    const user = getUser(userId)!;
    sendToAudience(userId, { t: "USER_UPDATE", d: user });
    await discardAvatar(previous).catch((error) => app.log.warn(error, "Could not remove old avatar"));
    return user;
  });

  app.get<{ Params: { id: string } }>("/avatars/:id.webp", async (req, reply) => {
    const bytes = await readAvatar(req.params.id);
    return reply
      .type("image/webp")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .send(bytes);
  });

  // Self-service deletion: personal data is erased, optionally with every message.
  app.delete("/users/@me", async (req) => {
    const userId = requireUser(req);
    const body = parse(deleteMe, req.body);
    const row = one<{ username: string; password_hash: string }>("SELECT username, password_hash FROM users WHERE id = ?", userId)!;
    if (body.confirm.trim().toLowerCase() !== row.username.toLowerCase()) throw badRequest("Digite seu nome de usuário para confirmar");
    if (row.password_hash !== "!" && !(await verifyPassword(body.password ?? "", row.password_hash))) {
      throw new HttpError(401, "invalid_credentials", "Senha incorreta");
    }
    await deleteAccount(userId, { deleteMessages: body.deleteMessages });
    return {};
  });
}
