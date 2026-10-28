import { createSocket } from "node:dgram";
import { resolve } from "node:path";

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

if (env("DISTOPIC_VOICE_BACKEND", "builtin") === "cloudflare" && (!process.env.DISTOPIC_CF_SFU_APP_ID || !process.env.DISTOPIC_CF_SFU_APP_TOKEN)) {
  throw new Error("DISTOPIC_VOICE_BACKEND=cloudflare needs DISTOPIC_CF_SFU_APP_ID and DISTOPIC_CF_SFU_APP_TOKEN");
}

const registration = env("DISTOPIC_REGISTRATION", "invite");
if (registration !== "open" && registration !== "invite" && registration !== "closed") {
  throw new Error(`DISTOPIC_REGISTRATION must be "open", "invite" or "closed", got "${registration}"`);
}

export const config = {
  name: env("DISTOPIC_NAME", "Distopic"),
  host: env("DISTOPIC_HOST", "0.0.0.0"),
  port: int("DISTOPIC_PORT", 8787),
  dataDir: resolve(env("DISTOPIC_DATA_DIR", "./data")),
  /** Defaults only: the instance admin can change these at runtime (see instance.ts). */
  defaults: {
    registration: registration as "open" | "invite" | "closed",
    maxUploadMb: int("DISTOPIC_MAX_UPLOAD_MB", 25),
    maxServersPerUser: int("DISTOPIC_MAX_SERVERS_PER_USER", 0) || null,
  },
  /** Username that is always an instance admin. Otherwise the first account becomes admin. */
  adminUsername: env("DISTOPIC_ADMIN", ""),
  /** Hard ceiling for request parsing; the admin's limit applies per upload below it. */
  uploadCeilingBytes: 500 * 1024 * 1024,
  /** Public origin clients and browsers use to reach this server (OAuth redirects). */
  publicUrl: env("DISTOPIC_PUBLIC_URL", "").replace(/\/+$/, ""),
  /** "Entrar com Discord" is offered only when both are set. */
  discord: {
    clientId: env("DISTOPIC_DISCORD_CLIENT_ID", ""),
    clientSecret: env("DISTOPIC_DISCORD_CLIENT_SECRET", ""),
  },
  voice: {
    backend: (env("DISTOPIC_VOICE_BACKEND", "builtin") === "cloudflare" ? "cloudflare" : "builtin") as "builtin" | "cloudflare",
    /** Cloudflare Realtime SFU application (Dashboard → Realtime → SFU). The token never leaves the server. */
    cloudflare: {
      appId: env("DISTOPIC_CF_SFU_APP_ID", ""),
      appToken: env("DISTOPIC_CF_SFU_APP_TOKEN", ""),
    },
    port: int("DISTOPIC_VOICE_PORT", 40000),
    /**
     * Addresses clients use to reach voice media, comma-separated. List the
     * public IP first and the LAN IP second to serve both outside and home
     * players: each address gets its own port (port, port+1, ...), and ICE
     * picks whichever one works for that client.
     */
    announcedAddresses: env("DISTOPIC_ANNOUNCED_IP", "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
  },
} as const;
