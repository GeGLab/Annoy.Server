// Profiles of Annoy accounts live only in usersannoy. This server keeps no copy: when it needs a
// name (member search and order, code commits, admin listings, first-party integrations), it reads
// it there by Annoy ID with its Global registration. A short cache spares repeated reads of the
// same page; it is never a store.
import { config } from "./config.ts";
import { one } from "./db.ts";

export interface AnnoyProfile { id: string; username: string; displayName: string | null; avatar: string | null; bio: string | null }

const TTL_MS = 30_000;
/** `Server <id>:<secret>` of this server's Global registration (read here, not via global.ts, to keep imports acyclic). */
function serverAuthorization(): string | null {
  if (!config.global.enabled) return null;
  const read = (key: string) => one<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", key)?.value ?? null;
  const id = read("global.serverId"), secret = read("global.serverSecret");
  return id && secret ? `Server ${id}:${secret}` : null;
}
const BATCH = 200;
const cache = new Map<string, { at: number; profile: AnnoyProfile | null }>();

/** Profiles by Annoy ID; IDs that could not be read are left out. */
export async function annoyProfiles(ids: Iterable<string>): Promise<Map<string, AnnoyProfile>> {
  const out = new Map<string, AnnoyProfile>();
  const missing: string[] = [];
  const now = Date.now();
  for (const id of new Set(ids)) {
    const hit = cache.get(id);
    if (hit && now - hit.at < TTL_MS) { if (hit.profile) out.set(id, hit.profile); }
    else missing.push(id);
  }
  const authorization = serverAuthorization();
  if (!missing.length || !authorization || !config.global.usersUrl) return out;
  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    try {
      const res = await fetch(`${config.global.usersUrl}/v1/servers/profiles`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ ids: chunk }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const { users } = (await res.json()) as { users: AnnoyProfile[] };
      const found = new Map(users.map((u) => [u.id, u]));
      for (const id of chunk) {
        const profile = found.get(id) ?? null;
        cache.set(id, { at: now, profile });
        if (profile) out.set(id, profile);
      }
    } catch {
      /* usersannoy unreachable: names stay unknown for now */
    }
  }
  if (cache.size > 50_000) for (const [id, v] of cache) if (now - v.at > TTL_MS) cache.delete(id);
  return out;
}

/** The name shown for an Annoy account: display name, else @username, else its Annoy ID. */
export const annoyName = (profile: AnnoyProfile | undefined, annoyId: string) => profile?.displayName || profile?.username || annoyId;
