import type { z } from "zod";
import { badRequest } from "./errors.ts";

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.join(".");
  throw badRequest(path ? `${path}: ${issue?.message}` : (issue?.message ?? "Requisição inválida"));
}

export type Params<K extends string> = { Params: Record<K, string> };
