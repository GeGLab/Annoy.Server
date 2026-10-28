import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.ts";
import { beginLogin, completeLogin, discordLoginEnabled, pollLogin } from "../discord/oauth.ts";
import { badRequest, HttpError } from "../errors.ts";
import { parse } from "../validate.ts";

const beginBody = z.object({ link: z.boolean().optional(), inviteCode: z.string().trim().max(64).optional() });
const pollBody = z.object({ handoff: z.string().min(20).max(100) });
const callbackQuery = z.object({ state: z.string().max(100), code: z.string().max(500).optional(), error: z.string().max(100).optional() });

const originOf = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

export function discordAuthRoutes(app: FastifyInstance): void {
  app.post("/auth/discord/begin", async (req) => {
    if (!discordLoginEnabled()) throw new HttpError(404, "disabled", "Login com Discord não está configurado nesta instância");
    const body = parse(beginBody, req.body);
    const linkUserId = body.link ? requireUser(req) : null;
    try {
      return beginLogin(originOf(req), linkUserId, body.inviteCode);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  app.post("/auth/discord/poll", async (req) => pollLogin(parse(pollBody, req.body).handoff));

  app.get("/auth/discord/callback", async (req, reply) => {
    const q = parse(callbackQuery, req.query);
    reply.header("Content-Type", "text/html; charset=utf-8").header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    return completeLogin(q.state, q.code, q.error);
  });
}
