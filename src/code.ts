import { Permission, type Channel, type CodeEntry, type CodeFile, type CodeRepo, type CodeStatus } from "@distopic/protocol";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, posix, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.ts";
import { config } from "./config.ts";
import { now, one, run } from "./db.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { sendToChannel } from "./events.ts";
import { requireChannel } from "./perms.ts";
import { getChannel, getUsers } from "./repo.ts";
import { parse, type Params } from "./validate.ts";

// A code channel is a working copy of an external Git repository kept on this server.
// Git only ever talks to the linked https remote; tokens for private repos are used for
// one command and never written anywhere.

const codeDir = join(config.dataDir, "code");
const repoDir = (channelId: string) => join(codeDir, channelId, "repo");
const FILE_MAX = 2 * 1024 * 1024;
const TREE_MAX = 20_000;

interface Live {
  status: CodeRepo["status"];
  error: string | null;
}
const live = new Map<string, Live>();
const queues = new Map<string, Promise<unknown>>();

/** Runs Git operations of one channel one after another. */
function serial<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(channelId) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(channelId, next);
  return next;
}

class GitError extends Error {}

function git(cwd: string, args: string[], opts: { token?: string; timeout?: number } = {}): Promise<string> {
  const config: [string, string][] = [
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["http.followRedirects", "false"],
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["credential.helper", ""],
    ["submodule.recurse", "false"],
  ];
  // GitHub, GitLab and Gitea all accept a token as the Basic password.
  if (opts.token) config.push(["http.extraHeader", `Authorization: Basic ${Buffer.from(`x-access-token:${opts.token}`).toString("base64")}`]);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(codeDir, ".home"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    LANG: "C",
    // Config through the environment keeps the token out of argv and off the disk.
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env, timeout: opts.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const message = String(stderr || err.message)
        .replace(/Authorization: Basic \S+/g, "Authorization: ***")
        .trim()
        .split("\n")
        .filter((l) => !/^hint:/.test(l))
        .slice(-4)
        .join("\n");
      reject(new GitError(message || "Falha no Git"));
    });
  });
}

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^(22[4-9]|2[3-5]\d)\./];
const isPrivate = (address: string) =>
  isIP(address) === 4
    ? PRIVATE_V4.some((r) => r.test(address))
    : /^(::1?$|f[cd]|fe[89ab]|::ffff:(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168)\.)/i.test(address);

/** Only public https remotes: never this server, its LAN or a file path. */
async function checkRemote(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest("Link do repositório inválido");
  }
  if (url.protocol !== "https:") throw badRequest("Use o link https do repositório (ex.: https://github.com/dono/projeto)");
  if (url.username || url.password) throw badRequest("Não coloque usuário ou token no link; informe o token no campo próprio");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw badRequest("Não foi possível encontrar esse endereço");
  if (addresses.some(isPrivate)) throw badRequest("Só repositórios externos são permitidos");
  url.hash = "";
  url.search = "";
  return url.toString();
}

/** Normalizes a path inside the working copy; `.git` is never reachable. */
function cleanPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw badRequest("Caminho inválido");
  const path = posix.normalize(raw.replace(/\\/g, "/").replace(/^\/+/, ""));
  if (path === "." || path.startsWith("../") || path === ".." || path.split("/").some((part) => part === ".git" || part === "")) {
    throw badRequest("Caminho inválido");
  }
  return path;
}

/** Resolves `path` and refuses anything a symlink would take outside the working copy. */
async function inside(channelId: string, path: string, { mustExist }: { mustExist: boolean }): Promise<string> {
  const root = await realpath(repoDir(channelId));
  const full = join(root, ...path.split("/"));
  let probe = full;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== root && !real.startsWith(root + sep)) throw badRequest("Caminho fora do repositório");
      if (probe === full && (await lstat(full)).isSymbolicLink()) throw badRequest("Links simbólicos não podem ser abertos");
      return full;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (mustExist || probe === root) throw notFound("Arquivo");
      probe = dirname(probe);
    }
  }
}

const hashOf = (data: Buffer | string) => createHash("sha1").update(data).digest("hex");

function linkedUrl(channelId: string): string | null {
  return one<{ url: string }>("SELECT url FROM code_repos WHERE channel_id = ?", channelId)?.url ?? null;
}

async function repoInfo(channelId: string): Promise<CodeRepo> {
  const url = linkedUrl(channelId);
  let state = live.get(channelId);
  // A clone cut short by a restart leaves no working copy behind.
  if (url && !state && !existsSync(join(repoDir(channelId), ".git"))) {
    state = { status: "error", error: "O clone foi interrompido. Vincule o repositório de novo." };
    live.set(channelId, state);
  }
  const base: CodeRepo = { channelId, url, status: url ? (state?.status ?? "ready") : "empty", error: state?.error ?? null, branch: null, head: null };
  if (base.status !== "ready") return base;
  try {
    base.branch = (await git(repoDir(channelId), ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || null;
    base.head = (await git(repoDir(channelId), ["rev-parse", "--short", "HEAD"])).trim() || null;
  } catch {
    // Empty repository: no commit yet.
  }
  return base;
}

async function announce(channel: Channel, paths: string[], by: string | null): Promise<void> {
  sendToChannel(channel, { t: "CODE_UPDATE", d: { channelId: channel.id, repo: await repoInfo(channel.id), paths, by } });
}

export async function removeWorkspace(channelId: string): Promise<void> {
  live.delete(channelId);
  await serial(channelId, () => rm(join(codeDir, channelId), { recursive: true, force: true }));
  queues.delete(channelId);
}

async function walk(channelId: string): Promise<CodeEntry[]> {
  const root = repoDir(channelId);
  const out: CodeEntry[] = [];
  const visit = async (dir: string, prefix: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= TREE_MAX) return;
      if (entry.name === ".git") continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ path, type: "dir", size: 0 });
        await visit(join(dir, entry.name), path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const size = entry.isFile() ? (await lstat(join(dir, entry.name)).catch(() => null))?.size ?? 0 : 0;
        out.push({ path, type: "file", size });
      }
    }
  };
  await visit(root, "");
  return out;
}

function requireReady(channelId: string): void {
  if (!linkedUrl(channelId)) throw badRequest("Nenhum repositório vinculado a este canal");
  const state = live.get(channelId);
  if (state && state.status !== "ready") throw badRequest(state.status === "cloning" ? "O repositório ainda está sendo clonado" : (state.error ?? "Repositório indisponível"));
}

function requireCode(channelId: string, userId: string, flag = 0) {
  const found = requireChannel(channelId, userId, flag);
  if (found.channel.type !== "code") throw notFound("Canal de código");
  return found;
}

const linkBody = z.object({ url: z.string().min(1).max(2048), token: z.string().max(512).optional() });
const tokenBody = z.object({ token: z.string().max(512).optional() });
const fileBody = z.object({ path: z.string().max(1024), content: z.string().max(FILE_MAX), baseHash: z.string().nullable().optional() });
const renameBody = z.object({ from: z.string().max(1024), to: z.string().max(1024) });
const commitBody = z.object({ message: z.string().trim().min(1).max(5000), email: z.string().trim().email().max(200).optional() });
const checkoutBody = z.object({ branch: z.string().trim().min(1).max(200).regex(/^(?!-)[\w./-]+$/), create: z.boolean().optional() });
const pathQuery = z.object({ path: z.string().max(1024) });

/** Answers Git failures as 400s with Git's own words, never as a 500. */
async function gitStep<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GitError) throw new HttpError(400, "git", err.message);
    throw err;
  }
}

export function codeRoutes(app: FastifyInstance): void {
  app.get<Params<"id">>("/channels/:id/code", async (req) => {
    const { channel } = requireCode(req.params.id, requireUser(req));
    return repoInfo(channel.id);
  });

  app.put<Params<"id">>("/channels/:id/code", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireCode(req.params.id, userId, Permission.MANAGE_CHANNELS);
    const body = parse(linkBody, req.body);
    const url = await checkRemote(body.url);
    if (live.get(channel.id)?.status === "cloning") throw badRequest("Já existe um clone em andamento");
    live.set(channel.id, { status: "cloning", error: null });
    run("INSERT OR REPLACE INTO code_repos (channel_id, url, linked_by, linked_at) VALUES (?, ?, ?, ?)", channel.id, url, userId, now());
    void serial(channel.id, async () => {
      await rm(join(codeDir, channel.id), { recursive: true, force: true });
      await mkdir(join(codeDir, channel.id), { recursive: true });
      await mkdir(join(codeDir, ".home"), { recursive: true });
      try {
        await git(join(codeDir, channel.id), ["clone", "--no-recurse-submodules", "--", url, "repo"], { token: body.token, timeout: 10 * 60_000 });
        live.set(channel.id, { status: "ready", error: null });
      } catch (err) {
        live.set(channel.id, { status: "error", error: err instanceof Error ? err.message : "Falha ao clonar" });
      }
      const fresh = getChannel(channel.id);
      if (fresh) await announce(fresh, [], userId);
    });
    await announce(channel, [], userId);
    return repoInfo(channel.id);
  });

  app.delete<Params<"id">>("/channels/:id/code", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireCode(req.params.id, userId, Permission.MANAGE_CHANNELS);
    run("DELETE FROM code_repos WHERE channel_id = ?", channel.id);
    await removeWorkspace(channel.id);
    await announce(channel, [], userId);
    return {};
  });

  app.get<Params<"id">>("/channels/:id/code/tree", async (req): Promise<CodeEntry[]> => {
    const { channel } = requireCode(req.params.id, requireUser(req));
    requireReady(channel.id);
    return walk(channel.id);
  });

  app.get<Params<"id">>("/channels/:id/code/file", async (req): Promise<CodeFile> => {
    const { channel } = requireCode(req.params.id, requireUser(req));
    requireReady(channel.id);
    const path = cleanPath(parse(pathQuery, req.query).path);
    const full = await inside(channel.id, path, { mustExist: true });
    const info = await lstat(full);
    if (!info.isFile()) throw notFound("Arquivo");
    if (info.size > FILE_MAX) return { path, content: "", hash: "", binary: true };
    const data = await readFile(full);
    const binary = data.subarray(0, 8000).includes(0);
    return { path, content: binary ? "" : data.toString("utf8"), hash: hashOf(data), binary };
  });

  app.put<Params<"id">>("/channels/:id/code/file", async (req): Promise<CodeFile> => {
    const userId = requireUser(req);
    const { channel } = requireCode(req.params.id, userId, Permission.SEND_MESSAGES);
    requireReady(channel.id);
    const body = parse(fileBody, req.body);
    const path = cleanPath(body.path);
    const result = await serial(channel.id, async () => {
      const full = await inside(channel.id, path, { mustExist: false });
      const current = await readFile(full).catch(() => null);
      // Someone else saved since this editor loaded the file: let the client merge.
      if (body.baseHash !== undefined && (current ? hashOf(current) : null) !== body.baseHash) {
        throw new HttpError(409, "conflict", "Outra pessoa salvou este arquivo enquanto você editava");
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, body.content);
      return { path, content: body.content, hash: hashOf(body.content), binary: false };
    });
    await announce(channel, [path], userId);
    return result;
  });

  app.delete<Params<"id">>("/channels/:id/code/file", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireCode(req.params.id, userId, Permission.SEND_MESSAGES);
    requireReady(channel.id);
    const path = cleanPath(parse(pathQuery, req.query).path);
    await serial(channel.id, async () => rm(await inside(channel.id, path, { mustExist: true }), { recursive: true, force: true }));
    await announce(channel, [path], userId);
    return {};
  });

  app.post<Params<"id">>("/channels/:id/code/rename", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireCode(req.params.id, userId, Permission.SEND_MESSAGES);
    requireReady(channel.id);
    const body = parse(renameBody, req.body);
    const from = cleanPath(body.from);
    const to = cleanPath(body.to);
    await serial(channel.id, async () => {
      const source = await inside(channel.id, from, { mustExist: true });
      const target = await inside(channel.id, to, { mustExist: false });
      if (await lstat(target).catch(() => null)) throw badRequest("Já existe um arquivo com esse nome");
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
    });
    await announce(channel, [from, to], userId);
    return {};
  });

  app.get<Params<"id">>("/channels/:id/code/status", async (req): Promise<CodeStatus> => {
    const { channel } = requireCode(req.params.id, requireUser(req));
    requireReady(channel.id);
    const cwd = repoDir(channel.id);
    return serial(channel.id, async () => {
      const raw = await git(cwd, ["status", "--porcelain=v1", "-b", "-uall", "-z"]);
      const [head = "", ...entries] = raw.split("\0").filter(Boolean);
      const files: CodeStatus["files"] = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const code = entry.slice(0, 2);
        files.push({ path: entry.slice(3), code });
        if (code.startsWith("R") || code.startsWith("C")) i++; // -z puts the original name in the next field
      }
      const branchLine = head.replace(/^## /, "");
      const [names = "", tracking = ""] = branchLine.split(" [");
      const [branch, upstream] = names.split("...");
      const branches = (await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]).catch(() => ""))
        .split("\n")
        .map((b) => b.trim().replace(/^origin\//, ""))
        .filter((b) => b && b !== "HEAD" && b !== "origin");
      const log = (await git(cwd, ["log", "-30", "--format=%h%x1f%s%x1f%an%x1f%aI"]).catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash = "", subject = "", author = "", date = ""] = line.split("\x1f");
          return { hash, subject, author, date };
        });
      return {
        branch: branch?.replace(/^No commits yet on /, "") || null,
        upstream: upstream ?? null,
        ahead: Number(/ahead (\d+)/.exec(tracking)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(tracking)?.[1] ?? 0),
        files,
        branches: [...new Set(branches)],
        log,
      };
    });
  });

  app.get<Params<"id">>("/channels/:id/code/diff", async (req) => {
    const { channel } = requireCode(req.params.id, requireUser(req));
    requireReady(channel.id);
    const path = cleanPath(parse(pathQuery, req.query).path);
    const cwd = repoDir(channel.id);
    const diff = await git(cwd, ["diff", "HEAD", "--", path]).catch(() => git(cwd, ["diff", "--", path]).catch(() => ""));
    const original = await git(cwd, ["show", `HEAD:${path}`]).catch(() => "");
    return { diff, original };
  });

  app.post<Params<"id">>("/channels/:id/code/discard", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireCode(req.params.id, userId, Permission.SEND_MESSAGES);
    requireReady(channel.id);
    const path = cleanPath(parse(pathQuery, req.body).path);
    const cwd = repoDir(channel.id);
    await serial(channel.id, () =>
      gitStep(async () => {
        const tracked = await git(cwd, ["ls-files", "--error-unmatch", "--", path]).then(() => true, () => false);
        if (tracked) await git(cwd, ["checkout", "HEAD", "--", path]);
        else await rm(await inside(channel.id, path, { mustExist: true }), { recursive: true, force: true });
      }),
    );
    await announce(channel, [path], userId);
    return {};
  });

  app.post<Params<"id">>("/channels/:id/code/commit", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireCode(req.params.id, userId, Permission.SEND_MESSAGES);
    requireReady(channel.id);
    const body = parse(commitBody, req.body);
    const user = getUsers([userId]).get(userId);
    const name = user?.displayName || user?.username || "Annoy";
    const email = body.email || `${user?.username ?? "annoy"}@users.noreply.annoy`;
    const cwd = repoDir(channel.id);
    await serial(channel.id, () =>
      gitStep(async () => {
        await git(cwd, ["add", "-A"]);
        await git(cwd, ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", body.message]);
      }),
    );
    await announce(channel, [], userId);
    return repoInfo(channel.id);
  });

  app.post<Params<"id">>("/channels/:id/code/push", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireCode(req.params.id, userId, Permission.SEND_MESSAGES);
    requireReady(channel.id);
    const body = parse(tokenBody, req.body ?? {});
    const cwd = repoDir(channel.id);
    await checkRemote(linkedUrl(channel.id)!);
    await serial(channel.id, () => gitStep(() => git(cwd, ["push", "-u", "origin", "HEAD"], { token: body.token, timeout: 5 * 60_000 })));
    await announce(channel, [], userId);
    return repoInfo(channel.id);
  });

  app.post<Params<"id">>("/channels/:id/code/pull", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireCode(req.params.id, userId, Permission.SEND_MESSAGES);
    requireReady(channel.id);
    const body = parse(tokenBody, req.body ?? {});
    const cwd = repoDir(channel.id);
    await checkRemote(linkedUrl(channel.id)!);
    await serial(channel.id, () =>
      gitStep(async () => {
        await git(cwd, ["fetch", "--prune", "origin"], { token: body.token, timeout: 5 * 60_000 });
        const upstream = await git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => "");
        if (upstream.trim()) await git(cwd, ["merge", "--ff-only", "@{upstream}"], { token: body.token, timeout: 5 * 60_000 });
      }),
    );
    await announce(channel, ["*"], userId);
    return repoInfo(channel.id);
  });

  app.post<Params<"id">>("/channels/:id/code/checkout", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireCode(req.params.id, userId, Permission.SEND_MESSAGES);
    requireReady(channel.id);
    const body = parse(checkoutBody, req.body);
    const cwd = repoDir(channel.id);
    await serial(channel.id, () =>
      gitStep(() => git(cwd, body.create ? ["checkout", "-b", body.branch] : ["checkout", body.branch], { timeout: 5 * 60_000 })),
    );
    await announce(channel, ["*"], userId);
    return repoInfo(channel.id);
  });
}
