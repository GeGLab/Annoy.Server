# Profile photos and media playback

Install the updated dependencies with `npm ci` and restart the server using
the existing deployment procedure. No schema migration is required: profile
photos use the existing `users.avatar_url` column. Keep `DISTOPIC_DATA_DIR/avatars` on
persistent storage alongside the database/uploads. Set `DISTOPIC_PUBLIC_URL` to the
externally reachable instance origin when running behind a reverse proxy.

## Profile API

- `POST /api/users/@me/avatar`: authenticated multipart upload, one file, up to
  8 MiB. Content must decode as a static PNG, JPEG or WebP of at most 20 million
  pixels. Sharp strips metadata and writes a 512×512 WebP. Returns the updated
  user and broadcasts `USER_UPDATE` to that user's audience.
- `PATCH /api/users/@me`: accepts `displayName` and/or `avatarUrl: null`. Arbitrary
  avatar URLs are not accepted. Clearing/replacing a photo removes the previous
  generated file; external Discord images are never fetched or deleted.
- `GET /api/avatars/:id.webp`: serves the generated image with immutable caching
  and content-type protection. Avatar URLs are public, like attachment URLs.

The client previews a crop locally and sends it only when the user saves their
settings. A failed request keeps the pending edit available to retry or reset.
Photo removal affects the profile on this instance; it does not modify Discord.

## Media API

The existing upload download route now supports single HTTP byte ranges,
including suffix/open-ended ranges, `206`, `Content-Range`, `Accept-Ranges`
and `416` for unsatisfiable requests. Reverse proxies must forward `Range`
and preserve these response headers for seeking to work. Multi-range requests
are rejected. Format/codec support is determined by the client Electron runtime.

## Validation

```sh
npm run typecheck
npm run test:profile
```

The profile/media tests use temporary SQLite/files and Fastify injection. They
cover authentication, invalid images, re-encoding, replacement/removal, avatar
delivery, full downloads and range responses. They do not start the voice SFU.
