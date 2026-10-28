import { ALL_PERMISSIONS, has, LIMITS, parseMentions, Permission, type Channel, type Message } from "@distopic/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.ts";
import { all, now, one, run, tx } from "../db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../errors.ts";
import { sendToChannel, serverChanged } from "../events.ts";
import { newId, secretId } from "../ids.ts";
import { maxUploadBytes } from "../instance.ts";
import { requireChannel, requireServer } from "../perms.ts";
import { dmRecipientIds, getChannel, getMessage, getMessages, isMember } from "../repo.ts";
import { discardBlobs, readBlob, writeBlob } from "../uploads.ts";
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
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
    const blobs = all<{ id: string }>("SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id = ?", channel.id);
    run("DELETE FROM channels WHERE id = ?", channel.id);
    await discard(blobs);
    serverChanged(channel.serverId);
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

  app.get<Params<"id">>("/channels/:id/messages", async (req): Promise<Message[]> => {
    const { channel } = requireChannel(req.params.id, requireUser(req));
    if (channel.type === "category" || channel.type === "voice") return [];
    const q = parse(listQuery, req.query);
    return getMessages(channel.id, q.before ?? null, q.limit);
  });

  app.post<Params<"id">>("/channels/:id/messages", async (req) => {
    const userId = requireUser(req);
    const { channel, perms } = requireChannel(req.params.id, userId, Permission.SEND_MESSAGES);
    if (channel.type !== "text" && channel.type !== "dm") throw badRequest("Este canal não aceita mensagens");

    const { fields, files } = req.isMultipart() ? await readMultipart(req) : { fields: req.body as Record<string, unknown>, files: [] };
    try {
      if (files.length > 0 && !has(perms, Permission.ATTACH_FILES)) throw forbidden("Sem permissão para anexar arquivos");
      const body = parse(messageBody, { content: fields.content ?? "", replyToId: fields.replyToId || null });
      const content = body.content.trim();
      if (!content && files.length === 0) throw badRequest("Mensagem vazia");
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
    sendToChannel(channel, { t: "MESSAGE_DELETE", d: { channelId: channel.id, messageId: message.id } });
    return {};
  });

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
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    return reply.send(readBlob(req.params.id));
  });
}
