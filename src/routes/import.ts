import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.ts";
import { cancelJob, getStructure, jobsFor, listGuilds, startImport } from "../discord/import.ts";
import { parse, type Params } from "../validate.ts";

// The bot token is used for the duration of the request or job only; it is never stored or logged.
const token = z.string().trim().min(30).max(200);
const snowflake = z.string().regex(/^\d{5,25}$/, "id do Discord inválido");

const importBody = z.object({
  token,
  guildId: snowflake,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("new"), name: z.string().max(100) }),
    z.object({ kind: z.literal("existing"), serverId: z.string().min(1) }),
  ]),
  roleIds: z.array(snowflake).max(500),
  channelIds: z.array(snowflake).max(1000),
  messageChannelIds: z.array(snowflake).max(1000),
  messageLimit: z.number().int().min(1).max(10_000_000).nullable(),
  attachments: z.boolean(),
  overwrites: z.boolean(),
});

export function importRoutes(app: FastifyInstance): void {
  app.post("/import/discord/guilds", async (req) => {
    requireUser(req);
    return listGuilds(parse(z.object({ token }), req.body).token);
  });

  app.post("/import/discord/structure", async (req) => {
    requireUser(req);
    const body = parse(z.object({ token, guildId: snowflake }), req.body);
    return getStructure(body.token, body.guildId);
  });

  app.post("/import/discord", async (req) => startImport(requireUser(req), parse(importBody, req.body)));

  app.get("/import/jobs", async (req) => jobsFor(requireUser(req)));

  app.post<Params<"id">>("/import/jobs/:id/cancel", async (req) => {
    cancelJob(requireUser(req), req.params.id);
    return {};
  });
}
