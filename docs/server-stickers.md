# Server stickers

Each server has its own sticker pack. Members can send them anywhere (in the
server, in DMs and in other servers); the app shows which server a sticker
comes from.

- Permission `MANAGE_STICKERS` ("Gerenciar figurinhas") adds and removes
  stickers. Owner and administrators have it.
- Limit: 60 per server (`DEFAULT_STICKER_LIMIT` in `src/stickers.ts`). The
  `servers.sticker_limit` column overrides it per server (NULL = default).
- PNG, WebP or GIF up to 8 MB, animated allowed (up to 200 frames, 20
  megapixels in total). Stored as WebP fitted into 320×320 in
  `<data>/stickers/<id>.webp`.

## API

- `GET /api/servers/:id/stickers` (member): `{ stickers: [{ id, name, url }], limit }`.
- `POST /api/servers/:id/stickers` (MANAGE_STICKERS): multipart, field `name`
  (1–32 characters) first, then the image. Returns the list.
- `DELETE /api/servers/:id/stickers/:stickerId` (MANAGE_STICKERS): returns the list.
- `GET /api/stickers/:id.webp` (public): the image.
- `GET /api/sticker-info/:id` (public): `{ id, name, url, server: { id, name, iconUrl } }`.

READY announces `instance.serverStickers`.
