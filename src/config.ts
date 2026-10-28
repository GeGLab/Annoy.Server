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

const registration = env("DISTOPIC_REGISTRATION", "open");
if (registration !== "open" && registration !== "closed") {
  throw new Error(`DISTOPIC_REGISTRATION must be "open" or "closed", got "${registration}"`);
}

export const config = {
  name: env("DISTOPIC_NAME", "Distopic"),
  host: env("DISTOPIC_HOST", "0.0.0.0"),
  port: int("DISTOPIC_PORT", 8787),
  dataDir: resolve(env("DISTOPIC_DATA_DIR", "./data")),
  registrationOpen: registration === "open",
  maxUploadBytes: int("DISTOPIC_MAX_UPLOAD_MB", 25) * 1024 * 1024,
  /** Public origin clients and browsers use to reach this server (OAuth redirects). */
  publicUrl: env("DISTOPIC_PUBLIC_URL", "").replace(/\/+$/, ""),
  /** "Entrar com Discord" is offered only when both are set. */
  discord: {
    clientId: env("DISTOPIC_DISCORD_CLIENT_ID", ""),
    clientSecret: env("DISTOPIC_DISCORD_CLIENT_SECRET", ""),
  },
  voice: {
    port: int("DISTOPIC_VOICE_PORT", 40000),
    /** Address clients use to reach the media port; set the public IP when hosting on the internet. */
    announcedAddress: process.env.DISTOPIC_ANNOUNCED_IP || null,
  },
} as const;
