import {mediaProtection} from '../media-security.ts';
import { LIMITS, PROTOCOL_VERSION, type AuthResponse, type InstanceInfo, type User } from "@distopic/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, createSession, deleteSession, hashPassword, hashToken, deleteSessionsOf, requireUser, verifyPassword, spendPasswordTime, userIdForToken } from "../auth.ts";
import { deleteAccount, mergeUsers, RESERVED_USERNAME } from "../accounts.ts";
import { requireAccountMode } from "../account-policy.ts";
import {sessionChanged} from "../session-events.ts";
import {validateDpopRequest,dpopNonce,verifyDpop,boundDevice} from "../dpop.ts";
import {activeDevice} from "../devices.ts";
import { cryptoInstanceId } from "../devices.ts";
import { config } from "../config.ts";
import { VERSION } from "../version.ts";
import { now, one, run, tx } from "../db.ts";
import { createAvatar, discardAvatar, MAX_AVATAR_BYTES, readAvatar } from "../avatars.ts";
import { badRequest, conflict, HttpError, notFound, forbidden, unauthorized } from "../errors.ts";
import { checkRegistration, consumeSignupInvite, getSettings, grantBootstrapAdmin } from "../instance.ts";
import { sendToAudience } from "../events.ts";
import { newId } from "../ids.ts";
import { getUser } from "../repo.ts";
import { globalLoginAvailable, globalServerId, newChallenge, verifyGlobalProof } from "../global.ts";
import { authAttempt } from "../auth-limits.ts";
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
const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().max(256) });
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

const migrationCredentials = z.object({
  username: z.string().max(64).optional(),
  password: z.string().max(256).optional(),
  recoveryCode: z.string().max(128).optional(),
});
interface MigrationUser {
  id: string;
  username: string;
  password_hash: string;
  global_id: string | null;
  banned_at: string | null;
  ban_reason: string;
}
interface MigrationOwner extends MigrationUser { proofKind: "session" | "password" | "recovery"; proofHash: string }
function migrationSession(req: FastifyRequest): MigrationUser | undefined {
  const token = bearerToken(req);
  return token ? one<MigrationUser>("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned_at IS NULL", hashToken(token), now()) : undefined;
}
async function migrationOwner(req: FastifyRequest, credentials: z.infer<typeof migrationCredentials>): Promise<MigrationOwner> {
  const sessionOwner = migrationSession(req);
  if (sessionOwner && (!credentials.username || sessionOwner.username.toLowerCase() === credentials.username.toLowerCase())) {
    return { ...sessionOwner, proofKind: "session", proofHash: hashToken(bearerToken(req)!) };
  }
  const row = credentials.username ? one<MigrationUser>("SELECT * FROM users WHERE username = ?", credentials.username) : undefined;
  if (row) {
    if (credentials.recoveryCode && one("SELECT 1 FROM account_recovery WHERE user_id = ? AND token_hash = ? AND expires_at > ?", row.id, hashToken(credentials.recoveryCode), now())) {
      refuseBanned(row);
      return { ...row, proofKind: "recovery", proofHash: hashToken(credentials.recoveryCode) };
    }
    if (credentials.password && await verifyPassword(credentials.password, row.password_hash)) {
      refuseBanned(row);
      return { ...row, proofKind: "password", proofHash: row.password_hash };
    }
  }
  throw new HttpError(401, "invalid_credentials", "Confirme a conta anterior com a senha, sessão salva ou código de recuperação do administrador");
}
/** Recheck revocation/one-use after async password hashing, before writing. */
function confirmMigrationOwner(owner: MigrationOwner): MigrationUser {
  const current = one<MigrationUser>("SELECT * FROM users WHERE id = ?", owner.id);
  if (!current) throw notFound("Conta anterior");
  refuseBanned(current);
  const valid = owner.proofKind === "password" ? current.password_hash === owner.proofHash
    : owner.proofKind === "session" ? one("SELECT 1 FROM sessions WHERE user_id = ? AND token_hash = ? AND expires_at > ?", owner.id, owner.proofHash, now())
    : one("SELECT 1 FROM account_recovery WHERE user_id = ? AND token_hash = ? AND expires_at > ?", owner.id, owner.proofHash, now());
  if (!valid) throw new HttpError(401, "invalid_credentials", "A comprovação anterior expirou ou já foi utilizada");
  return current;
}

export function authRoutes(app: FastifyInstance): void {
  app.addHook("preValidation", async (req,reply) => {
    await validateDpopRequest(req,reply);
    if (req.method === "POST" && /(?:^|\/)auth\//.test(req.routeOptions.url ?? "")) authAttempt(req);
  });
  app.get("/media/config", async (req, reply) => {
    requireUser(req);
    reply.header("Cache-Control", "no-store");
    return { giphyApiKey: process.env.GIPHY_CLIENT_API_KEY ?? null };
  });
  app.get("/info", async (): Promise<InstanceInfo> => {
    const { registration } = getSettings();
    return {
      name: config.name,
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      registrationOpen: registration !== "closed",
      registration,
      accountMode: config.accountMode,
      crypto: { version: 1, protocol: "MLS-RFC9420", instanceId: cryptoInstanceId(), dpopNonce,media:mediaProtection },
      discordLogin: false,
      globalServerId: globalLoginAvailable() ? globalServerId() : null,
    };
  });

  // Annoy Global login (Annoy-api-global DESIGN.md): the client signs a one-time
  // challenge with its identity for this server and shows a blind token.
  app.post("/auth/global/challenge", async () => ({ challenge: newChallenge() }));

  app.post("/auth/global", async (req): Promise<AuthResponse> => {
    requireAccountMode("global");
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

  app.post('/auth/device-bind',async req=>{
    const user=requireUser(req),token=bearerToken(req)!;
    const body=parse(z.object({deviceId:z.string().regex(/^[A-Za-z0-9_-]{43}$/),proof:z.string().max(8192)}).strict(),req.body);
    activeDevice(body.deviceId,user);
    if(boundDevice(token) && boundDevice(token)!==body.deviceId)throw forbidden('Sessão já vinculada a outro dispositivo');
    await verifyDpop(token,body.proof,'POST',new URL(req.url,config.publicUrl||`${req.protocol}://${req.host}`).toString(),body.deviceId);
    if(!userIdForToken(token))throw unauthorized();
    run('UPDATE sessions SET device_id=?,expires_at=? WHERE token_hash=?',body.deviceId,new Date(Date.now()+24*3600000).toISOString(),hashToken(token));
    sessionChanged(hashToken(token),'rebound');
    return {tokenType:'DPoP',deviceId:body.deviceId};
  });

  // Migration credentials never create an ordinary session on their own.
  app.post("/auth/migration/status", async (req) => {
    const row = migrationSession(req);
    return row ? { username: row.username, accountMode: config.accountMode,
      pending: config.accountMode === "global" ? !row.global_id : !(row.password_hash.startsWith("scrypt$") || row.password_hash.startsWith("$argon2id$")) }
      : { accountMode: config.accountMode, pending: false };
  });

  app.post("/auth/migrate/global", async (req): Promise<AuthResponse & { removedUserId: string | null }> => {
    requireAccountMode("global");
    const body = parse(globalProof.extend(migrationCredentials.shape), req.body);
    const owner = await migrationOwner(req, body);
    const current = confirmMigrationOwner(owner);
    if (current.global_id && current.global_id !== owner.global_id) throw conflict("Esta conta já foi migrada; entre com a conta Annoy");
    const identity = verifyGlobalProof(body);
    const holder = one<MigrationUser>("SELECT * FROM users WHERE global_id = ?", identity);
    if (holder) refuseBanned(holder);
    if (owner.global_id && owner.global_id !== identity) throw conflict("Esta conta já utiliza outra conta Annoy");
    if (holder && holder.id !== owner.id) {
      if (owner.global_id) throw conflict("Esta conta já utiliza uma conta Annoy");
      mergeUsers(owner.id, holder.id);
    }
    tx(() => {
      run("UPDATE users SET global_id = ?, password_hash = '!' WHERE id = ?", identity, owner.id);
      run("DELETE FROM account_recovery WHERE user_id = ?", owner.id);
      deleteSessionsOf(owner.id);
    });
    return { token: createSession(owner.id), user: ownUser(owner.id), removedUserId: holder && holder.id !== owner.id ? holder.id : null };
  });

  app.post("/auth/migrate/local", async (req): Promise<AuthResponse> => {
    requireAccountMode("local");
    const body = parse(migrationCredentials.extend({ newPassword: z.string().min(LIMITS.passwordMin).max(256) }), req.body);
    const owner = await migrationOwner(req, body);
    if (owner.password_hash.startsWith("scrypt$")) throw conflict("Esta conta já tem senha local; entre normalmente");
    const passwordHash = await hashPassword(body.newPassword);
    tx(() => {
      const current = confirmMigrationOwner(owner);
      if (current.password_hash !== owner.password_hash) throw conflict("Esta conta já foi migrada; entre com a senha local");
      run("UPDATE users SET password_hash = ?, global_id = NULL WHERE id = ?", passwordHash, owner.id);
      run("DELETE FROM account_recovery WHERE user_id = ?", owner.id);
      deleteSessionsOf(owner.id);
    });
    return { token: createSession(owner.id), user: ownUser(owner.id) };
  });

  for (const path of ["/users/@me/global", "/users/@me/global/merge"]) {
    app.post(path, async () => { throw new HttpError(410, "migration_required", "Use o fluxo de migração de contas desta versão"); });
  }
  app.delete("/users/@me/global", async () => {
    throw new HttpError(403, "account_mode", "O modo de conta é definido exclusivamente pelo servidor");
  });

  app.post("/auth/register", async (req): Promise<AuthResponse> => {
    requireAccountMode("local");
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
    requireAccountMode("local");
    const body = parse(loginBody, req.body);
    const row = one<{ id: string; password_hash: string; banned_at: string | null; ban_reason: string }>(
      "SELECT id, password_hash, banned_at, ban_reason FROM users WHERE username = ?",
      body.username,
    );
    if (!row) {
      await spendPasswordTime(body.password);
      throw new HttpError(401, "invalid_credentials", "Usuário ou senha incorretos");
    }
    if (!(await verifyPassword(body.password, row.password_hash))) {
      throw new HttpError(401, "invalid_credentials", "Usuário ou senha incorretos");
    }
    refuseBanned(row);
    let expectedHash = row.password_hash;
    if (row.password_hash.startsWith("scrypt$")) {
      const upgraded = await hashPassword(body.password);
      run("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?", upgraded, row.id, row.password_hash);
      expectedHash = upgraded;
    }
    const current = one<{ password_hash: string; global_id: string | null; banned_at: string | null }>("SELECT password_hash, global_id, banned_at FROM users WHERE id = ?", row.id);
    if (!current || current.banned_at || current.global_id ||
      current.password_hash !== expectedHash) {
      throw new HttpError(401, "invalid_credentials", "Usuário ou senha incorretos");
    }
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
