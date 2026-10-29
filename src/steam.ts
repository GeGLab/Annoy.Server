import { randomBytes } from "node:crypto";
import type { SteamConnectionStatus, SteamLinkBegin, SteamLinkPoll, UserActivity } from "@distopic/protocol";
import { userIdForToken } from "./auth.ts";
import { config } from "./config.ts";
import { now, one, run } from "./db.ts";
import { badRequest } from "./errors.ts";

const ENDPOINT = "https://steamcommunity.com/openid/login";
const NS = "http://specs.openid.net/auth/2.0";
const TTL = 10 * 60_000;
interface Pending {
  userId: string;
  token: string;
  handoff: string;
  returnTo: string;
  expires: number;
  processing: boolean;
  result: SteamLinkPoll;
}
const pending = new Map<string, Pending>();
const secret = () => randomBytes(32).toString("base64url");
function prune() {
  for (const [state, item] of pending) if (item.expires < Date.now()) pending.delete(state);
}
export function steamStatus(userId: string): SteamConnectionStatus {
  const steamId = one<{ steam_id: string }>("SELECT steam_id FROM steam_connections WHERE user_id = ?", userId)?.steam_id;
  return {
    connection: steamId ? { steamId, profileUrl: `https://steamcommunity.com/profiles/${steamId}/` } : null,
    onlineActivityAvailable: !!config.steamApiKey,
  };
}
export function beginSteamLink(userId: string, token: string, origin: string): SteamLinkBegin {
  prune();
  if (pending.size >= 500) throw badRequest("Muitas conexões pendentes; tente novamente em alguns minutos.");
  // A new attempt supersedes earlier attempts from this account.
  for (const [state, item] of pending) if (item.userId === userId) pending.delete(state);
  const base = new URL(config.publicUrl || origin);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) throw badRequest("URL pública inválida.");
  const state = secret(), handoff = secret();
  const returnTo = `${base.origin}/api/auth/steam/callback?state=${state}`;
  pending.set(state, { userId, token, handoff, returnTo, expires: Date.now() + TTL, processing: false, result: { status: "pending" } });
  const query = new URLSearchParams({
    "openid.ns": NS,
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": `${base.origin}/`,
    "openid.identity": `${NS}/identifier_select`,
    "openid.claimed_id": `${NS}/identifier_select`,
  });
  return { url: `${ENDPOINT}?${query}`, handoff };
}
export function pollSteamLink(userId: string, handoff: string): SteamLinkPoll {
  prune();
  for (const [state, item] of pending) {
    if (item.userId !== userId || item.handoff !== handoff) continue;
    if (item.result.status !== "pending") pending.delete(state);
    return item.result;
  }
  return { status: "error", message: "Conexão expirada ou cancelada; tente novamente." };
}
const page = (success: boolean) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Steam · Annoy</title><body><h1>${success ? "Steam conectada" : "Conexão não concluída"}</h1><p>Pode fechar esta aba e voltar ao Annoy.</p></body></html>`;

/** Verify the assertion directly with Steam; never trust the ID in the browser query. */
export async function completeSteamLink(query: Record<string, string>): Promise<string> {
  prune();
  const item = pending.get(query.state ?? "");
  if (!item || item.processing || item.result.status !== "pending") return page(false);
  item.processing = true;
  try {
    if (query["openid.mode"] === "cancel") throw new Error("Conexão cancelada na Steam.");
    const identity = query["openid.claimed_id"] ?? "";
    const steamId = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(identity)?.[1];
    const signed = new Set(query["openid.signed"]?.split(","));
    const nonceAt = Date.parse((query["openid.response_nonce"] ?? "").slice(0, 20));
    if (query["openid.ns"] !== NS || query["openid.mode"] !== "id_res" ||
      query["openid.op_endpoint"] !== ENDPOINT || query["openid.return_to"] !== item.returnTo ||
      !steamId || query["openid.identity"] !== identity ||
      !["op_endpoint", "claimed_id", "identity", "return_to", "response_nonce"].every((key) => signed.has(key)) ||
      !Number.isFinite(nonceAt) || Math.abs(Date.now() - nonceAt) > 5 * 60_000) {
      throw new Error("A Steam retornou uma autorização inválida ou expirada.");
    }
    const body = new URLSearchParams(Object.entries(query).filter(([key]) => key.startsWith("openid.")));
    body.set("openid.mode", "check_authentication");
    const response = await fetch(ENDPOINT, { method: "POST", body, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok || !(await response.text()).split(/\r?\n/).includes("is_valid:true")) {
      throw new Error("Não foi possível confirmar a autorização com a Steam.");
    }
    // Logout, deletion, suspension, cancellation or replacement while Steam was open invalidates the attempt.
    if (userIdForToken(item.token) !== item.userId || pending.get(query.state!) !== item || item.expires < Date.now()) {
      throw new Error("A sessão do Annoy expirou; entre novamente para conectar a Steam.");
    }
    const owner = one<{ user_id: string }>("SELECT user_id FROM steam_connections WHERE steam_id = ?", steamId)?.user_id;
    if (owner && owner !== item.userId) throw new Error("Esta Steam já está conectada a outra conta nesta instância.");
    run("INSERT INTO steam_connections(user_id, steam_id, connected_at) VALUES(?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET steam_id=excluded.steam_id, connected_at=excluded.connected_at", item.userId, steamId, now());
    onlineCache.delete(item.userId);
    item.result = { status: "done", connection: steamStatus(item.userId).connection! };
    return page(true);
  } catch (error) {
    item.result = { status: "error", message: error instanceof Error && error.name !== "TimeoutError" ? error.message : "A Steam não respondeu. Tente novamente." };
    return page(false);
  }
}
export function disconnectSteam(userId: string) {
  for (const [state, item] of pending) if (item.userId === userId) pending.delete(state);
  run("DELETE FROM steam_connections WHERE user_id = ?", userId);
  onlineCache.delete(userId);
}

const onlineCache = new Map<string, { steamId: string; expires: number; result: Promise<UserActivity[]> }>();
/** On-demand only, while a client shares activity. No server-side background tracking. */
export async function steamOnlineActivity(userId: string): Promise<UserActivity[]> {
  const connection = steamStatus(userId).connection;
  if (!connection || !config.steamApiKey) return [];
  const cached = onlineCache.get(userId);
  if (cached?.steamId === connection.steamId && cached.expires > Date.now()) return cached.result;
  for (const [id, item] of onlineCache) if (item.expires < Date.now()) onlineCache.delete(id);
  const result = (async (): Promise<UserActivity[]> => {
    try {
      const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
      url.searchParams.set("key", config.steamApiKey);
      url.searchParams.set("steamids", connection.steamId);
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) return [];
      const data = await response.json() as { response?: { players?: { steamid?: string; gameid?: string; gameextrainfo?: string }[] } };
      const player = data.response?.players?.find((p) => p.steamid === connection.steamId);
      if (!player || !/^\d{1,10}$/.test(player.gameid ?? "") || typeof player.gameextrainfo !== "string" || !player.gameextrainfo.trim()) return [];
      // Disconnecting during the lookup must not return a stale connection's game.
      if (steamStatus(userId).connection?.steamId !== connection.steamId) return [];
      return [{ kind: "game", provider: "steam", appId: player.gameid!, name: player.gameextrainfo.trim().slice(0, 160) }];
    } catch { return []; }
  })();
  onlineCache.set(userId, { steamId: connection.steamId, expires: Date.now() + 25_000, result });
  return result;
}
