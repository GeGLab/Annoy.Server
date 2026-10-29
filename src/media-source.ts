import type { MediaSource } from "@distopic/protocol";

/** What a client may publish: audio is the mic or a screen's sound, video a camera or a screen. */
export function sourceFor(kind: "audio" | "video" | null, raw: unknown): MediaSource | null {
  if (kind === "audio") return raw === "screen_audio" ? "screen_audio" : "mic";
  if (kind === "video") return raw === "camera" || raw === "screen" ? raw : null;
  return null;
}
