import { callRoutes } from "./calls.ts";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { HttpError } from "./errors.ts";
import { closeForRestart, registerGateway } from "./gateway.ts";
import { syncConfiguredAdmin } from "./instance.ts";
import { startGlobal } from "./global.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { channelRoutes } from "./routes/channels.ts";
import { discordAuthRoutes } from "./routes/discord-auth.ts";
import { steamRoutes } from "./routes/steam.ts";
import { importRoutes } from "./routes/import.ts";
import { serverRoutes } from "./routes/servers.ts";
import { socialRoutes } from "./routes/social.ts";
import { searchRoutes } from "./routes/search.ts";
import { profileRoutes } from "./routes/profiles.ts";
import { codeRoutes } from "./code.ts";
import { playbackRoutes } from "./playback.ts";
import { startTempRooms, tempRoomRoutes } from "./rooms.ts";
import { startVoice, voiceAddresses } from "./voice-backend.ts";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    // Privacy by default: request logs carry method and path only, never client IPs.
    serializers: { req: (req) => ({ method: req.method, url: req.url.split("?")[0] }) },
  },
  bodyLimit: 1024 * 1024,
});

// Auth is a bearer token, never a cookie, so any origin may call the API.
await app.register(cors, { origin: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });
// Per-upload size comes from the instance settings (see routes/channels.ts); this is only the ceiling.
await app.register(multipart, { limits: { fileSize: config.uploadCeilingBytes, files: 10, fields: 10 } });
await app.register(websocket, {
  options: { maxPayload: 64 * 1024 },
  preClose(done) {
    closeForRestart();
    this.websocketServer.close();
    done();
  },
});

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.status(status).send({ error: "bad_request", message: (err as Error).message });
  app.log.error(err);
  return reply.status(500).send({ error: "internal", message: "Erro interno do servidor" });
});

syncConfiguredAdmin();
startGlobal((msg) => app.log.info(msg));
await startVoice();
registerGateway(app);
startTempRooms();
await app.register(
  async (api) => {
    authRoutes(api);
    discordAuthRoutes(api);
    steamRoutes(api);
    serverRoutes(api);
    channelRoutes(api);
    socialRoutes(api);
    callRoutes(api);
    searchRoutes(api);
    profileRoutes(api);
    importRoutes(api);
    playbackRoutes(api);
    codeRoutes(api);
    tempRoomRoutes(api);
    await api.register(adminRoutes);
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
// Voice media goes straight to the announced address; a container or loopback address reaches nobody.
if (config.voice.backend === "builtin" && config.voice.announcedAddresses.length === 0 && voiceAddresses().every((a) => /^(127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a))) {
  app.log.warn(
    `Voz anunciada em ${voiceAddresses().join(", ")}, um endereço interno (Docker ou loopback): outras máquinas não vão conseguir falar. Defina ANNOY_ANNOUNCED_IP com o IP público e o da LAN.`,
  );
}
app.log.info(
  `${config.name} pronto: http://${config.host}:${config.port} · voz UDP/TCP em ${voiceAddresses().join(", ")}`,
);
