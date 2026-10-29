import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { config } from "./config.ts";
import { badRequest, notFound } from "./errors.ts";
import { secretId } from "./ids.ts";

const directory = join(config.dataDir, "avatars");
const AVATAR_ID = /^[a-f0-9]{32}$/;
export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
export async function createAvatar(bytes: Buffer): Promise<string> {
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES) throw badRequest("Envie uma foto de até 8 MB.");
  let output: Buffer;
  try {
    const image = sharp(bytes, { limitInputPixels: 20_000_000, animated: false });
    const metadata = await image.metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages ?? 1) > 1)
      throw new Error("Unsupported avatar");
    output = await image.rotate().resize(512, 512, { fit: "cover" }).webp({ quality: 88 }).toBuffer();
  } catch {
    throw badRequest("Foto inválida. Use uma imagem estática PNG, JPEG ou WebP de até 20 megapixels.");
  }
  const id = secretId();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.webp`), output, { flag: "wx" });
  return `/api/avatars/${id}.webp`;
}
export async function readAvatar(id: string): Promise<Buffer> {
  if (!AVATAR_ID.test(id)) throw notFound("Foto");
  try {
    return await readFile(join(directory, `${id}.webp`));
  } catch {
    throw notFound("Foto");
  }
}
/** Only remove a generated local filename; never fetch/delete an external avatar. */
export async function discardAvatar(url: string | null | undefined): Promise<void> {
  if (!url) return;
  let path: string;
  try {
    path = new URL(url, "http://local").pathname;
  } catch {
    return;
  }
  const match = /^\/api\/avatars\/([a-f0-9]{32})\.webp$/.exec(path);
  if (!match) return;
  try {
    await unlink(join(directory, `${match[1]}.webp`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
