# Social media extensions

Update the client and server together. Migrations are additive: `servers.icon_url` and `message_reactions` are created on startup. Back up the data directory using the normal deployment workflow before upgrading.

- `PUT /api/channels/:id/messages/:messageId/reactions/:emoji` adds an idempotent Unicode reaction for the authenticated user.
- `DELETE` on the same path removes only that user's reaction. Channel visibility and send permission are checked on both operations. At most 20 distinct reaction emojis are allowed. Message payloads include optional `reactions: {emoji, userIds}[]`; updates use `MESSAGE_UPDATE`.
- `POST /api/servers/:id/icon` accepts one multipart image (8 MB), requires MANAGE_SERVER and returns the updated server summary. `PATCH /api/servers/:id` accepts optional name and `iconUrl: null` to remove the image. Local generated media are removed when replaced or deleted.
- Profile and server image uploads accept GIF, PNG, JPEG and WebP; animated input is bounded to 200 frames / 20 million total input pixels, resized to 512px and encoded as looping WebP. Static images remain supported.
- Activity audiences include mutual friends and shared server members. Joining, leaving, kicking and server deletion refresh access, including explicit clear events for former viewers. DMs alone grant no access. Activity still expires after the existing TTL and clears on disconnect.
- `GET /api/media/config` requires authentication, uses Cache-Control: no-store, and returns optional `giphyApiKey` from GIPHY_CLIENT_API_KEY. This is intentionally a browser/client API key, not a confidential service credential. GIPHY calls and media loads happen directly on clients; the server does not scrape, proxy or cache the provider.

READY announces `groupActivity`, `reactions`, `serverIcons` and `gifSearch` capabilities. The client owns its local IndexedDB package library and built-in attributed OpenMoji catalog; installing a package does not publish it to the server.

Validation: `npm run typecheck`, `npm run test:profile`, `npm run test:discovery`, `npm run test:social`.
