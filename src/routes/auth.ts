import { LIMITS, PROTOCOL_VERSION, type AuthResponse, type InstanceInfo } from "@distopic/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bearerToken, createSession, deleteSession, hashPassword, requireUser, verifyPassword } from "../auth.ts";
import { deleteAccount, RESERVED_USERNAME } from "../accounts.ts";
import { config } from "../config.ts";
import { discordLoginEnabled } from "../discord/oauth.ts";
import { now, one, run } from "../db.ts";
import { badRequest, conflict, HttpError, notFound } from "../errors.ts";
import { checkRegistration, consumeSignupInvite, getSettings, grantBootstrapAdmin } from "../instance.ts";
import { sendToAudience } from "../events.ts";
import { newId } from "../ids.ts";
import { getUser } from "../repo.ts";
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
  inviteCode: z.string().trim().max(64).optional(),
});
const deleteMe = z.object({
  /** Typed username, as confirmation (works for accounts without a password). */
  confirm: z.string(),
  password: z.string().optional(),
  deleteMessages: z.boolean().default(false),
});
const loginBody = z.object({ username: z.string(), password: z.string() });
const patchMe = z.object({ displayName });

export function authRoutes(app: FastifyInstance): void {
  app.get("/info", async (): Promise<InstanceInfo> => {
    const { registration } = getSettings();
    return {
      name: config.name,
      version: "0.3.1",
      protocol: PROTOCOL_VERSION,
      registrationOpen: registration !== "closed",
      registration,
      discordLogin: discordLoginEnabled(),
    };
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
    return { token: createSession(id), user: getUser(id)! };
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
    if (row.banned_at) throw new HttpError(403, "banned", `Conta suspensa nesta instância${row.ban_reason ? `: ${row.ban_reason}` : ""}`);
    return { token: createSession(row.id), user: getUser(row.id)! };
  });

  app.post("/auth/logout", async (req) => {
    const token = bearerToken(req);
    if (token) deleteSession(token);
    return {};
  });

  app.get("/users/@me", async (req) => getUser(requireUser(req)) ?? Promise.reject(notFound("Usuário")));

  app.patch("/users/@me", async (req) => {
    const userId = requireUser(req);
    const body = parse(patchMe, req.body);
    run("UPDATE users SET display_name = ? WHERE id = ?", body.displayName, userId);
    const user = getUser(userId)!;
    sendToAudience(userId, { t: "USER_UPDATE", d: user });
    return user;
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
