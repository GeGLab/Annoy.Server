import { createSocket } from "node:dgram";
import { MIN_CLIENT_VERSION, isVersion } from "./version.ts";
import { resolve } from "node:path";
import {trustedProxies} from './trusted-proxies.ts';
import {secureServiceUrl} from './service-url.ts';

// 0.3 renamed DISTOPIC_* to ANNOY_*; existing deployments keep working.
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("DISTOPIC_")) process.env[`ANNOY_${key.slice("DISTOPIC_".length)}`] ??= value;
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

/**
 * Source address of the default route, so LAN clients reach voice without
 * setup. Connecting a UDP socket only selects a route; no packet is sent.
 */
export function detectRouteAddress(): Promise<string> {
  return new Promise((resolvePromise) => {
    const socket = createSocket("udp4");
    const done = (address: string) => {
      socket.close();
      resolvePromise(address);
    };
    socket.once("error", () => done("127.0.0.1"));
    socket.connect(53, "1.1.1.1", () => done(socket.address().address));
  });
}

if (env("ANNOY_VOICE_BACKEND", "builtin") === "cloudflare" && (!process.env.ANNOY_CF_SFU_APP_ID || !process.env.ANNOY_CF_SFU_APP_TOKEN)) {
  throw new Error("ANNOY_VOICE_BACKEND=cloudflare needs ANNOY_CF_SFU_APP_ID and ANNOY_CF_SFU_APP_TOKEN");
}

const minClientVersion = env("ANNOY_MIN_CLIENT_VERSION", MIN_CLIENT_VERSION);
if (!isVersion(minClientVersion)) throw new Error(`ANNOY_MIN_CLIENT_VERSION must look like 0.8.0, got "${minClientVersion}"`);
const registration = env("ANNOY_REGISTRATION", "invite");
if (registration !== "open" && registration !== "invite" && registration !== "closed") {
  throw new Error(`ANNOY_REGISTRATION must be "open", "invite" or "closed", got "${registration}"`);
}

// A legacy flag must never silently select an authentication policy.
const accountMode = process.env.ANNOY_ACCOUNT_MODE ?? "global";
if (accountMode !== "global" && accountMode !== "local") {
  throw new Error('ANNOY_ACCOUNT_MODE must be "global" or "local"');
}
if (process.env.ANNOY_GLOBAL !== undefined) {
  throw new Error("ANNOY_ACCOUNT_MODE: remove legacy ANNOY_GLOBAL and explicitly configure global or local");
}

export const config = {
  trustedProxies:trustedProxies(process.env.ANNOY_TRUSTED_PROXIES),
  accountMode: accountMode as "global" | "local",
  /** Oldest client version this instance accepts (ANNOY_MIN_CLIENT_VERSION). */
  minClientVersion,
  name: env("ANNOY_NAME", "Annoy"),
  host: env("ANNOY_HOST", "0.0.0.0"),
  port: int("ANNOY_PORT", 8787),
  dataDir: resolve(env("ANNOY_DATA_DIR", "./data")),
  /** annoy-server settings; only these flags set them (see instance.ts). */
  defaults: {
    registration: registration as "open" | "invite" | "closed",
    maxUploadMb: int("ANNOY_MAX_UPLOAD_MB", 25),
    maxServersPerUser: int("ANNOY_MAX_SERVERS_PER_USER", 0) || null,
  },
  /** Username that administers the annoy-server (exempt from limits). Otherwise the first account. */
  adminUsername: env("ANNOY_ADMIN", ""),
  /** Hard ceiling for request parsing; the admin's limit applies per upload below it. */
  uploadCeilingBytes: 500 * 1024 * 1024,
  /** Public origin clients and browsers use to reach this server (OAuth redirects). */
  publicUrl: process.env.ANNOY_PUBLIC_URL?secureServiceUrl(process.env.ANNOY_PUBLIC_URL):'',
  /** devannoy: the store catalog of integrations. Read only in Annoy-account mode. */
  storeUrl: env("ANNOY_STORE_URL", "https://devannoy.geg.dev.br").replace(/\/+$/, ""),
  /** Optional: OpenID linking works without a key; online game lookup needs one. */
  steamApiKey: env("ANNOY_STEAM_API_KEY", ""),
  /** "Entrar com Discord" is offered only when both are set. */
  discord: {
    clientId: env("ANNOY_DISCORD_CLIENT_ID", ""),
    clientSecret: env("ANNOY_DISCORD_CLIENT_SECRET", ""),
  },
  /**
   * Exclusive Global authentication by default. ANNOY_ACCOUNT_MODE=local
   * disables all Annoy Global traffic. Changing an existing mode requires migration.
   */
  global: {
    enabled: accountMode === "global",
    url: accountMode==='global'?secureServiceUrl(env("ANNOY_GLOBAL_URL", "https://global.geg.dev.br")):env("ANNOY_GLOBAL_URL", "https://global.geg.dev.br").replace(/\/+$/, ""),
    /** authannoy: blind-token and attestation keys (TODO item 2). The Global's address also serves them. */
    authUrl: accountMode==='global'?secureServiceUrl(env("ANNOY_AUTH_URL", env("ANNOY_GLOBAL_URL", "https://global.geg.dev.br"))):"",
  },
  /**
   * Folder shared with the "updater" Compose service (/control in
   * docker-compose.yml). Empty outside Docker: updates are then manual.
   */
  updateControlDir: env("ANNOY_CONTROL_DIR", ""),
  voice: {
    backend: (env("ANNOY_VOICE_BACKEND", "builtin") === "cloudflare" ? "cloudflare" : "builtin") as "builtin" | "cloudflare",
    /** Cloudflare Realtime SFU application (Dashboard → Realtime → SFU). The token never leaves the server. */
    cloudflare: {
      appId: env("ANNOY_CF_SFU_APP_ID", ""),
      appToken: env("ANNOY_CF_SFU_APP_TOKEN", ""),
      /**
       * Monthly egress budget in GB (Cloudflare's free tier is 1000). Near it,
       * cameras and screens stop; at the edge, voice stops until next month.
       * 0 disables the guard.
       */
      monthlyGb: int("ANNOY_CF_SFU_MONTHLY_GB", 1000),
    },
    port: int("ANNOY_VOICE_PORT", 40000),
    /**
     * Addresses clients use to reach voice media, comma-separated. List the
     * public IP first and the LAN IP second to serve both outside and home
     * players: each address gets its own port (port, port+1, ...), and ICE
     * picks whichever one works for that client.
     */
    announcedAddresses: env("ANNOY_ANNOUNCED_IP", "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
  },
} as const;
