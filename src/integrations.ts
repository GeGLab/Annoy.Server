import {
  cleanSettings, findTrigger, has, imageKind, INTEGRATION_LIMITS, IntegrationError, isCallable, missingSettings, parseStoreIntegration, Permission, runIntegration,
  type Channel, type IntegrationFile, type IntegrationHistoryItem, type IntegrationHttp, type IntegrationSettings, type IntegrationSignature, type Message, type ServerIntegration, type StoreIntegration,
} from "@annoy/protocol";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { config } from "./config.ts";
import { all, now, one, run, tx } from "./db.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { sendToChannel, sendToServer } from "./events.ts";
import { newId, secretId } from "./ids.ts";
import { getMessage, getMessages, getUser } from "./repo.ts";
import { discardBlobs, readBlob, writeBlob } from "./uploads.ts";

/**
 * Store integrations installed on a server. The owner installs one and gives
 * the API key; members with USE_INTEGRATIONS call it with "/command" or
 * "@Name" in a channel. The call leaves this annoy-server (contract v1 in
 * @annoy/protocol): no developer code runs here, and the key never goes to
 * a client.
 */
interface Row {
  server_id: string;
  integration_id: string;
  manifest: string;
  api_key: string | null;
  settings: string;
  installed_at: string;
  refreshed_at: number;
}

/** Messages of the conversation sent along when the integration reads history and sets no size of its own. */
const DEFAULT_HISTORY = 20;
const REFRESH_MS = 60 * 60_000;
const CALLS_PER_MINUTE = 20;

// --- Transport: public HTTPS only -------------------------------------------------------

// Keep address families separate: an IPv4-mapped IPv6 subnet also matches
// native IPv4 addresses in Node BlockList.
const blockedIPv4 = new BlockList();
const blockedIPv6 = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) blockedIPv4.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["::ffff:0:0", 96]] as const) blockedIPv6.addSubnet(net, bits, "ipv6");

async function assertPublicHost(hostname: string): Promise<void> {
  if (isIP(hostname)) throw new Error("ip literal");
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((a) => (a.family === 6 ? blockedIPv6.check(a.address, "ipv6") : blockedIPv4.check(a.address, "ipv4")))) throw new Error("not a public address");
}

/** Tests replace it; production calls go through `publicHttp`. */
export const transport: { http: IntegrationHttp } = {
  http: async (request) => {
    const url = new URL(request.url);
    if (url.protocol !== "https:") throw new Error("https only");
    await assertPublicHost(url.hostname);
    const res = await fetch(url, { method: request.method, headers: request.headers, body: request.body, redirect: "error", signal: AbortSignal.timeout(request.timeoutMs) });
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > request.maxBytes) throw new Error("too large");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += (chunk as Uint8Array).length;
      if (size > request.maxBytes) throw new Error("too large");
      chunks.push(chunk as Uint8Array);
    }
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks) };
  },
};

// --- devannoy: signing, results and registered installs -------------------------------------

/** This server's Global credential, which devannoy checks on the Global. */
function serverAuth(): string | null {
  const setting = (key: string) => one<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", key)?.value ?? null;
  const id = setting("global.serverId"), secret = setting("global.serverSecret");
  return id && secret ? `Server ${id}:${secret}` : null;
}

async function devannoy(method: string, path: string, body?: unknown): Promise<Response | null> {
  const auth = serverAuth();
  if (!auth) return null;
  return fetch(`${config.storeUrl}${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { authorization: auth, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  }).catch(() => null);
}

export const devannoyCalls = {
  async sign(integration: string, bodySha256: string): Promise<IntegrationSignature | null> {
    const res = await devannoy("POST", "/v1/calls/sign", { integration, scope: "server", bodySha256 });
    if (!res?.ok) return null;
    const data = (await res.json()) as Partial<IntegrationSignature>;
    return typeof data.timestamp === "number" && typeof data.signature === "string" && typeof data.keyId === "string" ? { timestamp: data.timestamp, signature: data.signature, keyId: data.keyId } : null;
  },
  report(integration: string, ok: boolean): void {
    void devannoy("POST", "/v1/calls/result", { integration, scope: "server", ok }).then((res) => res?.body?.cancel());
  },
  installed(integration: string, on: boolean): void {
    void devannoy(on ? "PUT" : "DELETE", `/v1/servers/connections/${integration}`).then((res) => res?.body?.cancel());
  },
};

// --- Store ---------------------------------------------------------------------------------

export const integrationsEnabled = () => config.global.enabled;

async function fromStore(id: string): Promise<StoreIntegration> {
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(id)) throw notFound("Integração");
  let res: Response;
  try {
    res = await fetch(`${config.storeUrl}/v1/store/integrations/${id}`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new HttpError(502, "store_unavailable", "Não foi possível consultar a Loja. Tente de novo.");
  }
  if (res.status === 404) throw notFound("Integração");
  const integration = res.ok ? parseStoreIntegration(await res.json().catch(() => null)) : null;
  if (!integration) throw new HttpError(502, "store_unavailable", "Não foi possível consultar a Loja. Tente de novo.");
  return integration;
}

const rowsOf = (serverId: string) => all<Row>("SELECT * FROM server_integrations WHERE server_id = ? ORDER BY installed_at", serverId);
const manifestOf = (row: Row) => parseStoreIntegration(JSON.parse(row.manifest));

function toPublic(row: Row): ServerIntegration | null {
  const integration = manifestOf(row);
  return integration && { integration, settings: cleanSettings(integration, JSON.parse(row.settings)), hasKey: !!row.api_key, installedAt: row.installed_at };
}

export const listServerIntegrations = (serverId: string): ServerIntegration[] => rowsOf(serverId).flatMap((row) => toPublic(row) ?? []);

const announce = (serverId: string) => sendToServer(serverId, { t: "SERVER_INTEGRATIONS_UPDATE", d: { serverId } });

/** Installs or reconfigures. `apiKey` undefined keeps the saved key; null or "" removes it. */
export async function saveServerIntegration(serverId: string, id: string, userId: string, input: { apiKey?: string | null; settings?: unknown }): Promise<ServerIntegration[]> {
  if (!integrationsEnabled()) throw new HttpError(404, "not_found", "Integrações não estão disponíveis nesta instância");
  const integration = await fromStore(id);
  if (!isCallable(integration, "server")) throw badRequest("Esta integração não funciona em servidores");
  const current = one<Row>("SELECT * FROM server_integrations WHERE server_id = ? AND integration_id = ?", serverId, id);
  const apiKey = input.apiKey === undefined ? (current?.api_key ?? null) : input.apiKey?.trim() || null;
  if (integration.key.required && !apiKey) throw badRequest("Informe a chave API");
  const settings = cleanSettings(integration, input.settings ?? (current ? JSON.parse(current.settings) : {}));
  if (missingSettings(integration, settings).length) throw badRequest("Preencha as configurações obrigatórias");
  run(
    `INSERT INTO server_integrations (server_id, integration_id, manifest, api_key, settings, installed_by, installed_at, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (server_id, integration_id) DO UPDATE SET manifest = excluded.manifest, api_key = excluded.api_key, settings = excluded.settings, refreshed_at = excluded.refreshed_at`,
    serverId, id, JSON.stringify(integration), apiKey, JSON.stringify(settings), userId, now(), Date.now(),
  );
  if (!current) devannoyCalls.installed(id, true);
  announce(serverId);
  return listServerIntegrations(serverId);
}

export function removeServerIntegration(serverId: string, id: string): ServerIntegration[] {
  if (!run("DELETE FROM server_integrations WHERE server_id = ? AND integration_id = ?", serverId, id)) throw notFound("Integração");
  // devannoy counts this annoy-server once per integration: it is still installed if another server here has it.
  if (!one("SELECT 1 AS x FROM server_integrations WHERE integration_id = ?", id)) devannoyCalls.installed(id, false);
  announce(serverId);
  return listServerIntegrations(serverId);
}

/** The store copy of an installed integration is read again once an hour; removed from the store means removed here. */
async function refresh(row: Row): Promise<Row | null> {
  if (Date.now() - row.refreshed_at < REFRESH_MS) return row;
  try {
    const integration = await fromStore(row.integration_id);
    run("UPDATE server_integrations SET manifest = ?, refreshed_at = ? WHERE server_id = ? AND integration_id = ?", JSON.stringify(integration), Date.now(), row.server_id, row.integration_id);
    return { ...row, manifest: JSON.stringify(integration) };
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      run("DELETE FROM server_integrations WHERE server_id = ? AND integration_id = ?", row.server_id, row.integration_id);
      announce(row.server_id);
      return null;
    }
    // The store is unreachable: the saved copy still answers.
    run("UPDATE server_integrations SET refreshed_at = ? WHERE server_id = ? AND integration_id = ?", Date.now() - REFRESH_MS + 5 * 60_000, row.server_id, row.integration_id);
    return row;
  }
}

// --- Calls -----------------------------------------------------------------------------------

const calls = new Map<string, number[]>();
function allowCall(serverId: string): boolean {
  const since = Date.now() - 60_000;
  const recent = (calls.get(serverId) ?? []).filter((t) => t > since);
  if (recent.length >= CALLS_PER_MINUTE) return false;
  recent.push(Date.now());
  calls.set(serverId, recent);
  return true;
}

const ERRORS: Record<string, string> = {
  key_missing: "Esta integração está sem chave API. O dono do servidor precisa informar a chave.",
  settings_missing: "Esta integração está com a configuração incompleta.",
  unsupported: "Esta instância não oferece esta integração.",
  unreachable: "A integração não respondeu.",
  bad_response: "A integração respondeu algo que o Annoy não entende.",
  remote_error: "A integração respondeu com erro.",
  empty: "A integração não tinha o que responder.",
  rate_limited: "Muitas chamadas em pouco tempo. Tente de novo em um minuto.",
};

async function readAttachment(id: string, size: number): Promise<Uint8Array | null> {
  if (size > INTEGRATION_LIMITS.attachmentBytes) return null;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of readBlob(id)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

async function post(channel: Channel, calling: Message, integration: StoreIntegration, text: string, images: IntegrationFile[]): Promise<void> {
  const id = newId();
  const staged: { id: string; filename: string; size: number; contentType: string }[] = [];
  try {
    for (const image of images) {
      const file = { id: secretId(), filename: image.name, size: 0, contentType: image.type };
      staged.push(file);
      file.size = await writeBlob(file.id, Readable.from(Buffer.from(image.data)));
    }
    tx(() => {
      // The channel or the calling message may be gone by the time the answer arrives.
      if (!one("SELECT 1 AS x FROM messages WHERE id = ? AND channel_id = ?", calling.id, channel.id)) throw notFound("Mensagem");
      run(
        "INSERT INTO messages (id, channel_id, author_id, content, created_at, reply_to_id, mention_ids, mentions_everyone, integration) VALUES (?, ?, ?, ?, ?, ?, '[]', 0, ?)",
        id, channel.id, calling.author.id, text, now(), calling.id, JSON.stringify({ id: integration.id, name: integration.name, iconUrl: integration.icon }),
      );
      for (const f of staged) run("INSERT INTO attachments (id, message_id, filename, size, content_type) VALUES (?, ?, ?, ?, ?)", f.id, id, f.filename, f.size, f.contentType);
    });
  } catch {
    await discardBlobs(staged.map((f) => f.id));
    return;
  }
  sendToChannel(channel, { t: "MESSAGE_CREATE", d: getMessage(id)! });
}

/** Called after a message is stored: runs the integration it calls, if any, and posts the answer. Never throws. */
export async function runMessageIntegration(channel: Channel, message: Message, perms: number): Promise<void> {
  try {
    if (!integrationsEnabled() || !channel.serverId || message.integration || !message.content.startsWith("/") && !message.content.includes("@")) return;
    if (!has(perms, Permission.USE_INTEGRATIONS)) return;
    const installed = rowsOf(channel.serverId).flatMap((row) => {
      const integration = manifestOf(row);
      return integration && isCallable(integration, "server") ? [{ row, integration }] : [];
    });
    const first = findTrigger(message.content, installed.map((i) => i.integration));
    if (!first) return;
    const fresh = await refresh(installed.find((i) => i.integration.id === first.integration.id)!.row);
    const integration = fresh && manifestOf(fresh);
    const trigger = integration && findTrigger(message.content, [integration]);
    if (!fresh || !integration || !trigger || !isCallable(integration, "server")) return;
    if (!allowCall(channel.serverId)) return void (await post(channel, message, integration, ERRORS.rate_limited!, []));
    const settings: IntegrationSettings = cleanSettings(integration, JSON.parse(fresh.settings));
    const count = integration.access.history ? Math.min(INTEGRATION_LIMITS.history, typeof settings.history === "number" ? settings.history : DEFAULT_HISTORY) : 0;
    const history: IntegrationHistoryItem[] = count
      ? getMessages(channel.id, message.id, count).filter((m) => m.content).map((m) => ({ author: m.integration?.name ?? m.author.displayName, text: m.content, at: m.createdAt, ...(m.integration?.id === integration.id && { self: true }) }))
      : [];
    const attachments: IntegrationFile[] = [];
    if (integration.access.attachments) {
      for (const a of message.attachments.slice(0, INTEGRATION_LIMITS.attachments)) {
        const data = await readAttachment(a.id, a.size);
        if (data && imageKind(data)) attachments.push({ name: a.filename, type: imageKind(data)!.type, data });
      }
    }
    try {
      const output = await runIntegration(transport.http, {
        trigger, scope: "server", locale: "pt-BR", invoker: getUser(message.author.id)?.displayName ?? message.author.displayName, history, attachments, settings, apiKey: fresh.api_key,
        sign: devannoyCalls.sign, report: devannoyCalls.report,
      });
      await post(channel, message, integration, output.text, output.images);
    } catch (err) {
      const error = err instanceof IntegrationError ? err : new IntegrationError("bad_response");
      await post(channel, message, integration, error.detail ?? ERRORS[error.code] ?? ERRORS.bad_response!, []);
    }
  } catch (err) {
    console.error("integration call failed", (err as Error).message);
  }
}
