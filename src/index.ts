import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { HttpError } from "./errors.ts";
import { registerGateway } from "./gateway.ts";
import { authRoutes } from "./routes/auth.ts";
import { channelRoutes } from "./routes/channels.ts";
import { discordAuthRoutes } from "./routes/discord-auth.ts";
import { importRoutes } from "./routes/import.ts";
import { serverRoutes } from "./routes/servers.ts";
import { socialRoutes } from "./routes/social.ts";
import { startVoice, voiceAddress } from "./voice.ts";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 1024 * 1024,
});

// Auth is a bearer token, never a cookie, so any origin may call the API.
await app.register(cors, { origin: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });
await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 10, fields: 10 } });
await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.status(status).send({ error: "bad_request", message: (err as Error).message });
  app.log.error(err);
  return reply.status(500).send({ error: "internal", message: "Erro interno do servidor" });
});

await startVoice();
registerGateway(app);
await app.register(
  async (api) => {
    authRoutes(api);
    discordAuthRoutes(api);
    serverRoutes(api);
    channelRoutes(api);
    socialRoutes(api);
    importRoutes(api);
  },
  { prefix: "/api" },
);

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.host, port: config.port });
app.log.info(
  `${config.name} pronto: http://${config.host}:${config.port} · voz UDP/TCP ${config.voice.port} anunciada em ${voiceAddress()}`,
);
