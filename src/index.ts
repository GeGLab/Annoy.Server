import { removeServerCrypto } from "./crypto-removed.ts";
import { annoySocial, retireServerSocial, retireServerUserSettings, socialMovedRoutes, userSettingsMovedRoutes } from "./social-moved.ts";
import './service-lock.ts';
import {transportSecurity} from './transport-security.ts';
import { resourceLimits } from "./resource-limits.ts";
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
import { ensureAdminToken } from "./admin-control.ts";
import { ignoredStoredSettings } from "./instance.ts";
import { authRoutes } from "./routes/auth.ts";
import { channelRoutes } from "./routes/channels.ts";
import { discordAuthRoutes } from "./routes/discord-auth.ts";
import { steamRoutes } from "./routes/steam.ts";
import { importRoutes } from "./routes/import.ts";
import { integrationRoutes } from "./routes/integrations.ts";
import { serverRoutes } from "./routes/servers.ts";
import { socialRoutes } from "./routes/social.ts";
import { searchRoutes } from "./routes/search.ts";
import { profileRoutes } from "./routes/profiles.ts";
import { codeRoutes } from "./code.ts";
import { playbackRoutes } from "./playback.ts";
import { startTempRooms, tempRoomRoutes } from "./rooms.ts";
import { startVoice, stopVoice, voiceAddresses } from "./voice-backend.ts";

const app = Fastify({
  trustProxy:config.trustedProxies,
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    // Privacy by default: request logs carry method and path only, never client IPs.
    serializers: { req: (req) => ({ method: req.method, url: req.url.split("?")[0] }), err: () => ({ type: "Error", code: "operation_failed", message: "Operation failed", stack: "" }) },
    redact: ["req.headers.authorization", "req.body", "password", "token", "privateKey"],
  },
  bodyLimit: 2 * 1024 * 1024,
  requestTimeout: 30_000,
  connectionTimeout: 15_000,
});

// Bearer authentication and an explicit origin allowlist.
transportSecurity(app);
resourceLimits(app);
const allowedOrigins=new Set((process.env.ANNOY_ALLOWED_ORIGINS??"null,https://annoy.localhost,http://127.0.0.1:5173,http://localhost:5173").split(",").map(s=>s.trim()));
if(config.publicUrl)allowedOrigins.add(new URL(config.publicUrl).origin);
await app.register(cors, { origin: (origin,callback)=>callback(null,!origin||allowedOrigins.has(origin)), methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });
// Per-upload size comes from the instance settings (see routes/channels.ts); this is only the ceiling.
await app.register(multipart, { limits: { fileSize: config.uploadCeilingBytes, files: 10, fields: 10 } });
await app.register(websocket, {
  options: { maxPayload: 64 * 1024 },
  async preClose(this: import("fastify").FastifyInstance) {
    const mediaClosing = stopVoice();
    closeForRestart();
    await mediaClosing;
    this.websocketServer.close();
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
const decrypted = await removeServerCrypto();
if (decrypted) app.log.info(`Criptografia MLS removida: ${decrypted.tables} tabelas e ${decrypted.files} arquivos cifrados apagados; mensagens dos canais voltam a ser em texto.`);
const retired = await retireServerSocial();
if (retired) app.log.info(`Conta Annoy: ${retired.dms} DMs e ${retired.relationships} amizades saíram deste servidor (agora ficam na nuvem Annoy).`);
const retiredSettings = retireServerUserSettings();
if (retiredSettings) app.log.info(`Conta Annoy: ${retiredSettings.steam} conexões Steam, ${retiredSettings.fields} contatos de perfil e ${retiredSettings.history} itens de histórico saíram deste servidor (agora ficam na conta Annoy).`);
ensureAdminToken();
const ignored = ignoredStoredSettings();
if (ignored.length) app.log.warn(`Configurações salvas pelo app ignoradas (${ignored.join(", ")}): agora valem só as flags do .env (ANNOY_REGISTRATION, ANNOY_MAX_UPLOAD_MB, ANNOY_MAX_SERVERS_PER_USER).`);
registerGateway(app);
startTempRooms();
await app.register(
  async (api) => {
    authRoutes(api);
    if (annoySocial) userSettingsMovedRoutes(api);
    else {
      discordAuthRoutes(api);
      steamRoutes(api);
      profileRoutes(api);
    }
    serverRoutes(api);
    channelRoutes(api);
    if (annoySocial) socialMovedRoutes(api);
    else {
      socialRoutes(api);
      callRoutes(api);
    }
    searchRoutes(api);
    importRoutes(api);
    integrationRoutes(api);
    playbackRoutes(api);
    codeRoutes(api);
    tempRoomRoutes(api);
    await api.register(adminRoutes);
  },
  { prefix: "/api" },
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
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
