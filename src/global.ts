// Annoy Global, from a self-hosted server's side (see Annoy-api-global's
// DESIGN.md). The server asks Global for an ID once, keeps the blind-token
// public keys fresh, and checks global logins offline: Global is never told
// who logs in here.
import { constants, createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { config } from "./config.ts";
import { now, one, run } from "./db.ts";
import { HttpError } from "./errors.ts";

/** A blind-signing public key from /v1/tokens/keys (RSA JWK). */
interface PublishedKey {
  kid: string;
  n: string;
  e: string;
}

interface Sanction {
  countries: string[] | "*";
  reason: string;
  legalRef: string;
  since: string;
}

const setting = (key: string) => one<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", key)?.value ?? null;
const store = (key: string, value: string) =>
  run("INSERT INTO instance_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);

let keys: PublishedKey[] = [];
let sanctions: Sanction[] = [];

/** This server's Global ID, or null when Global is off or not reached yet. */
export const globalServerId = () => (config.global.enabled ? setting("global.serverId") : null);

/** Global accounts can log in: Global is on, registered, keys known, and the server isn't sanctioned everywhere. */
export function globalLoginAvailable(): boolean {
  return !!globalServerId() && keys.length > 0 && !sanctions.some((s) => s.countries === "*");
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(config.global.url + path, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Global ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The one registration request (item 1.3): Global keeps an ID and a secret's hash, nothing else. */
async function register(): Promise<void> {
  if (setting("global.serverId")) return;
  const res = await call<{ serverId: string; serverSecret: string }>("/v1/servers", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  store("global.serverId", res.serverId);
  store("global.serverSecret", res.serverSecret);
}

async function refresh(): Promise<void> {
  keys = (await call<{ keys: PublishedKey[] }>("/v1/tokens/keys")).keys;
  const id = setting("global.serverId");
  const secret = setting("global.serverSecret");
  if (id && secret) sanctions = (await call<{ sanctions: Sanction[] }>("/v1/servers/self", { headers: { authorization: `Server ${id}:${secret}` } })).sanctions;
}

/** Runs at startup when Global is on; failures only delay global logins, never the server. */
export function startGlobal(log: (msg: string) => void): void {
  if (!config.global.enabled) return log("Annoy Global: desligado (ANNOY_GLOBAL=off)");
  const tick = async () => {
    try {
      await register();
      await refresh();
    } catch (err) {
      log(`Annoy Global indisponível: ${(err as Error).message}`);
    }
  };
  void tick();
  setInterval(() => void tick(), 60 * 60_000).unref();
}

// --- Global login ---------------------------------------------------------------

const CHALLENGE_TTL_MS = 2 * 60_000;
const challenges = new Map<string, number>();

/** A one-time challenge the client signs with its per-server identity key. */
export function newChallenge(): string {
  const t = Date.now();
  for (const [c, at] of challenges) if (t - at > CHALLENGE_TTL_MS) challenges.delete(c);
  if (challenges.size > 10_000) throw new HttpError(429, "too_many_requests", "Tente de novo em instantes");
  const challenge = randomBytes(24).toString("base64url");
  challenges.set(challenge, t);
  return challenge;
}

export interface GlobalProof {
  /** The per-server identity: an Ed25519 public key (JWK "x"). */
  identity: string;
  challenge: string;
  /** Ed25519 signature over "annoy-login:<challenge>". */
  signature: string;
  /** Blind token from Global: kid, message and signature, base64url. */
  token: { kid: string; message: string; signature: string };
}

/**
 * Checks a global login and returns the identity. Proves two things without
 * asking Global: the client owns this identity (signature), and it belongs to
 * a valid, unsanctioned global account (blind token bound to this server and
 * identity). A token is accepted once.
 */
export function verifyGlobalProof(proof: GlobalProof): string {
  const serverId = globalServerId();
  if (!serverId || !globalLoginAvailable()) throw new HttpError(503, "global_unavailable", "Contas globais não estão disponíveis neste servidor");
  const issued = challenges.get(proof.challenge);
  challenges.delete(proof.challenge);
  if (!issued || Date.now() - issued > CHALLENGE_TTL_MS) throw new HttpError(401, "invalid_challenge", "Tente entrar de novo");
  if (!/^[A-Za-z0-9_-]{43}$/.test(proof.identity)) throw new HttpError(400, "invalid_identity", "Identidade global inválida");
  try {
    const identityKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: proof.identity }, format: "jwk" });
    if (!verify(null, Buffer.from(`annoy-login:${proof.challenge}`), identityKey, Buffer.from(proof.signature, "base64url"))) throw new Error();
  } catch {
    throw new HttpError(401, "invalid_signature", "Não foi possível confirmar a conta global");
  }
  const jwk = keys.find((k) => k.kid === proof.token.kid);
  const message = Buffer.from(proof.token.message, "base64url");
  const validToken =
    !!jwk &&
    message.subarray(32).toString("utf8") === `annoy-token/v1|${serverId}|${proof.identity}` &&
    verify(
      "sha384",
      message,
      { key: createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 },
      Buffer.from(proof.token.signature, "base64url"),
    );
  if (!validToken) throw new HttpError(401, "invalid_token", "A credencial da conta global não vale para este servidor");
  // Replays: a token's message is random, so its hash marks it as spent.
  const spent = createHash("sha256").update(message).digest("base64url");
  if (one("SELECT 1 FROM global_spent_tokens WHERE hash = ?", spent)) throw new HttpError(401, "token_reused", "Credencial já usada");
  run("INSERT INTO global_spent_tokens (hash, kid, spent_at) VALUES (?, ?, ?)", spent, proof.token.kid, now());
  run("DELETE FROM global_spent_tokens WHERE kid NOT IN (" + keys.map(() => "?").join(",") + ")", ...keys.map((k) => k.kid));
  return proof.identity;
}
