import {
  DEFAULT_EVERYONE_PERMISSIONS,
  LIMITS,
  Permission,
  type ImportChannel,
  type ImportChannelKind,
  type ImportGuild,
  type ImportGuildList,
  type ImportJob,
  type ImportRequest,
  type ImportStructure,
} from "@distopic/protocol";
import { requireServerQuota } from "../instance.ts";
import { now, one, run, tx } from "../db.ts";
import { badRequest, conflict, forbidden } from "../errors.ts";
import { sendToUser, serverChanged } from "../events.ts";
import { newId } from "../ids.ts";
import { requireServer } from "../perms.ts";
import { getServer } from "../repo.ts";
import { DiscordError, DiscordRest, type DChannel, type DGuild, type DUser } from "./rest.ts";

// Discord -> Annoy mapping ------------------------------------------------

const TEXT_TYPES = new Set([0, 5]); // text, announcement
const VOICE_TYPES = new Set([2, 13]); // voice, stage
const TYPE_LABELS: Record<number, string> = { 0: "texto", 2: "voz", 4: "categoria", 5: "anúncios", 13: "palco", 15: "fórum", 16: "mídia" };
/**
 * View Channels only: the importer copies structure, roles and permissions.
 * Messages are never imported: they belong to other people, who didn't agree
 * to move them (decided 2026-11-04).
 */
const BOT_PERMISSIONS = 1024;

const PERMISSION_MAP: [bigint, number][] = [
  [1n << 10n, Permission.VIEW_CHANNEL],
  [1n << 11n, Permission.SEND_MESSAGES],
  [1n << 13n, Permission.MANAGE_MESSAGES],
  [1n << 15n, Permission.ATTACH_FILES],
  [1n << 17n, Permission.MENTION_EVERYONE],
  [1n << 20n, Permission.CONNECT],
  [1n << 21n, Permission.SPEAK],
  [1n << 22n, Permission.MUTE_MEMBERS],
  [1n << 0n, Permission.CREATE_INVITE],
  [1n << 1n, Permission.KICK_MEMBERS],
  [1n << 2n, Permission.BAN_MEMBERS],
  [1n << 4n, Permission.MANAGE_CHANNELS],
  [1n << 5n, Permission.MANAGE_SERVER],
  [1n << 28n, Permission.MANAGE_ROLES],
  [1n << 3n, Permission.ADMINISTRATOR],
];

export function mapPermissions(discord: string): number {
  const bits = BigInt(discord);
  let out = 0;
  for (const [d, ours] of PERMISSION_MAP) if (bits & d) out |= ours;
  return out;
}

function kindOf(type: number): ImportChannelKind {
  if (type === 4) return "category";
  if (TEXT_TYPES.has(type)) return "text";
  if (VOICE_TYPES.has(type)) return "voice";
  return "unsupported";
}

const colorOf = (n: number) => (n === 0 ? null : `#${n.toString(16).padStart(6, "0")}`);

const iconOf = (g: { id: string; icon: string | null }) => (g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96` : null);

/** Orders channels the way Discord's sidebar shows them: loose first, then by category; text before voice. */
function sidebarOrder(channels: DChannel[]): DChannel[] {
  const byPos = (a: DChannel, b: DChannel) => a.position - b.position || a.id.localeCompare(b.id);
  const group = (list: DChannel[]) => [...list.filter((c) => !VOICE_TYPES.has(c.type)).sort(byPos), ...list.filter((c) => VOICE_TYPES.has(c.type)).sort(byPos)];
  const categories = channels.filter((c) => c.type === 4).sort(byPos);
  const categoryIds = new Set(categories.map((c) => c.id));
  const out = group(channels.filter((c) => c.type !== 4 && (!c.parent_id || !categoryIds.has(c.parent_id))));
  for (const cat of categories) out.push(cat, ...group(channels.filter((c) => c.parent_id === cat.id)));
  return out;
}

function wrap<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: unknown) => {
    if (err instanceof DiscordError) throw badRequest(err.message);
    throw err;
  });
}

const cleanToken = (token: string) => token.trim().replace(/^Bot\s+/i, "");

// Preview ------------------------------------------------------------------

export async function listGuilds(token: string): Promise<ImportGuildList> {
  const rest = new DiscordRest(cleanToken(token));
  const bot = await wrap(rest.get<DUser>("/users/@me"));
  if (!bot.bot) throw badRequest("Use o token de um bot, não de uma conta de usuário");
  const guilds = await wrap(rest.get<{ id: string; name: string; icon: string | null }[]>("/users/@me/guilds"));
  return {
    bot: { id: bot.id, username: bot.username },
    inviteUrl: `https://discord.com/oauth2/authorize?client_id=${bot.id}&scope=bot&permissions=${BOT_PERMISSIONS}`,
    guilds: guilds.map((g) => ({ id: g.id, name: g.name, iconUrl: iconOf(g) })),
  };
}

export async function getStructure(token: string, guildId: string): Promise<ImportStructure> {
  const rest = new DiscordRest(cleanToken(token));
  const [guild, channels] = await wrap(Promise.all([rest.get<DGuild>(`/guilds/${guildId}`), rest.get<DChannel[]>(`/guilds/${guildId}/channels`)]));
  return {
    guild: { id: guild.id, name: guild.name, iconUrl: iconOf(guild) } satisfies ImportGuild,
    roles: [...guild.roles]
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: colorOf(r.color), position: r.position, managed: r.managed })),
    channels: sidebarOrder(channels).map(
      (c, order): ImportChannel => ({
        id: c.id,
        name: c.name,
        kind: kindOf(c.type),
        label: TYPE_LABELS[c.type] ?? "outro",
        parentId: c.parent_id,
        order,
        overwriteCount: c.permission_overwrites?.length ?? 0,
      }),
    ),
  };
}

// Jobs -----------------------------------------------------------------------

interface Running {
  userId: string;
  job: ImportJob;
  abort: AbortController;
  lastEmit: number;
}

const jobs = new Map<string, Running>();
const MAX_FINISHED_JOBS = 20;
const MAX_WARNINGS = 30;

/** Deduplicated and bounded, so a channel full of oversized files can't flood the job. */
function warn(job: ImportJob, text: string): void {
  if (job.warnings.includes(text)) return;
  if (job.warnings.length < MAX_WARNINGS) job.warnings.push(text);
  else if (job.warnings.length === MAX_WARNINGS) job.warnings.push("Mais avisos foram omitidos");
}

function emit(r: Running, force = false): void {
  const t = Date.now();
  if (!force && t - r.lastEmit < 400) return;
  r.lastEmit = t;
  sendToUser(r.userId, { t: "IMPORT_PROGRESS", d: structuredClone(r.job) });
}

export function jobsFor(userId: string): ImportJob[] {
  return [...jobs.values()].filter((r) => r.userId === userId).map((r) => r.job);
}

export function cancelJob(userId: string, jobId: string): void {
  const r = jobs.get(jobId);
  if (!r || r.userId !== userId) throw badRequest("Importação não encontrada");
  r.abort.abort();
}

function pruneFinished(): void {
  const finished = [...jobs.entries()].filter(([, r]) => r.job.phase === "done" || r.job.phase === "failed" || r.job.phase === "cancelled");
  for (const [id] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) jobs.delete(id);
}

export function startImport(userId: string, req: ImportRequest): ImportJob {
  for (const r of jobs.values()) {
    if (r.userId === userId && r.job.phase === "structure") throw conflict("Já existe uma importação em andamento");
  }
  if (req.target.kind === "new") requireServerQuota(userId);
  if (req.target.kind === "existing") {
    const { server } = requireServer(req.target.serverId, userId);
    // Importing rewrites roles and permissions, so only the owner may target a server.
    if (server.ownerId !== userId) throw forbidden("Só o dono pode importar para um servidor existente");
  }
  const id = newId();
  const running: Running = {
    userId,
    abort: new AbortController(),
    lastEmit: 0,
    job: {
      id,
      serverId: req.target.kind === "existing" ? req.target.serverId : null,
      guildName: "",
      phase: "structure",
      channelsDone: 0,
      channelsTotal: 0,
      warnings: [],
      error: null,
    },
  };
  jobs.set(id, running);
  pruneFinished();
  void runImport(running, { ...req, token: cleanToken(req.token) });
  return running.job;
}

async function runImport(r: Running, req: ImportRequest): Promise<void> {
  const { job } = r;
  const rest = new DiscordRest(req.token, r.abort.signal);
  try {
    const [guild, channels] = await Promise.all([rest.get<DGuild>(`/guilds/${req.guildId}`), rest.get<DChannel[]>(`/guilds/${req.guildId}/channels`)]);
    job.guildName = guild.name;
    const serverId = importStructure(r, req, guild, channels);
    job.serverId = serverId;
    emit(r, true);

    job.phase = "done";
  } catch (err) {
    if (r.abort.signal.aborted) job.phase = "cancelled";
    else {
      job.phase = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      if (!(err instanceof DiscordError)) console.error("discord import failed", {code:"import_failed"});
    }
  } finally {
    if (job.serverId) serverChanged(job.serverId);
    emit(r, true);
  }
}


function importStructure(r: Running, req: ImportRequest, guild: DGuild, channels: DChannel[]): string {
  const { job, userId } = r;
  const selectedRoles = new Set(req.roleIds);
  const selectedChannels = new Set(req.channelIds);
  const everyone = guild.roles.find((role) => role.id === guild.id);

  const serverId = tx(() => {
    const t = now();
    let sid: string;
    if (req.target.kind === "new") {
      sid = newId();
      const name = req.target.name.trim().slice(0, LIMITS.nameMax) || guild.name;
      run("INSERT INTO servers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)", sid, name, userId, t);
      const basePerms = everyone && selectedRoles.has(everyone.id) ? mapPermissions(everyone.permissions) : DEFAULT_EVERYONE_PERMISSIONS;
      run("INSERT INTO roles (id, server_id, name, color, permissions, position) VALUES (?, ?, '@everyone', NULL, ?, 0)", sid, sid, basePerms);
      run("INSERT INTO members (server_id, user_id, nick, joined_at) VALUES (?, ?, NULL, ?)", sid, userId, t);
    } else {
      sid = req.target.serverId;
      if (!getServer(sid)) throw badRequest("Servidor de destino não existe mais");
    }

    // Roles: Discord's order is kept, placed below any roles the server already has.
    const roleIds = new Map<string, string>([[guild.id, sid]]);
    const roles = guild.roles.filter((role) => role.id !== guild.id && selectedRoles.has(role.id)).sort((a, b) => a.position - b.position);
    run("UPDATE roles SET position = position + ? WHERE server_id = ? AND position >= 1", roles.length, sid);
    roles.forEach((role, i) => {
      const id = newId();
      roleIds.set(role.id, id);
      run(
        "INSERT INTO roles (id, server_id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        sid,
        role.name.slice(0, LIMITS.nameMax),
        colorOf(role.color),
        mapPermissions(role.permissions),
        i + 1,
      );
    });

    // Channels: categories first so children can point at them.
    const ids = new Map<string, string>();
    const position = (one<{ p: number | null }>("SELECT MAX(position) AS p FROM channels WHERE server_id = ?", sid)?.p ?? -1) + 1;
    let skippedMemberOverwrites = 0;
    const ordered = sidebarOrder(channels).filter((c) => selectedChannels.has(c.id) && kindOf(c.type) !== "unsupported");
    for (const c of [...ordered.filter((c) => c.type === 4), ...ordered.filter((c) => c.type !== 4)]) {
      const id = newId();
      ids.set(c.id, id);
      const parentId = c.parent_id ? (ids.get(c.parent_id) ?? null) : null;
      run(
        "INSERT INTO channels (id, server_id, type, name, topic, parent_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        sid,
        kindOf(c.type),
        c.name.slice(0, LIMITS.nameMax),
        (c.topic ?? "").slice(0, LIMITS.topicMax),
        parentId,
        position + ordered.indexOf(c),
        t,
      );
      if (!req.overwrites) continue;
      for (const ow of c.permission_overwrites ?? []) {
        // Discord members are not Annoy accounts, so member overwrites have no target.
        if (ow.type === 1) {
          skippedMemberOverwrites++;
          continue;
        }
        const target = roleIds.get(ow.id);
        if (!target) continue;
        const allow = mapPermissions(ow.allow);
        run(
          "INSERT OR REPLACE INTO overwrites (channel_id, target_id, target_type, allow, deny) VALUES (?, ?, 'role', ?, ?)",
          id,
          target,
          allow,
          mapPermissions(ow.deny) & ~allow,
        );
      }
    }
    if (skippedMemberOverwrites > 0) warn(job, `${skippedMemberOverwrites} permissões por membro foram ignoradas (membros do Discord não têm conta aqui)`);
    const unsupported = channels.filter((c) => selectedChannels.has(c.id) && kindOf(c.type) === "unsupported");
    if (unsupported.length > 0) warn(job, `Canais sem equivalente ignorados: ${unsupported.map((c) => c.name).join(", ")}`);
    return sid;
  });

  const server = getServer(serverId)!;
  if (req.target.kind === "new") sendToUser(userId, { t: "SERVER_CREATE", d: server });
  serverChanged(serverId);
  return serverId;
}
