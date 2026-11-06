// Files of the servers' own stickers: stickers/<id>.webp in the data folder.
// Animated input stays animated; everything is fitted into 320×320.
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { config } from "./config.ts";
import { badRequest, notFound } from "./errors.ts";
import { secretId } from "./ids.ts";

const directory = join(config.dataDir, "stickers");
export const STICKER_ID = /^[a-f0-9]{32}$/;
export const MAX_STICKER_BYTES = 8 * 1024 * 1024;
/** Stickers per server unless the server has its own limit (sticker_limit). */
export const DEFAULT_STICKER_LIMIT = 60;

export async function createStickerFile(bytes: Buffer): Promise<string> {
  if (!bytes.length || bytes.length > MAX_STICKER_BYTES) throw badRequest("Envie uma figurinha de até 8 MB.");
  let output: Buffer;
  try {
    const image = sharp(bytes, { limitInputPixels: 20_000_000, animated: true });
    const metadata = await image.metadata();
    if (!metadata.format || !["png", "webp", "gif"].includes(metadata.format) || (metadata.pages ?? 1) > 200 || (metadata.width ?? 0) * (metadata.pageHeight ?? metadata.height ?? 0) * (metadata.pages ?? 1) > 20_000_000)
      throw new Error("Unsupported sticker");
    output = await image.resize(320, 320, { fit: "inside", withoutEnlargement: true }).webp({ quality: 88, loop: 0 }).toBuffer();
  } catch {
    throw badRequest("Figurinha inválida. Use PNG, WebP ou GIF, até 200 quadros e 20 megapixels somados.");
  }
  const id = secretId();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.webp`), output, { flag: "wx" });
  return id;
}

export async function readStickerFile(id: string): Promise<Buffer> {
  if (!STICKER_ID.test(id)) throw notFound("Figurinha");
  try {
    return await readFile(join(directory, `${id}.webp`));
  } catch {
    throw notFound("Figurinha");
  }
}

export async function discardStickerFile(id: string): Promise<void> {
  if (!STICKER_ID.test(id)) return;
  await unlink(join(directory, `${id}.webp`)).catch(() => undefined);
}
