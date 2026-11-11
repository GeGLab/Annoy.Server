import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.ts";
import { forbidden } from "../errors.ts";
import { listServerIntegrations, removeServerIntegration, saveServerIntegration } from "../integrations.ts";
import { requireServer } from "../perms.ts";
import { parse, type Params } from "../validate.ts";

const saveBody = z.object({
  apiKey: z.string().max(500).nullable().optional(),
  settings: z.record(z.string().max(32), z.union([z.string().max(200), z.number()])).optional(),
});

/** Only the owner installs, configures and removes: the API key is the owner's. */
function requireOwner(serverId: string, userId: string): void {
  if (requireServer(serverId, userId).server.ownerId !== userId) throw forbidden("Apenas o dono do servidor gerencia integrações");
}

export function integrationRoutes(app: FastifyInstance) {
  app.get<Params<"id">>("/servers/:id/integrations", async (req) => {
    requireServer(req.params.id, requireUser(req));
    return listServerIntegrations(req.params.id);
  });

  app.put<Params<"id" | "integrationId">>("/servers/:id/integrations/:integrationId", async (req) => {
    const userId = requireUser(req);
    requireOwner(req.params.id, userId);
    return saveServerIntegration(req.params.id, req.params.integrationId, userId, parse(saveBody, req.body ?? {}));
  });

  app.delete<Params<"id" | "integrationId">>("/servers/:id/integrations/:integrationId", async (req) => {
    requireOwner(req.params.id, requireUser(req));
    return removeServerIntegration(req.params.id, req.params.integrationId);
  });
}
