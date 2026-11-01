import {
  PROFILE_FIELD_KINDS,
  normalizeProfileField,
  type ProfileDetails,
  type ProfileField,
} from "@distopic/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.ts";
import { all, one, run, tx } from "../db.ts";
import { getUser, relationshipStatus } from "../repo.ts";
import { badRequest, notFound } from "../errors.ts";
import { parse, type Params } from "../validate.ts";
import {
  activityHistory,
  deleteActivityHistory,
  historyEnabled,
  invalidateProfile,
} from "../activity-history.ts";

export function profileDetails(
  subject: string,
  viewer: string,
): ProfileDetails {
  const user = getUser(subject);
  if (!user || user.username.startsWith("deleted.")) throw notFound("Perfil");
  const owner = subject === viewer;
  const friends =
    relationshipStatus(viewer, subject) === "friend" &&
    relationshipStatus(subject, viewer) === "friend";
  const community = !!one(
    "SELECT 1 FROM members a JOIN members b ON a.server_id=b.server_id WHERE a.user_id=? AND b.user_id=? LIMIT 1",
    viewer,
    subject,
  );
  const stored = all<ProfileField>(
    "SELECT kind,value,audience FROM profile_fields WHERE user_id=? ORDER BY kind",
    subject,
  );
  const fields = stored.filter(
    (field) =>
      owner ||
      (field.audience === "friends" && friends) ||
      (field.audience === "community" && (friends || community)),
  );
  const enabled = historyEnabled(subject),
    allowed = owner || friends || community;
  return {
    user,
    fields,
    hasPrivateFields: stored.length > fields.length,
    history: {
      enabled,
      visibility: !enabled ? "disabled" : allowed ? "visible" : "private",
      entries: enabled && allowed ? activityHistory(subject) : [],
    },
  };
}
export function profileRoutes(app: FastifyInstance): void {
  app.get<Params<"id">>("/users/:id/profile", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return profileDetails(req.params.id, requireUser(req));
  });
  app.patch("/users/@me/profile", async (req, reply) => {
    const userId = requireUser(req);
    const body = parse(
      z
        .object({
          fields: z
            .array(
              z.object({
                kind: z.enum(PROFILE_FIELD_KINDS),
                value: z.string().max(2048),
                audience: z
                  .enum(["self", "friends", "community"])
                  .default("self"),
              }),
            )
            .max(PROFILE_FIELD_KINDS.length)
            .optional(),
          historyEnabled: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    if (
      body.fields &&
      new Set(body.fields.map((field) => field.kind)).size !==
        body.fields.length
    )
      throw badRequest("Não repita um campo do perfil.");
    let fields: ProfileField[] | undefined;
    try {
      fields = body.fields
        ?.map((field) => ({
          ...field,
          value: normalizeProfileField(field.kind, field.value),
        }))
        .filter((field) => field.value);
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    if (
      fields?.some(
        (field) =>
          field.kind === "email" && !z.email().safeParse(field.value).success,
      )
    )
      throw badRequest("Informe um e-mail válido.");
    tx(() => {
      if (fields) {
        run("DELETE FROM profile_fields WHERE user_id=?", userId);
        for (const field of fields)
          run(
            "INSERT INTO profile_fields(user_id,kind,value,audience) VALUES(?,?,?,?)",
            userId,
            field.kind,
            field.value,
            field.audience,
          );
      }
      if (body.historyEnabled !== undefined) {
        run(
          "INSERT INTO profile_privacy(user_id,history_enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET history_enabled=excluded.history_enabled",
          userId,
          body.historyEnabled ? 1 : 0,
        );
        if (!body.historyEnabled)
          run("DELETE FROM activity_history WHERE user_id=?", userId);
      }
    });
    invalidateProfile(userId);
    reply.header("Cache-Control", "no-store");
    return profileDetails(userId, userId);
  });
  app.delete("/users/@me/activity-history", async (req) => {
    deleteActivityHistory(requireUser(req));
    return {};
  });
}
