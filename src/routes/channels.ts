import { ALL_PERMISSIONS, has, hasMessages, LIMITS, parseMentions, Permission, type Channel, type ChannelFilePage, type Message } from "@distopic/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.ts";
import { all, now, one, run, tx } from "../db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../errors.ts";
import { sendToChannel, sendToUser, serverChanged } from "../events.ts";
import { advanceRead, messageWindow, readState } from "../history.ts";
import { newId, secretId } from "../ids.ts";
import { maxUploadBytes } from "../instance.ts";
import { requireChannel, requireServer } from "../perms.ts";
import { dmRecipientIds, getChannel, getMessage, getMessages, getUser, isMember } from "../repo.ts";
import { discardBlobs, readBlob, writeBlob } from "../uploads.ts";
import { byteRange } from "../ranges.ts";
import { uploadsRemoved } from "../playback.ts";
import { removeChannel } from "../rooms.ts";
import { parse, type Params } from "../validate.ts";

const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp)|audio\/|video\/)/;

const patchChannel = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax).optional(),
  topic: z.string().max(LIMITS.topicMax).optional(),
  parentId: z.string().nullable().optional(),
  position: z.number().int().min(0).optional(),
});
const overwriteBody = z.object({
  targetType: z.enum(["role", "member"]),
  allow: z.number().int().min(0).max(ALL_PERMISSIONS),
  deny: z.number().int().min(0).max(ALL_PERMISSIONS),
});
const messageBody = z.object({
  content: z.string().max(LIMITS.messageMax),
  replyToId: z.string().nullable().optional(),
});
const editBody = z.object({ content: z.string().min(1).max(LIMITS.messageMax) });
const listQuery = z.object({
  around: z.string().max(100).optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const fileListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000_000).default(0),
  q: z.string().trim().max(100).default(""),
  sort: z.enum(["recent", "name", "size"]).default("recent"),
});

interface StagedFile {
  id: string;
  filename: string;
  size: number;
  contentType: string;
}

const safeFilename = (name: string) => name.replace(/[/\\\0]/g, "_").slice(0, 200) || "arquivo";

/** Streams multipart files to disk; returns the text fields and the staged files. */
async function readMultipart(req: FastifyRequest): Promise<{ fields: Record<string, string>; files: StagedFile[] }> {
  const fields: Record<string, string> = {};
  const files: StagedFile[] = [];
  try {
    const limit = maxUploadBytes();
    for await (const part of req.parts({ limits: { fileSize: limit, files: LIMITS.attachmentsPerMessage, fields: 10 } })) {
      if (part.type === "field") {
        fields[part.fieldname] = String(part.value);
        continue;
      }
      if (files.length >= LIMITS.attachmentsPerMessage) throw badRequest("Anexos demais");
      const staged = { id: secretId(), filename: safeFilename(part.filename), size: 0, contentType: part.mimetype || "application/octet-stream" };
      files.push(staged);
      staged.size = await writeBlob(staged.id, part.file);
      if (part.file.truncated) throw new HttpError(413, "too_large", `Arquivo maior que ${Math.round(limit / 1024 / 1024)} MB`);
    }
    return { fields, files };
  } catch (err) {
    await discard(files);
    throw err;
  }
}

const discard = (files: readonly { id: string }[]) => discardBlobs(files.map((f) => f.id));

/** Mentions only count for users who can be reached in this channel. */
function resolveMentions(channel: Channel, content: string, perms: number): { ids: string[]; everyone: boolean } {
  const parsed = parseMentions(content);
  const reachable =
    channel.type === "dm"
      ? (id: string) => dmRecipientIds(channel.id).includes(id)
      : (id: string) => channel.serverId !== null && isMember(channel.serverId, id);
  return {
    ids: parsed.userIds.filter(reachable),
    everyone: parsed.everyone && channel.type !== "dm" && has(perms, Permission.MENTION_EVERYONE),
  };
}

export function channelRoutes(app: FastifyInstance): void {
  app.get("/users/@me/read-states", async req => {
    const userId=requireUser(req);
    const ids=all<{id:string}>("SELECT channel_id AS id FROM dm_recipients WHERE user_id=? UNION SELECT c.id FROM channels c JOIN members m ON m.server_id=c.server_id WHERE m.user_id=? AND c.type IN ('text','announcements')",userId,userId).map(row=>row.id);
    return ids.flatMap(id=>{
      try {
        const {channel}=requireChannel(id,userId);
        return [readState(channel.id,userId)];
      } catch { return []; }
    });
  });
  app.patch<Params<"id">>("/channels/:id", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireChannel(req.params.id, userId);
    if (!channel.serverId) throw badRequest("DMs não podem ser editadas");
    requireServer(channel.serverId, userId, Permission.MANAGE_CHANNELS);
    const body = parse(patchChannel, req.body);
    if (body.parentId && !one("SELECT 1 AS x FROM channels WHERE id = ? AND server_id = ? AND type = 'category'", body.parentId, channel.serverId)) {
      throw badRequest("Categoria inválida");
    }
    tx(() => {
      if (body.name !== undefined) run("UPDATE channels SET name = ? WHERE id = ?", body.name, channel.id);
      if (body.topic !== undefined) run("UPDATE channels SET topic = ? WHERE id = ?", body.topic, channel.id);
      if (body.parentId !== undefined && channel.type !== "category") run("UPDATE channels SET parent_id = ? WHERE id = ?", body.parentId, channel.id);
      if (body.position !== undefined) run("UPDATE channels SET position = ? WHERE id = ?", body.position, channel.id);
    });
    serverChanged(channel.serverId);
    return getChannel(channel.id);
  });

  app.delete<Params<"id">>("/channels/:id", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireChannel(req.params.id, userId);
    if (!channel.serverId) throw badRequest("DMs não podem ser excluídas");
    requireServer(channel.serverId, userId, Permission.MANAGE_CHANNELS);
    await removeChannel(channel);
    return {};
  });

  app.put<Params<"id" | "targetId">>("/channels/:id/overwrites/:targetId", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireChannel(req.params.id, userId);
    if (!channel.serverId) throw badRequest("DMs não têm permissões");
    requireServer(channel.serverId, userId, Permission.MANAGE_ROLES);
    const body = parse(overwriteBody, req.body);
    run(
      "INSERT OR REPLACE INTO overwrites (channel_id, target_id, target_type, allow, deny) VALUES (?, ?, ?, ?, ?)",
      channel.id,
      req.params.targetId,
      body.targetType,
      body.allow,
      body.deny & ~body.allow,
    );
    serverChanged(channel.serverId);
    return {};
  });

  app.delete<Params<"id" | "targetId">>("/channels/:id/overwrites/:targetId", async (req) => {
    const userId = requireUser(req);
    const { channel } = requireChannel(req.params.id, userId);
    if (!channel.serverId) throw badRequest("DMs não têm permissões");
    requireServer(channel.serverId, userId, Permission.MANAGE_ROLES);
    run("DELETE FROM overwrites WHERE channel_id = ? AND target_id = ?", channel.id, req.params.targetId);
    serverChanged(channel.serverId);
    return {};
  });

  // Messages ---------------------------------------------------------------

  app.get<Params<"id">>("/channels/:id/files", async (req): Promise<ChannelFilePage> => {
    const { channel } = requireChannel(req.params.id, requireUser(req));
    if (channel.type !== "files") throw badRequest("Este canal não é de arquivos");
    const query = parse(fileListQuery, req.query);
    const search = "%" + query.q.replace(/[\\%_]/g, "\\$&") + "%";
    const where = "a.message_id=m.id AND m.channel_id=? AND (?='' OR a.filename LIKE ? ESCAPE '\\' COLLATE NOCASE OR m.content LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.username LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE)";
    const params = [channel.id, query.q, search, search, search, search];
    const total = one<{ total: number }>("SELECT COUNT(*) AS total FROM attachments a JOIN messages m ON m.id=a.message_id JOIN users u ON u.id=m.author_id WHERE " + where, ...params)?.total ?? 0;
    const order = query.sort === "name" ? "a.filename COLLATE NOCASE ASC, a.id ASC"
      : query.sort === "size" ? "a.size DESC, a.id ASC"
      : "m.created_at DESC, m.id DESC, a.id DESC";
    const rows = all<{ message_id: string; attachment_id: string }>(
      "SELECT m.id AS message_id, a.id AS attachment_id FROM attachments a JOIN messages m ON m.id=a.message_id JOIN users u ON u.id=m.author_id WHERE " + where + " ORDER BY " + order + " LIMIT ? OFFSET ?",
      ...params, query.limit + 1, query.offset,
    );
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).flatMap((row) => {
      const message = getMessage(row.message_id);
      const attachment = message?.attachments.find((item) => item.id === row.attachment_id);
      return message && attachment ? [{ message, attachment }] : [];
    });
    return { files: page, nextOffset: hasMore ? query.offset + query.limit : null, total };
  });

  app.get<Params<"id">>("/channels/:id/messages", async (req): Promise<Message[]> => {
    const { channel } = requireChannel(req.params.id, requireUser(req));
    if (!hasMessages(channel.type)) return [];
    const q = parse(listQuery, req.query);
    if (q.around) {
      const target=getMessage(q.around); if (!target || target.channelId!==channel.id) throw notFound("Mensagem");
      const before=getMessages(channel.id,target.id,25);
      const after=all<{id:string}>("SELECT id FROM messages WHERE channel_id=? AND id>? ORDER BY id LIMIT 25",channel.id,target.id).map(row=>getMessage(row.id)!);
      return [...before,target,...after];
    }
    return getMessages(channel.id, q.before ?? null, q.limit);
  });

  // Additive cursor API. `id` is the stable, ordered key; the legacy Message[] route stays intact.
  app.get<Params<"id">>("/channels/:id/messages/window", async (req) => {
    const { channel } = requireChannel(req.params.id, requireUser(req));
    if (!hasMessages(channel.type)) return { items: [], hasMoreBefore: false, hasMoreAfter: false };
    const q = parse(z.object({ before: z.string().optional(), after: z.string().optional(), around: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    return messageWindow(channel.id,q);
  });

  app.get<Params<"id">>("/channels/:id/read-state", async (req) => {
    const userId=requireUser(req); const {channel}=requireChannel(req.params.id,userId);
    return readState(channel.id,userId);
  });
  app.put<Params<"id">>("/channels/:id/read-state", async (req) => {
    const userId=requireUser(req); const {channel}=requireChannel(req.params.id,userId);
    const body=parse(z.object({messageId:z.string().min(1)}),req.body);
    const state=advanceRead(channel.id,userId,body.messageId);
    sendToUser(userId,{t:"CHANNEL_READ_STATE",d:{userId,state}});
    return state;
  });

  app.get<Params<"id">>("/channels/:id/pins", async (req) => {
    const { channel } = requireChannel(req.params.id, requireUser(req));
    return all<{message_id:string;pinned_by:string;pinned_at:string}>("SELECT message_id,pinned_by,pinned_at FROM pinned_messages WHERE channel_id=? ORDER BY pinned_at DESC LIMIT 100",channel.id).flatMap(row=>{
      const message=getMessage(row.message_id), pinnedBy=getUser(row.pinned_by);
      return message && pinnedBy ? [{message,pinnedBy,pinnedAt:row.pinned_at}] : [];
    });
  });
  app.put<Params<"id"|"messageId">>("/channels/:id/pins/:messageId", async (req) => {
    const userId=requireUser(req); const {channel,perms}=requireChannel(req.params.id,userId);
    if(channel.type!=="dm" && !has(perms,Permission.MANAGE_MESSAGES)) throw forbidden();
    const message=getMessage(req.params.messageId); if(!message || message.channelId!==channel.id) throw notFound("Mensagem");
    if(!one("SELECT 1 FROM pinned_messages WHERE channel_id=? AND message_id=?",channel.id,message.id) && (one<{count:number}>("SELECT COUNT(*) AS count FROM pinned_messages WHERE channel_id=?",channel.id)?.count??0)>=100) throw badRequest("O canal j? tem 100 mensagens fixadas. Remova uma antes de fixar outra.");
    run("INSERT OR IGNORE INTO pinned_messages(channel_id,message_id,pinned_by,pinned_at) VALUES(?,?,?,?)",channel.id,message.id,userId,now());
    const row=one<{pinned_by:string;pinned_at:string}>("SELECT pinned_by,pinned_at FROM pinned_messages WHERE channel_id=? AND message_id=?",channel.id,message.id)!;
    const pinned={message,pinnedBy:getUser(row.pinned_by)!,pinnedAt:row.pinned_at};
    sendToChannel(channel,{t:"CHANNEL_PIN_UPDATE",d:{channelId:channel.id,message:pinned,messageId:message.id}});
    return pinned;
  });
  app.delete<Params<"id"|"messageId">>("/channels/:id/pins/:messageId", async (req) => {
    const userId=requireUser(req); const {channel,perms}=requireChannel(req.params.id,userId);
    if(channel.type!=="dm" && !has(perms,Permission.MANAGE_MESSAGES)) throw forbidden();
    run("DELETE FROM pinned_messages WHERE channel_id=? AND message_id=?",channel.id,req.params.messageId);
    sendToChannel(channel,{t:"CHANNEL_PIN_UPDATE",d:{channelId:channel.id,message:null,messageId:req.params.messageId}});
    return {};
  });

  app.post<Params<"id">>("/channels/:id/messages", async (req) => {
    const userId = requireUser(req);
    const { channel, perms } = requireChannel(req.params.id, userId, Permission.SEND_MESSAGES);
    if (!hasMessages(channel.type)) throw badRequest("Este canal não aceita mensagens");

    const { fields, files } = req.isMultipart() ? await readMultipart(req) : { fields: req.body as Record<string, unknown>, files: [] };
    try {
      if (files.length > 0 && !has(perms, Permission.ATTACH_FILES)) throw forbidden("Sem permissão para anexar arquivos");
      const body = parse(messageBody, { content: fields.content ?? "", replyToId: fields.replyToId || null });
      const content = body.content.trim();
      if (!content && files.length === 0) throw badRequest("Mensagem vazia");
      if (channel.type === "files" && files.length === 0) throw badRequest("Envie ao menos um arquivo neste canal");
      const replyToId = body.replyToId && one("SELECT 1 AS x FROM messages WHERE id = ? AND channel_id = ?", body.replyToId, channel.id) ? body.replyToId : null;
      const mentions = resolveMentions(channel, content, perms);
      const id = newId();
      tx(() => {
        run(
          "INSERT INTO messages (id, channel_id, author_id, content, created_at, reply_to_id, mention_ids, mentions_everyone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          channel.id,
          userId,
          content,
          now(),
          replyToId,
          JSON.stringify(mentions.ids),
          mentions.everyone ? 1 : 0,
        );
        for (const f of files) {
          run("INSERT INTO attachments (id, message_id, filename, size, content_type) VALUES (?, ?, ?, ?, ?)", f.id, id, f.filename, f.size, f.contentType);
        }
      });
      const message = getMessage(id)!;
      sendToChannel(channel, { t: "MESSAGE_CREATE", d: message });
      return message;
    } catch (err) {
      await discard(files);
      throw err;
    }
  });

  app.patch<Params<"id" | "messageId">>("/channels/:id/messages/:messageId", async (req) => {
    const userId = requireUser(req);
    const { channel, perms } = requireChannel(req.params.id, userId);
    const message = getMessage(req.params.messageId);
    if (!message || message.channelId !== channel.id) throw notFound("Mensagem");
    if (message.author.id !== userId) throw forbidden("Você só pode editar suas mensagens");
    const body = parse(editBody, req.body);
    const mentions = resolveMentions(channel, body.content, perms);
    run(
      "UPDATE messages SET content = ?, edited_at = ?, mention_ids = ?, mentions_everyone = ? WHERE id = ?",
      body.content.trim(),
      now(),
      JSON.stringify(mentions.ids),
      mentions.everyone ? 1 : 0,
      message.id,
    );
    const updated = getMessage(message.id)!;
    sendToChannel(channel, { t: "MESSAGE_UPDATE", d: updated });
    return updated;
  });

  app.delete<Params<"id" | "messageId">>("/channels/:id/messages/:messageId", async (req) => {
    const userId = requireUser(req);
    const { channel, perms } = requireChannel(req.params.id, userId);
    const message = getMessage(req.params.messageId);
    if (!message || message.channelId !== channel.id) throw notFound("Mensagem");
    const moderator = channel.type !== "dm" && has(perms, Permission.MANAGE_MESSAGES);
    if (message.author.id !== userId && !moderator) throw forbidden();
    run("DELETE FROM messages WHERE id = ?", message.id);
    await discard(message.attachments);
    uploadsRemoved(channel, message.attachments.map((a) => a.id));
    sendToChannel(channel, { t: "MESSAGE_DELETE", d: { channelId: channel.id, messageId: message.id } });
    return {};
  });

  // Idempotent reactions: one vote per user/emoji; channel access is always rechecked.
  const reaction = async (req: FastifyRequest<{ Params: { id: string; messageId: string; emoji: string } }>, add: boolean) => {
    const userId = requireUser(req);
    const { channel } = requireChannel(req.params.id, userId, Permission.SEND_MESSAGES);
    const message = getMessage(req.params.messageId);
    if (!message || message.channelId !== channel.id) throw notFound("Mensagem");
    const emoji = req.params.emoji.normalize("NFC");
    const segments = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(emoji)];
    if (emoji.length > 32 || segments.length !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(emoji)) throw badRequest("Escolha um emoji válido");
    if (add) {
      if ((message.reactions?.length ?? 0) >= 20 && !message.reactions?.some((item) => item.emoji === emoji)) throw badRequest("Esta mensagem já tem 20 reações diferentes");
      run("INSERT OR IGNORE INTO message_reactions(message_id,user_id,emoji) VALUES(?,?,?)", message.id, userId, emoji);
    } else run("DELETE FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?", message.id, userId, emoji);
    const updated = getMessage(message.id)!;
    sendToChannel(channel, { t: "MESSAGE_UPDATE", d: updated });
    return updated;
  };
  app.put<Params<"id" | "messageId" | "emoji">>("/channels/:id/messages/:messageId/reactions/:emoji", async (req) => reaction(req, true));
  app.delete<Params<"id" | "messageId" | "emoji">>("/channels/:id/messages/:messageId/reactions/:emoji", async (req) => reaction(req, false));

  // Uploads are addressed by an unguessable id so <img> tags work without auth headers.
  app.get<Params<"id" | "name">>("/uploads/:id/:name", async (req, reply) => {
    const row = one<{ filename: string; content_type: string; size: number }>(
      "SELECT filename, content_type, size FROM attachments WHERE id = ?",
      req.params.id,
    );
    if (!row || !/^[0-9a-f]{32}$/.test(req.params.id)) throw notFound("Arquivo");
    const inline = INLINE_TYPES.test(row.content_type);
    reply
      .header("Content-Type", inline ? row.content_type : "application/octet-stream")
      .header("Content-Length", row.size)
      .header("Accept-Ranges", "bytes")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    if (req.headers.range) {
      const range = byteRange(req.headers.range, row.size);
      if (!range) return reply.status(416).header("Content-Range", `bytes */${row.size}`).header("Content-Length", 0).send();
      reply.status(206).header("Content-Range", `bytes ${range.start}-${range.end}/${row.size}`).header("Content-Length", range.end - range.start + 1);
      return reply.send(readBlob(req.params.id, range));
    }
    return reply.send(readBlob(req.params.id));
  });
}
