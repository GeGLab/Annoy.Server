# Steam connection and activity

Steam adds to the existing private activity flow. Install the updated server
and client, then open **Settings → Activity → Steam** in the desktop client.
Each Annoy account links independently, including accounts created with Global.
The binding is private to this instance and is not a new Annoy login method.

## Setup

Local detection on Windows and Linux works without credentials or server setup.
Linux supports native and Proton games and reads installed libraries locally.

Linking uses Steam OpenID 2.0 and needs no API key or Steamworks application.
The user signs in on `steamcommunity.com` in their system browser. Set
`ANNOY_PUBLIC_URL=https://your.domain` behind a proxy so Steam can redirect to
`https://your.domain/api/auth/steam/callback`.

For online activity fallback, set `ANNOY_STEAM_API_KEY` to the host's
[Steam Web API key](https://steamcommunity.com/dev/apikey) and restart the server.
Keep the key in the server environment; it is never returned to the client.
Without it, accounts can still link and local detection works. The client shows
whether online activity is available. Activity visibility depends on the user's
Steam privacy settings; hidden games and private profiles may return no game.

## API and behavior

The gateway advertises `READY.d.instance.steamConnection: true`.

- `GET /api/users/@me/steam`: private SteamID/profile link and online availability.
- `POST /api/auth/steam/begin`: authenticated link attempt, browser URL and secret handoff.
- `GET /api/auth/steam/callback`: Steam return; confirms the assertion server to server.
- `POST /api/auth/steam/poll` with `{ handoff }`: authenticated, same-user, one-shot result.
- `DELETE /api/users/@me/steam`: removes the binding and pending attempts.
- `GET /api/users/@me/steam/activity`: authenticated, sanitized current game or empty array.

Attempts expire after ten minutes. The callback checks the issuer, signed
identity and return URL, nonce age, Steam verification and the initiating Annoy
session. A Steam identity can link to only one user on a given instance.
Cancellation, logout, suspension and account deletion invalidate pending links.
Deleting the account erases the SteamID; merging accounts preserves the kept
account's binding or transfers the other binding if none exists.

Online lookup runs only on client requests, with a 25-second cache and bounded
timeouts. The client requests it only while activity sharing is enabled and
no local game is present. A local game always wins. Music and editor activity
remain intact. Fallback is published only on the linked account's instance
using the existing gateway, mutual-friend audience and expiry rules. SteamIDs,
API keys, Steam persona names and profile details are not added to public user
objects or activity payloads. No gameplay history is stored.

## Validation

`npm run test:steam` uses an isolated SQLite database and mocked Steam responses.
It covers authentication, OpenID verification and forgery rejection, replay,
cancellation, session expiry, account conflicts, request coalescing, empty
results, unlink, deletion and merge. Run `npm run test:discovery` to check the
existing gateway audience and expiry behavior. Real Steam authorization and
private/public profile behavior still need manual verification after deployment.

References: [Steam authentication](https://partner.steamgames.com/doc/features/auth#website),
[ISteamUser](https://partner.steamgames.com/doc/webapi/ISteamUser).
