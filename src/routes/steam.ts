import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bearerToken, requireUser } from "../auth.ts";
import { parse } from "../validate.ts";
import { beginSteamLink, completeSteamLink, disconnectSteam, pollSteamLink, steamOnlineActivity, steamStatus } from "../steam.ts";

export function steamRoutes(app: FastifyInstance) {
  app.get("/users/@me/steam", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return steamStatus(requireUser(req));
  });
  app.post("/auth/steam/begin", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return beginSteamLink(requireUser(req), bearerToken(req)!, `${req.protocol}://${req.host}`);
  });
  app.post("/auth/steam/poll", async (req, reply) => {
    const userId = requireUser(req);
    const { handoff } = parse(z.object({ handoff: z.string().min(20).max(100) }), req.body);
    reply.header("Cache-Control", "no-store");
    return pollSteamLink(userId, handoff);
  });
  app.get("/auth/steam/callback", async (req, reply) => {
    const query = parse(z.record(z.string().max(100), z.string().max(2048)), req.query);
    reply.header("Content-Type", "text/html; charset=utf-8")
      .header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
      .header("Referrer-Policy", "no-referrer").header("Cache-Control", "no-store");
    return completeSteamLink(query);
  });
  app.delete("/users/@me/steam", async (req) => {
    const userId = requireUser(req);
    disconnectSteam(userId);
    return steamStatus(userId);
  });
  app.get("/users/@me/steam/activity", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { activities: await steamOnlineActivity(requireUser(req)) };
  });
}
