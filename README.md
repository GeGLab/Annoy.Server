<div align="center">

# Annoy Server

**Self-hosted voice and text chat. Host it like TeamSpeak, use it like Discord.**

[![License: MIT](https://img.shields.io/badge/license-MIT-7b61ff.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Docker](https://img.shields.io/badge/docker-ready-2496ed?logo=docker&logoColor=white)

**English** · [Português (Brasil)](README.pt-BR.md)

[Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration) · [Discord integration](#discord-integration) · [API](#architecture) · [Client](https://github.com/GeGLab/annoy-client)

<img src="docs/screenshots/chat-and-voice.png" alt="Annoy: text channels, voice channel with connected members, member list with roles" width="860">

<sub>Screenshots show the English labels planned for localization; the current client UI is in Portuguese (pt-BR).</sub>

</div>

## Why Annoy?

Your community's chat should run on hardware you control. Annoy is a single
process you start on a home server, VPS or Raspberry-class machine. It has no
cloud account, telemetry or external database. You point the
[desktop client](https://github.com/GeGLab/annoy-client) at its
address and get the features people expect from Discord: servers, channels,
roles, voice, DMs and friends.

The client keeps the **official Discord one click away**, so you can move your
community gradually instead of all at once.

## Features

| Area | What you get |
| --- | --- |
| **Text** | Servers, categories, text channels, paginated history, edit/delete, replies, `@user` / `@everyone` mentions, Markdown, file attachments, typing indicators |
| **Voice and video** | Voice channels over WebRTC with camera and screen sharing, voice activity or push-to-talk, speaking indicators, server mute and disconnect. Built-in [mediasoup](https://mediasoup.org) SFU, or Cloudflare Realtime SFU for hosts behind CGNAT |
| **Instance admin** | Open, invite-only or closed sign-up, sign-up invites, account suspension and deletion, server removal, limits |
| **Permissions** | Role hierarchy, 15 permissions, per-channel allow/inherit/deny overwrites for roles and members, invites with expiry and use limits, kick and ban |
| **Social** | Friends (requests and accept), presence, direct messages |
| **Discord import** | Copy channels, categories, roles, permission overwrites and message history (with attachments) from a Discord server. You choose exactly what comes over |
| **Sign in with Discord** | Official OAuth2 (`identify`), pulling username, display name and avatar. Imported message authors are claimed automatically |
| **Ops** | One process, SQLite storage, single UDP/TCP media port, Docker image, no external services |

## Quick start

> **Only the host runs this.** One person sets up the server, once. Everyone
> else just installs the [client](https://github.com/GeGLab/annoy-client)
> and joins with the server address and an invite code, like a TeamSpeak server.

### Docker (recommended)

```bash
git clone https://github.com/GeGLab/annoy-server.git
cd annoy-server
cp .env.example .env   # set ANNOY_ANNOUNCED_IP to your public IP (and LAN IP)
docker compose up -d
```

This pulls the published image `ghcr.io/geglab/annoy-server`. Pin a
version with `ANNOY_VERSION=0.4.3`, or build from source with
`docker compose up -d --build`. Without Compose:

```bash
docker run -d --name annoy --restart unless-stopped \
  -p 8787:8787 -p 40000:40000/udp -p 40000:40000/tcp \
  -e ANNOY_ANNOUNCED_IP=203.0.113.10 -v annoy-data:/data \
  ghcr.io/geglab/annoy-server:latest
```

**Automatic updates (optional):** add `COMPOSE_PROFILES=autoupdate` to `.env`
and run `docker compose up -d`. A small `updater` container then checks every
6 hours (`ANNOY_UPDATE_INTERVAL_HOURS`) and restarts the server on the newest
image of `ANNOY_VERSION`: `latest` follows every release, `0.4` only takes
0.4.x fixes. It needs access to the Docker socket to recreate the container.

Replace `203.0.113.10` with the address clients use to reach the machine: your
LAN IP for home use, or the public IP on the internet. Open these ports:

| Port | Protocol | Purpose |
| --- | --- | --- |
| `8787` | TCP | REST API and WebSocket gateway |
| `40000` | **UDP and TCP** | Voice media |

**Upgrading from Distopic (0.2):** the project is now Annoy. Settings were
renamed from `DISTOPIC_*` to `ANNOY_*`; the old names keep working. Data stays
in the same volume. Point the remote at the new repository and remove the old
container:

```bash
git remote set-url origin https://github.com/GeGLab/annoy-server.git
git pull && docker compose pull && docker compose up -d --remove-orphans
```

### From source

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev      # watch mode
npm start        # production
```

Then open the [Annoy client](https://github.com/GeGLab/annoy-client),
choose **Conectar a um servidor Annoy** (Connect to an Annoy server), type the address (port `8787` is the
default) and create an account. The first person creates a server and shares
an invite.

## Configuration

All settings are environment variables. See [`.env.example`](.env.example).

| Variable | Default | Description |
| --- | --- | --- |
| `ANNOY_NAME` | `Annoy` | Instance name shown in the client |
| `ANNOY_HOST` | `0.0.0.0` | Bind address |
| `ANNOY_PORT` | `8787` | API and gateway port |
| `ANNOY_VOICE_PORT` | `40000` | Voice media port (UDP and TCP) |
| `ANNOY_ANNOUNCED_IP` | default-route IP | Voice addresses for clients, comma-separated: **public IP first, LAN IP second** (each gets its own port: 40000, 40001…). Required in Docker |
| `ANNOY_VOICE_BACKEND` | `builtin` | `cloudflare` routes voice and video through Cloudflare Realtime SFU (for CGNAT, see below) |
| `ANNOY_CF_SFU_APP_ID` / `_TOKEN` | (empty) | Cloudflare Realtime SFU app credentials, used with `ANNOY_VOICE_BACKEND=cloudflare` |
| `ANNOY_REGISTRATION` | `invite` | Initial sign-up mode: `open`, `invite` or `closed`. The admin can change it in the app |
| `ANNOY_ADMIN` | (empty) | Username that is always an instance admin. Otherwise the first account is |
| `ANNOY_MAX_SERVERS_PER_USER` | unlimited | Initial limit of servers per account (admin-editable) |
| `ANNOY_MAX_UPLOAD_MB` | `25` | Initial maximum size per attachment (admin-editable) |
| `ANNOY_DISCORD_CLIENT_ID` | (empty) | Enables "Sign in with Discord" (with the secret) |
| `ANNOY_DISCORD_CLIENT_SECRET` | (empty) | Discord OAuth2 client secret |
| `ANNOY_PUBLIC_URL` | request origin | Public origin for OAuth redirects behind a proxy |

The API speaks plain HTTP. For internet exposure, put a TLS reverse proxy (Caddy,
nginx, Cloudflare Tunnel) in front of port `8787` and connect with
`https://your.domain`. Voice media is already encrypted (DTLS-SRTP).

**Backups:** copy `ANNOY_DATA_DIR`. It holds `distopic.db` (SQLite, WAL mode) and
`uploads/`.

## Instance administration

Whoever hosts the instance administers it: the account named in
`ANNOY_ADMIN`, or else the first account created. In the client, open
**Settings → your account → Administrar instância** to:

- choose how new accounts are created: **open**, **invite only** (default) or **closed**
- generate and revoke sign-up invites (people type the code on the sign-up screen)
- suspend, reactivate or delete accounts, promote other admins
- list and delete any server, and set limits (servers per account, attachment size)

Privacy defaults: request logs never store client IP addresses, and every user
can delete their own account (optionally with all their messages).

**About data protection:** the person hosting an instance is responsible for
the data on it, not the authors of this software. A private instance for
friends, with no commercial purpose, is the simplest case. Opening one to the
public brings legal duties (in Brazil, the LGPD).

## Voice behind CGNAT

Text and the API work through any HTTP proxy or tunnel, but voice and video
use WebRTC, which needs a reachable UDP/TCP port. Pick one:

- **Public IP, or a LAN only:** set `ANNOY_ANNOUNCED_IP=<public>,<lan>` and
  forward port `40000` (UDP and TCP) to the host. Friends outside use the
  public address, people at home use the LAN one.
- **CGNAT or no port forwarding (e.g. behind a Cloudflare Tunnel):** use
  Cloudflare Realtime SFU. Create an app in the Cloudflare dashboard under
  **Realtime → SFU**, then set:

  ```bash
  ANNOY_VOICE_BACKEND=cloudflare
  ANNOY_CF_SFU_APP_ID=<app id>
  ANNOY_CF_SFU_APP_TOKEN=<app token>
  ```

  Media then flows between each client and Cloudflare. This server still
  decides who may speak, stream and receive each track; the token never leaves
  it. Check Cloudflare's pricing page for the current free allowance.

  Cloudflare has no spending cap, so the server keeps its own monthly budget
  (`ANNOY_CF_SFU_MONTHLY_GB`, default `1000`; `0` turns it off). It
  estimates egress from the tracks each client receives, at their full
  bitrate. At 80% it pauses cameras and screen shares, at 95% it pauses voice
  until the next month. The instance admin panel shows the month's usage.

## Discord integration

Annoy never uses your personal Discord session. Both features below use
Discord's **official, documented APIs**, so they don't put accounts at risk.

### Importing a Discord server

<img src="docs/screenshots/discord-import.png" alt="Import wizard: pick channels, history, roles and options" width="720">

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application and open **Bot**. Enable **Message Content Intent**,
   then copy the token.
2. In the client, open **+ → Importar do Discord** (the UI is in Portuguese for now) and paste the token. The wizard gives
   you an invite link that adds the bot with read-only access (View Channels and
   Read Message History).
3. Pick the server, then choose the channels, which of them keep their history,
   how many messages to copy (100, 1k, 10k or everything), roles, per-channel
   permissions and attachments. Import into a new server or one you own.

What is preserved: channel order and categories, role names, colours and
hierarchy, permission mapping, message dates, replies, and mentions rendered as
text. Each message author becomes an *imported profile* (name and avatar, no
login).

What is not: Discord members don't become accounts, so member-specific
overwrites and DMs are skipped. Forums, threads, custom emoji and stickers are
not imported. The bot token is used only during the import and is never stored.

### Sign in with Discord

1. Use the same Developer Portal application. Under **OAuth2 → Redirects**, add
   `https://your.domain/api/auth/discord/callback`, matching the address clients
   connect to.
2. Set `ANNOY_DISCORD_CLIENT_ID` and `ANNOY_DISCORD_CLIENT_SECRET`.

Users get a **Sign in with Discord** button. Existing accounts can link Discord
in Settings, which also refreshes their name and avatar later. If someone's
messages were imported earlier, signing in makes those messages theirs.

## Architecture

```
packages/protocol   wire contract shared with the client: entities, gateway events, permissions
src/
  index.ts          Fastify bootstrap: REST under /api, WebSocket gateway at /gateway
  db.ts             SQLite schema (node:sqlite) and additive migrations
  perms.ts          permission resolution and role hierarchy (the authority)
  events.ts         connection registry and permission-aware event fan-out
  voice.ts          mediasoup SFU: one router per voice channel, single WebRTC port
  routes/           auth, servers, channels/messages, social, import, Discord auth
  discord/          Discord adapters: REST client, importer, OAuth2
```

The server is the single authority for permissions. The client runs the same
`computePermissions` from `packages/protocol`, but only to decide which controls
to show. The protocol package is owned by this repository. The client vendors a
copy and syncs it with `npm run sync:protocol`.

## Roadmap

- [ ] English UI and localization in the client
- [ ] Global push-to-talk hotkey in the client
- [x] Custom profile avatars ([API and deployment](docs/profile-media.md))
- [ ] Custom server icons
- [ ] API rate limiting
- [ ] Packaged client builds (AppImage, Windows, macOS)

## Contributing

Issues and pull requests are welcome. Before opening a PR, run:

```bash
npm run typecheck
```

Please describe behaviour changes and how you tested them, including real voice
tests when you touch `voice.ts`.

## License

[MIT](LICENSE) © Gustavo Cruz
