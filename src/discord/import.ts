import { Readable } from "node:stream";
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
import { maxUploadBytes, requireServerQuota } from "../instance.ts";
import { now, one, run, tx } from "../db.ts";
import { badRequest, conflict, forbidden } from "../errors.ts";
import { sendToUser, serverChanged } from "../events.ts";
import { idAt, newId, secretId } from "../ids.ts";
import { requireServer } from "../perms.ts";
import { getServer } from "../repo.ts";
import { discardBlobs, writeBlob } from "../uploads.ts";
import { avatarUrlOf, DiscordError, DiscordRest, isDiscordCdn, snowflakeTime, type DChannel, type DGuild, type DMessage, type DUser } from "./rest.ts";

// Discord -> Distopic mapping ------------------------------------------------

const TEXT_TYPES = new Set([0, 5]); // text, announcement
const VOICE_TYPES = new Set([2, 13]); // voice, stage
const TYPE_LABELS: Record<number, string> = { 0: "texto", 2: "voz", 4: "categoria", 5: "anúncios", 13: "palco", 15: "fórum", 16: "mídia" };
/** Message types that carry user content: default, reply, slash-command response. */
const CONTENT_TYPES = new Set([0, 19, 20]);
const PAGE = 100;
/** View Channels + Read Message History: everything the importer needs. */
const BOT_PERMISSIONS = 1024 + 65536;

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
    if (r.userId === userId && (r.job.phase === "structure" || r.job.phase === "messages")) throw conflict("Já existe uma importação em andamento");
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
      currentChannel: null,
      channelsDone: 0,
      channelsTotal: 0,
      messagesImported: 0,
      attachmentsImported: 0,
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

    const wanted = new Set(req.messageChannelIds);
    const targets = sidebarOrder(channels).filter((c) => wanted.has(c.id) && TEXT_TYPES.has(c.type) && channelMap.get(job.id)?.has(c.id));
    job.phase = "messages";
    job.channelsTotal = targets.length;
    emit(r, true);
    const names = new Map(channels.map((c) => [c.id, c.name]));
    const roleNames = new Map(guild.roles.map((role) => [role.id, role.name]));
    for (const channel of targets) {
      job.currentChannel = channel.name;
      emit(r, true);
      await importMessages(r, req, rest, channel, channelMap.get(job.id)!.get(channel.id)!, names, roleNames);
      job.channelsDone++;
      serverChanged(serverId);
    }
    job.phase = "done";
    job.currentChannel = null;
  } catch (err) {
    if (r.abort.signal.aborted) job.phase = "cancelled";
    else {
      job.phase = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      if (!(err instanceof DiscordError)) console.error("discord import failed", err);
    }
  } finally {
    channelMap.delete(job.id);
    if (job.serverId) serverChanged(job.serverId);
    emit(r, true);
  }
}

/** Discord channel id -> Distopic channel id, per job, for the message phase. */
const channelMap = new Map<string, Map<string, string>>();

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
        // Discord members are not Distopic accounts, so member overwrites have no target.
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
    channelMap.set(job.id, ids);
    return sid;
  });

  const server = getServer(serverId)!;
  if (req.target.kind === "new") sendToUser(userId, { t: "SERVER_CREATE", d: server });
  serverChanged(serverId);
  return serverId;
}

// Messages -------------------------------------------------------------------

/** Imported authors are profiles without credentials, reused across imports. */
function ghostUser(user: DUser, cache: Map<string, string>): string {
  const cached = cache.get(user.id);
  if (cached) return cached;
  const key = `discord:${user.id}`;
  const displayName = (user.global_name || user.username).slice(0, LIMITS.usernameMax);
  // Someone who already signed in with this Discord account authors their own history.
  const linked = one<{ id: string }>("SELECT id FROM users WHERE discord_id = ?", user.id)?.id;
  if (linked) {
    cache.set(user.id, linked);
    return linked;
  }
  let id = one<{ id: string }>("SELECT id FROM users WHERE imported_from = ?", key)?.id;
  if (id) run("UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?", displayName, avatarUrlOf(user), id);
  else {
    id = newId();
    // "dc." is reserved at registration, and "!" never verifies as a password hash.
    run(
      "INSERT INTO users (id, username, display_name, password_hash, created_at, imported_from, avatar_url) VALUES (?, ?, ?, '!', ?, ?, ?)",
      id,
      `dc.${user.id}`,
      displayName,
      now(),
      key,
      avatarUrlOf(user),
    );
  }
  cache.set(user.id, id);
  return id;
}

function convertContent(m: DMessage, channelNames: Map<string, string>, roleNames: Map<string, string>): string {
  const users = new Map(m.mentions.map((u) => [u.id, u.global_name || u.username]));
  let content = m.content
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${users.get(id) ?? "usuário"}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${roleNames.get(id) ?? "cargo"}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${channelNames.get(id) ?? "canal"}`)
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/<t:(\d+)(?::\w)?>/g, (_, s: string) => new Date(Number(s) * 1000).toLocaleString("pt-BR"));
  if (!content && m.attachments.length === 0) {
    if (m.sticker_items?.length) content = `[figurinha: ${m.sticker_items.map((s) => s.name).join(", ")}]`;
    else if (m.embeds.length) content = "[embed não suportado]";
  }
  return content.slice(0, LIMITS.messageMax);
}

interface StoredAttachment {
  id: string;
  filename: string;
  size: number;
  contentType: string;
}

async function downloadAttachments(r: Running, m: DMessage): Promise<StoredAttachment[]> {
  const out: StoredAttachment[] = [];
  for (const a of m.attachments) {
    if (a.size > maxUploadBytes()) {
      warn(r.job, `Anexo ${a.filename} (${Math.round(a.size / 1048576)} MB) excede o limite e foi ignorado`);
      continue;
    }
    if (!isDiscordCdn(a.url)) continue;
    const id = secretId();
    try {
      const res = await fetch(a.url, { signal: r.abort.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const size = await writeBlob(id, Readable.fromWeb(res.body as import("node:stream/web").ReadableStream));
      out.push({ id, filename: a.filename.replace(/[/\\\0]/g, "_").slice(0, 200), size, contentType: a.content_type ?? "application/octet-stream" });
    } catch (err) {
      await discardBlobs([id]);
      if (r.abort.signal.aborted) throw err;
      warn(r.job, `Falha ao baixar ${a.filename}`);
    }
  }
  return out;
}

async function importMessages(
  r: Running,
  req: ImportRequest,
  rest: DiscordRest,
  channel: DChannel,
  targetId: string,
  channelNames: Map<string, string>,
  roleNames: Map<string, string>,
): Promise<void> {
  const { job } = r;
  const authors = new Map<string, string>();
  // Ids derive from the Discord snowflake, so replies resolve without a lookup table
  // and pages can be stored newest-first while history still sorts by time.
  const ourId = (discordId: string) => idAt(snowflakeTime(discordId), `${job.id}:${discordId}`);
  let before: string | null = null;
  let copied = 0;
  const limit = req.messageLimit ?? Number.POSITIVE_INFINITY;

  while (copied < limit) {
    const size = Math.min(PAGE, limit - copied);
    let page: DMessage[];
    try {
      page = await rest.get<DMessage[]>(`/channels/${channel.id}/messages?limit=${size}${before ? `&before=${before}` : ""}`);
    } catch (err) {
      if (err instanceof DiscordError && err.status === 403) {
        warn(job, `#${channel.name}: o bot não pode ler o histórico (falta "Ler histórico de mensagens")`);
        return;
      }
      throw err;
    }
    if (page.length === 0) return;
    before = page[page.length - 1]!.id;
    copied += page.length;

    const userMessages = page.filter((m) => CONTENT_TYPES.has(m.type));
    // Without the privileged intent Discord blanks content, attachments and embeds alike.
    if (userMessages.length > 0 && userMessages.every((m) => !m.content && m.attachments.length === 0 && m.embeds.length === 0 && !m.sticker_items?.length)) {
      warn(job, 'Mensagens chegaram vazias: ative "Message Content Intent" na aba Bot do portal do Discord');
    }
    const rows: { m: DMessage; content: string; files: StoredAttachment[] }[] = [];
    for (const m of userMessages) {
      const files = req.attachments ? await downloadAttachments(r, m) : [];
      const content = convertContent(m, channelNames, roleNames);
      if (!content && files.length === 0) continue;
      rows.push({ m, content, files });
    }

    try {
      tx(() => {
        for (const { m, content, files } of rows) {
          const id = ourId(m.id);
          const ref = m.message_reference;
          const replyTo = ref?.message_id && (!ref.channel_id || ref.channel_id === channel.id) ? ourId(ref.message_id) : null;
          run(
            "INSERT OR IGNORE INTO messages (id, channel_id, author_id, content, created_at, edited_at, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            id,
            targetId,
            ghostUser(m.author, authors),
            content,
            m.timestamp,
            m.edited_timestamp,
            replyTo,
          );
          for (const f of files) {
            run("INSERT INTO attachments (id, message_id, filename, size, content_type) VALUES (?, ?, ?, ?, ?)", f.id, id, f.filename, f.size, f.contentType);
          }
        }
      });
    } catch (err) {
      await discardBlobs(rows.flatMap((row) => row.files.map((f) => f.id)));
      throw err;
    }
    job.messagesImported += rows.length;
    job.attachmentsImported += rows.reduce((n, row) => n + row.files.length, 0);
    emit(r);
    if (page.length < size) return;
  }
}
