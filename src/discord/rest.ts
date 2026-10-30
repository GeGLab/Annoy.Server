// Minimal client for Discord's official bot API. Only reads are needed.
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/GeGLab/annoy-server, 0.5.1)";
const MAX_RETRIES = 6;

export interface DUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar?: string | null;
  bot?: boolean;
}

/** Discord-hosted avatar; animated hashes ("a_") keep their animation as GIF. */
export function avatarUrlOf(user: Pick<DUser, "id" | "avatar">): string | null {
  if (!user.avatar) return null;
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

export interface DRole {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  managed: boolean;
}

export interface DGuild {
  id: string;
  name: string;
  icon: string | null;
  roles: DRole[];
}

export interface DOverwrite {
  id: string;
  /** 0 = role, 1 = member */
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface DChannel {
  id: string;
  type: number;
  name: string;
  topic?: string | null;
  parent_id: string | null;
  position: number;
  permission_overwrites?: DOverwrite[];
}

export interface DAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  content_type?: string;
}

export interface DMessage {
  id: string;
  channel_id: string;
  type: number;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  author: DUser;
  attachments: DAttachment[];
  mentions: DUser[];
  embeds: unknown[];
  sticker_items?: { name: string }[];
  message_reference?: { message_id?: string; channel_id?: string };
}

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function describe(status: number, body: { message?: string; code?: number }): string {
  if (status === 401) return "Token de bot inválido";
  if (status === 403) return "O bot não tem acesso a este recurso";
  if (status === 404) return "Não encontrado no Discord";
  return body.message ? `Discord: ${body.message}` : `Discord respondeu HTTP ${status}`;
}

/** Converts a Discord snowflake into its creation time in ms. */
export const snowflakeTime = (id: string) => Number((BigInt(id) >> 22n) + 1420070400000n);

export class DiscordRest {
  /** Honors the reset window when a bucket is exhausted, before Discord answers 429. */
  private resumeAt = 0;

  constructor(
    private readonly token: string,
    private readonly signal?: AbortSignal,
  ) {}

  async get<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.resumeAt - Date.now();
      if (wait > 0) await sleep(wait, undefined, { signal: this.signal });

      const res = await fetch(API + path, {
        headers: { Authorization: `Bot ${this.token}`, "User-Agent": USER_AGENT },
        signal: this.signal,
      });
      if (res.headers.get("x-ratelimit-remaining") === "0") {
        this.resumeAt = Date.now() + Number(res.headers.get("x-ratelimit-reset-after") ?? "1") * 1000;
      }
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number; message?: string; code?: number };

      if (res.status === 429 && attempt < MAX_RETRIES) {
        this.resumeAt = Date.now() + Math.ceil((body.retry_after ?? 1) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(1000 * (attempt + 1), undefined, { signal: this.signal });
        continue;
      }
      if (!res.ok) throw new DiscordError(res.status, describe(res.status, body));
      return body as T;
    }
  }
}

const CDN_HOSTS = /^(cdn\.discordapp\.com|media\.discordapp\.net)$/;

/** Attachment URLs come from Discord's API; refuse anything outside its CDN. */
export function isDiscordCdn(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && CDN_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}
