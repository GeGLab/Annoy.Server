import type { ChannelReadState, MessageWindow } from "@distopic/protocol";
import { all, now, one, run } from "./db.ts";
import { getMessage, getMessages } from "./repo.ts";
import { badRequest, notFound } from "./errors.ts";

export function messageWindow(
  channelId: string,
  query: { before?: string; after?: string; around?: string; limit: number },
): MessageWindow {
  const { before, after, around, limit } = query;
  if ([before, after, around].filter(Boolean).length > 1)
    throw badRequest("Use um único cursor");
  let items;
  if (around) {
    const target = getMessage(around);
    if (!target || target.channelId !== channelId) throw notFound("Mensagem");
    const previous = getMessages(
      channelId,
      around,
      Math.floor((limit - 1) / 2),
    );
    const following = all<{ id: string }>(
      "SELECT id FROM messages WHERE channel_id=? AND id>? ORDER BY id LIMIT ?",
      channelId,
      around,
      limit - previous.length - 1,
    ).map((row) => getMessage(row.id)!);
    items = [...previous, target, ...following];
  } else if (after) {
    items = all<{ id: string }>(
      "SELECT id FROM messages WHERE channel_id=? AND id>? ORDER BY id LIMIT ?",
      channelId,
      after,
      limit,
    ).map((row) => getMessage(row.id)!);
  } else items = getMessages(channelId, before ?? null, limit);
  const first = items[0]?.id,
    last = items.at(-1)?.id;
  return {
    items,
    hasMoreBefore: !!one(
      "SELECT 1 FROM messages WHERE channel_id=? AND id<? LIMIT 1",
      channelId,
      first ?? after ?? before ?? "",
    ),
    hasMoreAfter: !!one(
      "SELECT 1 FROM messages WHERE channel_id=? AND id>? LIMIT 1",
      channelId,
      last ?? after ?? before ?? "\uffff",
    ),
  };
}

export interface ReadState extends ChannelReadState {
  unread: { count: number; mention: boolean };
}
export function readState(channelId: string, userId: string): ReadState {
  let row = one<{ messageId: string | null; updatedAt: string }>(
    "SELECT message_id AS messageId,updated_at AS updatedAt FROM channel_read_states WHERE channel_id=? AND user_id=?",
    channelId,
    userId,
  );
  if (!row) {
    const latest =
      one<{ id: string }>(
        "SELECT id FROM messages WHERE channel_id=? ORDER BY id DESC LIMIT 1",
        channelId,
      )?.id ?? null;
    run(
      "INSERT OR IGNORE INTO channel_read_states(channel_id,user_id,message_id,updated_at) VALUES(?,?,?,?)",
      channelId,
      userId,
      latest,
      now(),
    );
    row = one<{ messageId: string | null; updatedAt: string }>(
      "SELECT message_id AS messageId,updated_at AS updatedAt FROM channel_read_states WHERE channel_id=? AND user_id=?",
      channelId,
      userId,
    );
  }
  // A new account starts at the recent page. It does not inherit all imported history as unread.
  const stats = row
    ? one<{ count: number; mention: number }>(
        "SELECT COUNT(*) AS count, MAX(CASE WHEN mentions_everyone=1 OR mention_ids LIKE ? THEN 1 ELSE 0 END) AS mention FROM messages WHERE channel_id=? AND id>? AND author_id<>?",
        `%\"${userId}\"%`,
        channelId,
        row.messageId ?? "",
        userId,
      )
    : null;
  return {
    channelId,
    messageId: row?.messageId ?? null,
    updatedAt: row?.updatedAt ?? now(),
    unread: { count: stats?.count ?? 0, mention: !!stats?.mention },
  };
}

export function advanceRead(
  channelId: string,
  userId: string,
  messageId: string,
): ReadState {
  const message = getMessage(messageId);
  if (!message || message.channelId !== channelId) throw notFound("Mensagem");
  run(
    "INSERT INTO channel_read_states(channel_id,user_id,message_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET message_id=excluded.message_id,updated_at=excluded.updated_at WHERE channel_read_states.message_id IS NULL OR channel_read_states.message_id < excluded.message_id",
    channelId,
    userId,
    messageId,
    now(),
  );
  return readState(channelId, userId);
}
