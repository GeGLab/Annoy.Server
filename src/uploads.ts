import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.ts";

// Attachment bytes live at <data>/uploads/<attachment id>/blob; the database owns the metadata.
const uploadsDir = join(config.dataDir, "uploads");
const blobPath = (id: string) => join(uploadsDir, id, "blob");

/** Streams `source` into the blob for `id` and returns the stored size. */
export async function writeBlob(id: string, source: Readable): Promise<number> {
  await mkdir(join(uploadsDir, id), { recursive: true });
  await pipeline(source, createWriteStream(blobPath(id)));
  return (await stat(blobPath(id))).size;
}

export const readBlob = (id: string, range?: { start: number; end: number }) => createReadStream(blobPath(id), range);

export async function discardBlobs(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => rm(join(uploadsDir, id), { recursive: true, force: true })));
}
