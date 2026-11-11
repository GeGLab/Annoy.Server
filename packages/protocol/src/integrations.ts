// Integrations (store contract v1, documented at devannoy.geg.dev.br/docs).
// The same code runs in the app (DMs: the call leaves the device of whoever
// added the integration) and in annoy-server (servers: the call leaves the
// server). Neither runs developer code: an integration is an HTTPS endpoint,
// or one of the built-in runtimes that belong to Annoy.

export interface IntegrationCommand {
  name: string;
  description: string;
  usage: string;
}
export interface IntegrationSetting {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  required: boolean;
  options?: string[];
  min?: number;
  max?: number;
}
export type IntegrationRuntime = { type: "http"; endpoint: string } | { type: "builtin"; name: string } | { type: "none" };

/** An integration as the store lists it (GET /v1/store/integrations). */
export interface StoreIntegration {
  id: string;
  name: string;
  summary: string;
  description: string;
  website: string | null;
  privacyUrl: string | null;
  icon: string | null;
  developer: { id: string; name: string };
  verified: boolean;
  firstParty: boolean;
  scopes: ("dm" | "server")[];
  key: { required: boolean; label?: string; helpUrl?: string };
  runtime: IntegrationRuntime;
  commands: IntegrationCommand[];
  mention: boolean;
  access: { history: boolean; attachments: boolean };
  settings: IntegrationSetting[];
  profile?: { connection: "steam"; image: string; link?: string };
  updatedAt: string;
}

export type IntegrationSettings = Record<string, string | number>;

export interface IntegrationFile {
  name: string;
  type: string;
  data: Uint8Array;
}
export interface IntegrationHistoryItem {
  author: string;
  text: string;
  at: string;
  /** Written by this integration itself. */
  self?: boolean;
}
export interface IntegrationTrigger {
  integration: StoreIntegration;
  type: "command" | "mention";
  command?: string;
  text: string;
}
export interface IntegrationInput {
  trigger: IntegrationTrigger;
  scope: "dm" | "server";
  locale: string;
  invoker: string;
  history: IntegrationHistoryItem[];
  attachments: IntegrationFile[];
  settings: IntegrationSettings;
  apiKey: string | null;
}
export interface IntegrationOutput {
  text: string;
  images: IntegrationFile[];
}

export interface IntegrationHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  maxBytes: number;
  timeoutMs: number;
}
/** The transport of the host (app main process, annoy-server). It must refuse redirects and non-public addresses. */
export type IntegrationHttp = (request: IntegrationHttpRequest) => Promise<{ status: number; type: string; body: Uint8Array }>;

export type IntegrationErrorCode = "key_missing" | "settings_missing" | "unsupported" | "unreachable" | "bad_response" | "remote_error" | "empty";
export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  /** Text given by the integration itself, shown as it came. */
  readonly detail: string | null;
  constructor(code: IntegrationErrorCode, detail: string | null = null) {
    super(detail ?? code);
    this.code = code;
    this.detail = detail;
  }
}

export const INTEGRATION_LIMITS = {
  text: 4000,
  images: 4,
  imageBytes: 8 * 1024 * 1024,
  attachments: 4,
  attachmentBytes: 4 * 1024 * 1024,
  responseBytes: 40 * 1024 * 1024,
  history: 100,
  timeoutMs: 30_000,
  /** Image generation is slower than a text answer. */
  slowTimeoutMs: 180_000,
} as const;

const IMAGE_MAGIC: [string, string, (b: Uint8Array) => boolean][] = [
  ["image/png", "png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/jpeg", "jpg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", "gif", (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38],
  ["image/webp", "webp", (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50],
];
/** The image type by its first bytes; what the sender says the type is does not count. */
export function imageKind(data: Uint8Array): { type: string; ext: string } | null {
  const found = IMAGE_MAGIC.find(([, , test]) => test(data));
  return found ? { type: found[0], ext: found[1] } : null;
}

export function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** HTTPS on the default port to a public name: what an integration endpoint or image link must be. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  return host.includes(".") && !/^[\d.]+$/.test(host) && !host.startsWith("[") && !/(^|\.)(localhost|local|internal|lan|home|test|invalid|onion)$/.test(host);
}

const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length <= max ? value : null);

/** Reads a store entry defensively: the catalog is remote data. Null when it isn't a usable integration. */
export function parseStoreIntegration(raw: unknown): StoreIntegration | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const id = text(r.id, 32), name = text(r.name, 32), summary = text(r.summary, 140);
  if (!id || !/^[a-z][a-z0-9-]{2,31}$/.test(id) || !name || summary === null) return null;
  const rt = r.runtime ?? {};
  let runtime: IntegrationRuntime;
  if (rt.type === "http" && typeof rt.endpoint === "string" && isPublicHttpsUrl(rt.endpoint)) runtime = { type: "http", endpoint: rt.endpoint };
  else if (rt.type === "builtin" && typeof rt.name === "string" && r.firstParty === true) runtime = { type: "builtin", name: rt.name };
  else if (rt.type === "none") runtime = { type: "none" };
  else return null;
  const commands: IntegrationCommand[] = [];
  for (const c of Array.isArray(r.commands) ? r.commands.slice(0, 10) : []) {
    if (typeof c?.name === "string" && /^[a-z][a-z0-9-]{1,31}$/.test(c.name)) commands.push({ name: c.name, description: text(c.description, 100) ?? "", usage: text(c.usage, 100) ?? "" });
  }
  const settings: IntegrationSetting[] = [];
  for (const s of Array.isArray(r.settings) ? r.settings.slice(0, 10) : []) {
    if (typeof s?.key !== "string" || !/^[a-z][a-zA-Z0-9_]{0,31}$/.test(s.key) || !["text", "number", "select"].includes(s.type)) continue;
    settings.push({
      key: s.key,
      label: text(s.label, 60) ?? s.key,
      type: s.type,
      required: s.required === true,
      ...(s.type === "select" && { options: (Array.isArray(s.options) ? s.options : []).filter((o: unknown): o is string => typeof o === "string").slice(0, 30) }),
      ...(Number.isInteger(s.min) && { min: s.min }),
      ...(Number.isInteger(s.max) && { max: s.max }),
    });
  }
  const link = (value: unknown) => (typeof value === "string" && isPublicHttpsUrl(value) ? value : null);
  const template = (value: unknown) => (typeof value === "string" && value.includes("{id}") && isPublicHttpsUrl(value.replaceAll("{id}", "0")) ? value : null);
  const image = r.profile?.connection === "steam" ? template(r.profile.image) : null;
  return {
    id,
    name,
    summary,
    description: text(r.description, 2000) ?? "",
    website: link(r.website),
    privacyUrl: link(r.privacyUrl),
    icon: typeof r.icon === "string" && /^https?:\/\//.test(r.icon) ? r.icon : null,
    developer: { id: text(r.developer?.id, 32) ?? "", name: text(r.developer?.name, 40) ?? "" },
    verified: r.verified === true,
    firstParty: r.firstParty === true,
    scopes: (Array.isArray(r.scopes) ? r.scopes : []).filter((s: unknown): s is "dm" | "server" => s === "dm" || s === "server"),
    key: { required: r.key?.required === true, ...(text(r.key?.label, 60) && { label: r.key.label }), ...(link(r.key?.helpUrl) && { helpUrl: r.key.helpUrl }) },
    runtime,
    commands,
    mention: r.mention === true,
    access: { history: r.access?.history === true, attachments: r.access?.attachments === true },
    settings,
    ...(image && { profile: { connection: "steam" as const, image, ...(template(r.profile.link) && { link: r.profile.link }) } }),
    updatedAt: text(r.updatedAt, 40) ?? "",
  };
}

/** Whether the integration can be called in a conversation at all. */
export const isCallable = (integration: StoreIntegration, scope: "dm" | "server") =>
  integration.scopes.includes(scope) && integration.runtime.type !== "none" && (integration.commands.length > 0 || integration.mention);

/** Required settings without a value, by key. */
export function missingSettings(integration: StoreIntegration, settings: IntegrationSettings): string[] {
  return integration.settings.filter((s) => s.required && (settings[s.key] === undefined || settings[s.key] === "")).map((s) => s.key);
}

/** Keeps only declared settings with values of the declared kind. */
export function cleanSettings(integration: StoreIntegration, input: unknown): IntegrationSettings {
  const out: IntegrationSettings = {};
  const values = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const s of integration.settings) {
    const v = values[s.key];
    if (s.type === "number") {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (Number.isInteger(n) && (s.min === undefined || n >= s.min) && (s.max === undefined || n <= s.max)) out[s.key] = n;
    } else if (typeof v === "string" && v.trim() && v.length <= 200 && (s.type !== "select" || s.options?.includes(v))) out[s.key] = v.trim();
  }
  return out;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a message calls, if anything: "/command …" at the start, or "@Name" anywhere. First match wins. */
export function findTrigger(content: string, integrations: StoreIntegration[]): IntegrationTrigger | null {
  const message = content.trim();
  const command = /^\/([a-z][a-z0-9-]{1,31})(?:\s+([\s\S]*))?$/.exec(message);
  if (command) {
    for (const integration of integrations) {
      if (integration.commands.some((c) => c.name === command[1])) return { integration, type: "command", command: command[1]!, text: (command[2] ?? "").trim() };
    }
    return null;
  }
  for (const integration of integrations) {
    if (!integration.mention) continue;
    const mention = new RegExp(`(^|\\s)@${escapeRegExp(integration.name)}(?![\\p{L}\\p{N}_])`, "iu");
    if (mention.test(message)) return { integration, type: "mention", text: message.replace(mention, "$1").replace(/\s{2,}/g, " ").trim() };
  }
  return null;
}

const utf8 = new TextDecoder();
function json(body: Uint8Array): Record<string, any> | null {
  try {
    const value: unknown = JSON.parse(utf8.decode(body));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
  } catch {
    return null;
  }
}
const send = async (http: IntegrationHttp, request: IntegrationHttpRequest) => {
  try {
    return await http(request);
  } catch {
    throw new IntegrationError("unreachable");
  }
};
const remoteMessage = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null);

async function fetchImage(http: IntegrationHttp, url: string, index: number): Promise<IntegrationFile> {
  if (!isPublicHttpsUrl(url)) throw new IntegrationError("bad_response");
  const res = await send(http, { url, method: "GET", headers: {}, maxBytes: INTEGRATION_LIMITS.imageBytes, timeoutMs: INTEGRATION_LIMITS.timeoutMs });
  const kind = res.status === 200 ? imageKind(res.body) : null;
  if (!kind) throw new IntegrationError("bad_response");
  return { name: `image-${index + 1}.${kind.ext}`, type: kind.type, data: res.body };
}

function inlineImage(data: Uint8Array, name: unknown, index: number): IntegrationFile {
  const kind = imageKind(data);
  if (!kind || data.length > INTEGRATION_LIMITS.imageBytes) throw new IntegrationError("bad_response");
  const base = typeof name === "string" ? name.replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\.[^.]*$/, "").replace(/^[.\s]+/, "").slice(0, 60) : "";
  return { name: `${base || `image-${index + 1}`}.${kind.ext}`, type: kind.type, data };
}

async function runHttp(http: IntegrationHttp, input: IntegrationInput, endpoint: string): Promise<IntegrationOutput> {
  const { trigger } = input;
  const body = {
    v: 1,
    type: trigger.type,
    ...(trigger.command && { command: trigger.command }),
    text: trigger.text,
    scope: input.scope,
    locale: input.locale,
    invoker: { name: input.invoker },
    settings: input.settings,
    ...(trigger.integration.access.history && { history: input.history.map((h) => ({ author: { name: h.author, ...(h.self && { self: true }) }, text: h.text, at: h.at })) }),
    ...(trigger.integration.access.attachments && { attachments: input.attachments.map((a) => ({ name: a.name, type: a.type, size: a.data.length, data: toBase64(a.data) })) }),
  };
  const res = await send(http, {
    url: endpoint,
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Annoy-Integrations/1", "x-annoy-integration": trigger.integration.id, ...(input.apiKey && { authorization: `Bearer ${input.apiKey}` }) },
    body: JSON.stringify(body),
    maxBytes: INTEGRATION_LIMITS.responseBytes,
    timeoutMs: INTEGRATION_LIMITS.timeoutMs,
  });
  const data = json(res.body);
  if (res.status < 200 || res.status >= 300) throw new IntegrationError("remote_error", remoteMessage(data?.error));
  if (!data) throw new IntegrationError("bad_response");
  const images: IntegrationFile[] = [];
  for (const [i, image] of (Array.isArray(data.images) ? data.images.slice(0, INTEGRATION_LIMITS.images) : []).entries()) {
    if (typeof image?.url === "string") images.push(await fetchImage(http, image.url, i));
    else if (typeof image?.data === "string") {
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(image.data);
      } catch {
        throw new IntegrationError("bad_response");
      }
      images.push(inlineImage(bytes, image.name, i));
    } else throw new IntegrationError("bad_response");
  }
  const reply = typeof data.text === "string" ? data.text.trim().slice(0, INTEGRATION_LIMITS.text) : "";
  if (!reply && !images.length) throw new IntegrationError("empty");
  return { text: reply, images };
}

// --- Built-in: OpenAI ------------------------------------------------------------------

const OPENAI = "https://api.openai.com/v1";

async function openai(http: IntegrationHttp, key: string, path: string, body: unknown, slow = false): Promise<Record<string, any>> {
  const res = await send(http, {
    url: OPENAI + path,
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    maxBytes: INTEGRATION_LIMITS.responseBytes,
    timeoutMs: slow ? INTEGRATION_LIMITS.slowTimeoutMs : INTEGRATION_LIMITS.timeoutMs * 3,
  });
  const data = json(res.body);
  if (res.status < 200 || res.status >= 300) throw new IntegrationError("remote_error", remoteMessage(data?.error?.message));
  if (!data) throw new IntegrationError("bad_response");
  return data;
}

/** Model IDs the key can use, for the settings form. */
export async function openaiModels(http: IntegrationHttp, key: string): Promise<string[]> {
  const data = await openai(http, key, "/models", undefined);
  return (Array.isArray(data.data) ? data.data : []).map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === "string").sort();
}

async function runOpenai(http: IntegrationHttp, input: IntegrationInput): Promise<IntegrationOutput> {
  const { trigger, settings } = input;
  const key = input.apiKey!;
  if (trigger.command === "imagine") {
    if (!trigger.text) throw new IntegrationError("empty");
    const data = await openai(http, key, "/images/generations", { model: String(settings.imageModel), prompt: trigger.text, n: 1 }, true);
    const first = Array.isArray(data.data) ? data.data[0] : null;
    if (typeof first?.b64_json === "string") return { text: "", images: [inlineImage(fromBase64(first.b64_json), null, 0)] };
    if (typeof first?.url === "string") return { text: "", images: [await fetchImage(http, first.url, 0)] };
    throw new IntegrationError("bad_response");
  }
  const count = Math.max(0, Math.min(INTEGRATION_LIMITS.history, Number(settings.history) || 0));
  const history = count ? input.history.slice(-count) : [];
  const images = input.attachments.filter((a) => imageKind(a.data));
  const question = `${input.invoker}: ${trigger.text}`;
  const data = await openai(http, key, "/chat/completions", {
    model: String(settings.model),
    messages: [
      { role: "system", content: `You are ${trigger.integration.name}, taking part in a chat conversation in the Annoy app. Every message from a person starts with that person's name and a colon. Reply in the language of the last message.` },
      ...history.map((h) => (h.self ? { role: "assistant", content: h.text } : { role: "user", content: `${h.author}: ${h.text}` })),
      { role: "user", content: images.length ? [{ type: "text", text: question }, ...images.map((a) => ({ type: "image_url", image_url: { url: `data:${imageKind(a.data)!.type};base64,${toBase64(a.data)}` } }))] : question },
    ],
  });
  const reply = data.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || !reply.trim()) throw new IntegrationError("empty");
  return { text: reply.trim().slice(0, INTEGRATION_LIMITS.text), images: [] };
}

/** Runs one call. Throws IntegrationError; nothing else leaves it. */
export async function runIntegration(http: IntegrationHttp, input: IntegrationInput): Promise<IntegrationOutput> {
  const { integration } = input.trigger;
  if (integration.key.required && !input.apiKey) throw new IntegrationError("key_missing");
  if (missingSettings(integration, input.settings).length) throw new IntegrationError("settings_missing");
  const bounded: IntegrationInput = {
    ...input,
    history: integration.access.history ? input.history.slice(-INTEGRATION_LIMITS.history) : [],
    attachments: integration.access.attachments ? input.attachments.filter((a) => imageKind(a.data) && a.data.length <= INTEGRATION_LIMITS.attachmentBytes).slice(0, INTEGRATION_LIMITS.attachments) : [],
  };
  try {
    if (integration.runtime.type === "http") return await runHttp(http, bounded, integration.runtime.endpoint);
    if (integration.runtime.type === "builtin" && integration.runtime.name === "openai") return await runOpenai(http, bounded);
    throw new IntegrationError("unsupported");
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    throw new IntegrationError("bad_response");
  }
}
