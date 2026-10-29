import type { DmChannel, Relationship } from "@distopic/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.ts";
import { now, one, run, tx } from "../db.ts";
import { badRequest, forbidden, notFound } from "../errors.ts";
import { sendToUser } from "../events.ts";
import { newId } from "../ids.ts";
import { findDm, getDmChannel, getRelationships, getUser, getUserByName, relationshipStatus } from "../repo.ts";
import { parse, type Params } from "../validate.ts";
import { refreshFriendActivities } from "../activity.ts";

const requestBody = z.object({ username: z.string().trim().min(1) });
const dmBody = z.object({ userId: z.string().min(1) });

function notifyRelationship(userId: string, otherId: string): void {
  const status = relationshipStatus(userId, otherId);
  const other = getUser(otherId);
  if (status && other) sendToUser(userId, { t: "RELATIONSHIP_UPDATE", d: { user: other, status } });
  else sendToUser(userId, { t: "RELATIONSHIP_REMOVE", d: { userId: otherId } });
}

function setFriends(a: string, b: string): void {
  tx(() => {
    run("INSERT OR REPLACE INTO relationships (user_id, other_id, status) VALUES (?, ?, 'friend')", a, b);
    run("INSERT OR REPLACE INTO relationships (user_id, other_id, status) VALUES (?, ?, 'friend')", b, a);
  });
}

/** DMs need a relationship or a shared server, which keeps strangers from spamming. */
function canMessage(a: string, b: string): boolean {
  return (
    relationshipStatus(a, b) === "friend" ||
    one("SELECT 1 AS x FROM members m1 JOIN members m2 ON m2.server_id = m1.server_id WHERE m1.user_id = ? AND m2.user_id = ?", a, b) !==
      undefined
  );
}

export function socialRoutes(app: FastifyInstance): void {
  app.get("/relationships", async (req): Promise<Relationship[]> => getRelationships(requireUser(req)));

  app.post("/relationships", async (req) => {
    const userId = requireUser(req);
    const body = parse(requestBody, req.body);
    const other = getUserByName(body.username);
    if (!other) throw notFound("Usuário");
    if (other.id === userId) throw badRequest("Você não pode adicionar a si mesmo");
    if (
      one(
        "SELECT 1 AS x FROM users WHERE id = ? AND (imported_from IS NOT NULL OR username LIKE 'deleted.%' OR banned_at IS NOT NULL)",
        other.id,
      )
    ) {
      throw badRequest("Este perfil não pode receber pedidos de amizade");
    }
    const mine = relationshipStatus(userId, other.id);
    if (mine === "friend" || mine === "outgoing") return {};
    if (mine === "incoming") setFriends(userId, other.id);
    else
      tx(() => {
        run("INSERT INTO relationships (user_id, other_id, status) VALUES (?, ?, 'outgoing')", userId, other.id);
        run("INSERT INTO relationships (user_id, other_id, status) VALUES (?, ?, 'incoming')", other.id, userId);
      });
    notifyRelationship(userId, other.id);
    notifyRelationship(other.id, userId);
    refreshFriendActivities(userId, other.id);
    return {};
  });

  app.put<Params<"userId">>("/relationships/:userId", async (req) => {
    const userId = requireUser(req);
    const otherId = req.params.userId;
    if (relationshipStatus(userId, otherId) !== "incoming") throw badRequest("Não há pedido pendente deste usuário");
    setFriends(userId, otherId);
    notifyRelationship(userId, otherId);
    notifyRelationship(otherId, userId);
    refreshFriendActivities(userId, otherId);
    return {};
  });

  app.delete<Params<"userId">>("/relationships/:userId", async (req) => {
    const userId = requireUser(req);
    const otherId = req.params.userId;
    run(
      "DELETE FROM relationships WHERE (user_id = ? AND other_id = ?) OR (user_id = ? AND other_id = ?)",
      userId,
      otherId,
      otherId,
      userId,
    );
    notifyRelationship(userId, otherId);
    notifyRelationship(otherId, userId);
    refreshFriendActivities(userId, otherId);
    return {};
  });

  app.post("/dms", async (req): Promise<DmChannel> => {
    const userId = requireUser(req);
    const body = parse(dmBody, req.body);
    if (body.userId === userId) throw badRequest("Você não pode abrir DM consigo mesmo");
    if (!getUser(body.userId)) throw notFound("Usuário");
    const existing = findDm(userId, body.userId);
    if (existing) return getDmChannel(existing, userId)!;
    if (!canMessage(userId, body.userId)) throw forbidden("Vocês precisam ser amigos ou compartilhar um servidor");
    const id = newId();
    tx(() => {
      run("INSERT INTO channels (id, server_id, type, name, created_at) VALUES (?, NULL, 'dm', '', ?)", id, now());
      run("INSERT INTO dm_recipients (channel_id, user_id) VALUES (?, ?), (?, ?)", id, userId, id, body.userId);
    });
    sendToUser(body.userId, { t: "DM_CREATE", d: getDmChannel(id, body.userId)! });
    const mine = getDmChannel(id, userId)!;
    sendToUser(userId, { t: "DM_CREATE", d: mine });
    return mine;
  });
}
