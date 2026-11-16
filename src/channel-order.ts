import { LIMITS, type ChannelType } from "@annoy/protocol";
import { all, one, run, tx } from "./db.ts";
import { badRequest, HttpError } from "./errors.ts";

/** Text-like rooms are named in the Discord style: lowercase, dashes, no spaces. */
export const SLUG_TYPES = new Set<ChannelType>(["text", "files", "code"]);
export const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, LIMITS.nameMax) || "canal";
export const channelName = (type: ChannelType, name: string) => (SLUG_TYPES.has(type) ? slug(name) : name.trim());

/**
 * Two rooms of the same type with the same name in the same place can't be told apart
 * in the list. Temporary voice rooms come and go, so they are left out.
 */
export function requireFreeChannelName(serverId: string, type: ChannelType, storedName: string, parentId: string | null, exceptId: string | null = null): void {
  const wanted = storedName.trim().toLocaleLowerCase();
  const rows = all<{ id: string; name: string }>(
    "SELECT id, name FROM channels WHERE server_id = ? AND type = ? AND parent_id IS ? AND temporary = 0",
    serverId, type, type === "category" ? null : parentId,
  );
  if (rows.some((row) => row.id !== exceptId && row.name.toLocaleLowerCase() === wanted))
    throw new HttpError(409, "channel_name_taken", type === "category" ? "Já existe uma categoria com esse nome." : "Já existe uma sala desse tipo com esse nome aqui.");
}

/**
 * Puts a room before another one (or at the end of its category) and renumbers the
 * server's rooms. Rooms the person can't see keep their places around it.
 */
export function moveChannel(serverId: string, channelId: string, parentId: string | null, beforeId: string | null): void {
  tx(() => {
    const rows = all<{ id: string; type: ChannelType; parent_id: string | null; name: string; temporary: number }>(
      "SELECT id, type, parent_id, name, temporary FROM channels WHERE server_id = ? ORDER BY position, id", serverId);
    const moving = rows.find((row) => row.id === channelId);
    if (!moving) throw badRequest("Sala inválida");
    const category = moving.type === "category";
    const parent = category ? null : parentId;
    if (parent && !rows.some((row) => row.id === parent && row.type === "category")) throw badRequest("Categoria inválida");
    const before = beforeId ? rows.find((row) => row.id === beforeId) : null;
    if (beforeId && (!before || before.id === channelId || (category ? before.type !== "category" : before.type === "category" || before.parent_id !== parent)))
      throw badRequest("Posição inválida");
    if (!category && !moving.temporary && moving.parent_id !== parent) requireFreeChannelName(serverId, moving.type, moving.name, parent, moving.id);
    const rest = rows.filter((row) => row.id !== channelId);
    let at: number;
    if (before) at = rest.indexOf(before);
    else if (category) at = rest.length;
    else {
      const last = rest.findLastIndex((row) => row.type !== "category" && row.parent_id === parent);
      at = last >= 0 ? last + 1 : parent ? rest.findIndex((row) => row.id === parent) + 1 : 0;
    }
    rest.splice(at, 0, { ...moving, parent_id: parent });
    rest.forEach((row, position) => run("UPDATE channels SET position = ?, parent_id = ? WHERE id = ?", position, row.parent_id, row.id));
  });
}

/** For callers that only need to know a parent exists. */
export const isCategoryOf = (serverId: string, id: string) => !!one("SELECT 1 AS x FROM channels WHERE id = ? AND server_id = ? AND type = 'category'", id, serverId);
