// Monthly egress budget for the Cloudflare SFU. Cloudflare bills what it sends
// to clients and offers no spending cap, so the server estimates that traffic
// from what each client receives and steps media down before the budget runs out.
//
// The estimate assumes every received track runs at its full bitrate, so real
// usage stays below it. Months are UTC calendar months, which may not match
// the Cloudflare billing cycle exactly.
import type { MediaSource, VoiceUsage } from "@distopic/protocol";
import { config } from "./config.ts";
import { one, run } from "./db.ts";

/** Bytes per second per received track: client bitrate caps plus RTP/UDP/IP overhead. */
const RATE: Record<MediaSource, number> = {
  mic: 80_000 / 8,
  camera: 1_300_000 / 8,
  screen: 3_700_000 / 8,
  screen_audio: 150_000 / 8,
};
const MAX_VIDEO_BITRATE = 10_000_000;

/**
 * Bytes per second a track costs each viewer. Video uses the cap its sender
 * declared (screens go up to 60 fps or more), plus about 6% of packet overhead.
 */
export function rateFor(source: MediaSource, maxBitrate?: unknown): number {
  if ((source === "camera" || source === "screen") && typeof maxBitrate === "number" && Number.isFinite(maxBitrate) && maxBitrate > 0)
    return (Math.min(maxBitrate, MAX_VIDEO_BITRATE) * 1.06) / 8;
  return RATE[source];
}

const VIDEO_OFF_AT = 0.8;
const OFF_AT = 0.95;

const limitBytes = config.voice.cloudflare.monthlyGb * 1e9;
const month = () => new Date().toISOString().slice(0, 7);
const key = (m: string) => `sfu.egress.${m}`;

let current = month();
let bytes = Number(one<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", key(current))?.value ?? 0);

/** Adds the traffic of `seconds` spent delivering tracks at these rates (bytes per second, see `rateFor`). */
export function record(rates: Iterable<number>, seconds: number): void {
  const m = month();
  if (m !== current) {
    current = m;
    bytes = 0;
  }
  let added = 0;
  for (const rate of rates) added += rate * seconds;
  if (added === 0) return;
  bytes += Math.round(added);
  run("INSERT INTO instance_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key(current), String(bytes));
}

export function level(): VoiceUsage["level"] {
  if (limitBytes <= 0 || month() !== current) return "ok";
  if (bytes >= limitBytes * OFF_AT) return "off";
  if (bytes >= limitBytes * VIDEO_OFF_AT) return "video_off";
  return "ok";
}

export function usage(): VoiceUsage {
  const l = level();
  return { month: month(), bytes: month() === current ? bytes : 0, limitBytes: Math.max(limitBytes, 0), level: l };
}
