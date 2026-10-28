import { LIMITS, PROTOCOL_VERSION, type AuthResponse, type InstanceInfo } from "@distopic/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bearerToken, createSession, deleteSession, hashPassword, requireUser, verifyPassword } from "../auth.ts";
import { config } from "../config.ts";
import { discordLoginEnabled } from "../discord/oauth.ts";
import { now, one, run } from "../db.ts";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../errors.ts";
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
});
const loginBody = z.object({ username: z.string(), password: z.string() });
const patchMe = z.object({ displayName });

export function authRoutes(app: FastifyInstance): void {
  app.get("/info", async (): Promise<InstanceInfo> => ({
    name: config.name,
    version: "0.1.0",
    protocol: PROTOCOL_VERSION,
    registrationOpen: config.registrationOpen,
    discordLogin: discordLoginEnabled(),
  }));

  app.post("/auth/register", async (req): Promise<AuthResponse> => {
    if (!config.registrationOpen) throw forbidden("Cadastro fechado nesta instância");
    const body = parse(registerBody, req.body);
    if (/^dc\./i.test(body.username)) throw badRequest('O prefixo "dc." é reservado para perfis importados do Discord');
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
    return { token: createSession(id), user: getUser(id)! };
  });

  app.post("/auth/login", async (req): Promise<AuthResponse> => {
    const body = parse(loginBody, req.body);
    const row = one<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE username = ?", body.username);
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      throw new HttpError(401, "invalid_credentials", "Usuário ou senha incorretos");
    }
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
}
