// Shared wire contract between the Annoy server and client.
// The server is the authority; the client uses the same permission
// computation only to decide which controls to show.

export const PROTOCOL_VERSION = 2;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const Permission = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  MANAGE_MESSAGES: 1 << 2,
  ATTACH_FILES: 1 << 3,
  MENTION_EVERYONE: 1 << 4,
  CONNECT: 1 << 5,
  SPEAK: 1 << 6,
  MUTE_MEMBERS: 1 << 7,
  CREATE_INVITE: 1 << 8,
  KICK_MEMBERS: 1 << 9,
  BAN_MEMBERS: 1 << 10,
  MANAGE_CHANNELS: 1 << 11,
  MANAGE_ROLES: 1 << 12,
  MANAGE_SERVER: 1 << 13,
  ADMINISTRATOR: 1 << 14,
  /** Camera and screen sharing in voice channels. */
  STREAM: 1 << 15,
} as const;

export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS = Object.values(Permission).reduce((a, b) => a | b, 0);

export const DEFAULT_EVERYONE_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.ATTACH_FILES |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.STREAM |
  Permission.CREATE_INVITE;

export const PERMISSION_LABELS: Record<PermissionName, string> = {
  VIEW_CHANNEL: "Ver canais",
  SEND_MESSAGES: "Enviar mensagens",
  MANAGE_MESSAGES: "Gerenciar mensagens",
  ATTACH_FILES: "Anexar arquivos",
  MENTION_EVERYONE: "Mencionar @everyone",
  CONNECT: "Conectar em voz",
  SPEAK: "Falar",
  MUTE_MEMBERS: "Silenciar membros",
  CREATE_INVITE: "Criar convites",
  KICK_MEMBERS: "Expulsar membros",
  BAN_MEMBERS: "Banir membros",
  MANAGE_CHANNELS: "Gerenciar canais",
  MANAGE_ROLES: "Gerenciar cargos",
  MANAGE_SERVER: "Gerenciar servidor",
  ADMINISTRATOR: "Administrador",
  STREAM: "Transmitir câmera e tela",
};

export function has(perms: number, flag: number): boolean {
  return (perms & Permission.ADMINISTRATOR) !== 0 || (perms & flag) === flag;
}

export interface PermissionInput {
  ownerId: string;
  userId: string;
  everyoneRoleId: string;
  roles: ReadonlyArray<Pick<Role, "id" | "permissions">>;
  memberRoleIds: ReadonlyArray<string>;
  overwrites?: ReadonlyArray<Overwrite>;
}

/** Discord-style resolution: owner > admin > base roles > channel overwrites. */
export function computePermissions(input: PermissionInput): number {
  if (input.userId === input.ownerId) return ALL_PERMISSIONS;
  const memberRoles = new Set([input.everyoneRoleId, ...input.memberRoleIds]);
  let perms = 0;
  for (const role of input.roles) if (memberRoles.has(role.id)) perms |= role.permissions;
  if (perms & Permission.ADMINISTRATOR) return ALL_PERMISSIONS;
  const overwrites = input.overwrites ?? [];
  if (overwrites.length === 0) return perms;

  const everyone = overwrites.find((o) => o.targetType === "role" && o.targetId === input.everyoneRoleId);
  if (everyone) perms = (perms & ~everyone.deny) | everyone.allow;

  let allow = 0;
  let deny = 0;
  for (const o of overwrites) {
    if (o.targetType === "role" && o.targetId !== input.everyoneRoleId && memberRoles.has(o.targetId)) {
      allow |= o.allow;
      deny |= o.deny;
    }
  }
  perms = (perms & ~deny) | allow;

  const member = overwrites.find((o) => o.targetType === "member" && o.targetId === input.userId);
  if (member) perms = (perms & ~member.deny) | member.allow;
  return perms;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface User {
  bio?: string;
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Signs in with an Annoy Global account. Only sent for the user's own profile. */
  global?: boolean;
}

export type Presence = "online" | "idle" | "dnd" | "offline";

export interface ServerSummary {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerId: string;
}

export interface ServerSummaryPage {
  servers: ServerSummary[];
  nextCursor: string | null;
  total: number;
}

export type ChannelType = "category" | "text" | "voice" | "dm" | "files" | "code" | "theater" | "song";

/** Channel types people join with voice (theater rooms also stream and watch together). */
export const VOICE_CHANNEL_TYPES: readonly ChannelType[] = ["voice", "theater"];
export const isVoiceChannel = (type: ChannelType) => VOICE_CHANNEL_TYPES.includes(type);
/** Channel types with a message history (a files channel is one where every message carries files). */
export const MESSAGE_CHANNEL_TYPES: readonly ChannelType[] = ["text", "dm", "files", "theater", "song"];
export const hasMessages = (type: ChannelType) => MESSAGE_CHANNEL_TYPES.includes(type);
/** Temporary voice rooms vanish this long after creation if nobody ever joins. */
export const TEMP_ROOM_IDLE_MS = 10 * 60 * 1000;

export interface Overwrite {
  targetId: string;
  targetType: "role" | "member";
  allow: number;
  deny: number;
}

export interface Channel {
  id: string;
  serverId: string | null;
  type: ChannelType;
  name: string;
  topic: string;
  parentId: string | null;
  position: number;
  overwrites: Overwrite[];
  /** Temporary voice room: deleted when everyone leaves, or after 10 minutes if nobody joins. */
  temporary?: boolean;
}

export interface DmChannel {
  id: string;
  recipients: User[];
  lastMessageId: string | null;
}

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  permissions: number;
  position: number;
}

export interface Member {
  user: User;
  nick: string | null;
  roleIds: string[];
  joinedAt: string;
  presence: Presence;
}

export interface Attachment {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  url: string;
}

export interface ChannelFile {
  attachment: Attachment;
  message: Message;
}

export interface ChannelFilePage {
  files: ChannelFile[];
  nextOffset: number | null;
  total: number;
}

export interface Message {
  id: string;
  channelId: string;
  author: User;
  content: string;
  createdAt: string;
  editedAt: string | null;
  replyToId: string | null;
  attachments: Attachment[];
  mentionIds: string[];
  mentionsEveryone: boolean;
  reactions?: { emoji: string; userIds: string[] }[];
}

export interface Invite {
  code: string;
  server: ServerSummary;
  uses: number;
  maxUses: number | null;
  expiresAt: string | null;
  memberCount: number;
}

export type RelationshipStatus = "friend" | "incoming" | "outgoing";

export interface Relationship {
  nickname?: string;
  nicknameByOther?: string;
  user: User;
  status: RelationshipStatus;
}

export interface VoiceState {
  userId: string;
  serverId: string;
  channelId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  speaking: boolean;
  /** Sharing a camera. */
  video: boolean;
  /** Sharing a screen or window. */
  screen: boolean;
  screenQuality?: { height: number; fps: number; width?: number };
}

/** What a producer carries; one camera and one screen per user at most. */
/** "screen_audio" is the sound shared together with a screen (Windows). */
export type MediaSource = "mic" | "camera" | "screen" | "screen_audio";

export interface Ban {
  user: User;
  reason: string;
}

/** Full view of one server for the requesting member. */
export interface ServerState {
  server: ServerSummary;
  channels: Channel[];
  roles: Role[];
  members: Member[];
  membersNextCursor?: string | null;
  membersTotal?: number;
  voiceStates: VoiceState[];
  /** Server-level permissions of the requesting member. */
  permissions: number;
}

export interface MemberPage {
  members: Member[];
  nextCursor: string | null;
  total: number;
}

// ---------------------------------------------------------------------------
// Discord import (official bot API)
// ---------------------------------------------------------------------------

export interface ImportGuild {
  id: string;
  name: string;
  iconUrl: string | null;
}

export interface ImportGuildList {
  bot: { id: string; username: string };
  /** OAuth link that adds the bot with read-only access (view + history). */
  inviteUrl: string;
  guilds: ImportGuild[];
}

export interface ImportRole {
  id: string;
  name: string;
  color: string | null;
  position: number;
  /** Bot/integration roles; usually not worth importing. */
  managed: boolean;
}

export type ImportChannelKind = "category" | "text" | "voice" | "unsupported";

export interface ImportChannel {
  id: string;
  name: string;
  kind: ImportChannelKind;
  /** Discord's own label, e.g. "anúncios" or "fórum", for unsupported kinds. */
  label: string;
  parentId: string | null;
  /** Display order matching the Discord sidebar. */
  order: number;
  overwriteCount: number;
}

export interface ImportStructure {
  guild: ImportGuild;
  roles: ImportRole[];
  channels: ImportChannel[];
}

export type ImportTarget = { kind: "new"; name: string } | { kind: "existing"; serverId: string };

export interface ImportRequest {
  token: string;
  guildId: string;
  target: ImportTarget;
  roleIds: string[];
  /** Channels and categories to recreate. */
  channelIds: string[];
  /** Subset of channelIds whose history is copied. */
  messageChannelIds: string[];
  /** Newest messages per channel; null copies the whole history. */
  messageLimit: number | null;
  attachments: boolean;
  overwrites: boolean;
}

export type ImportPhase = "structure" | "messages" | "done" | "failed" | "cancelled";

export interface ImportJob {
  id: string;
  serverId: string | null;
  guildName: string;
  phase: ImportPhase;
  /** Channel whose history is being copied right now. */
  currentChannel: string | null;
  channelsDone: number;
  channelsTotal: number;
  messagesImported: number;
  attachmentsImported: number;
  warnings: string[];
  error: string | null;
}

export type RegistrationMode = "open" | "invite" | "closed";

export interface InstanceInfo {
  name: string;
  version: string;
  protocol: number;
  /** True when sign-up is possible at all (open, or with an invite). */
  registrationOpen: boolean;
  registration: RegistrationMode;
  /** "Entrar com Discord" (OAuth2) is configured on this instance. */
  discordLogin: boolean;
  /**
   * This server's Annoy Global ID when global accounts can log in here; null
   * when the host turned Global off or it isn't reachable. Older servers omit it.
   */
  globalServerId?: string | null;
}

/** Proof of a global account for one server (Annoy-api-global DESIGN.md). */
export interface GlobalProof {
  /** This account's identity on this server: an Ed25519 public key (JWK "x"). */
  identity: string;
  /** From POST /auth/global/challenge. */
  challenge: string;
  /** Ed25519 signature over "annoy-login:<challenge>", base64url. */
  signature: string;
  /** Blind token from Annoy Global, bound to this server and identity. */
  token: { kid: string; message: string; signature: string };
}

export interface GlobalLogin extends GlobalProof {
  /** First time on this server: the username to create; ignored when the account exists. */
  username?: string;
  displayName?: string;
  inviteCode?: string;
}

export interface DiscordLoginBegin {
  /** Discord's authorize page, opened in the system browser. */
  url: string;
  /** Secret the client polls with; never shown to Discord. */
  handoff: string;
  /** Must be registered under OAuth2 > Redirects in the Discord developer portal. */
  redirectUri: string;
}

export type DiscordLoginPoll =
  | { status: "pending" }
  /** `auth` is null when linking Discord to an account that is already signed in. */
  | { status: "done"; auth: AuthResponse | null; user: User }
  | { status: "error"; message: string };

/** Private connection information: returned only to the account owner. */
export interface SteamConnectionStatus {
  connection: { steamId: string; profileUrl: string } | null;
  onlineActivityAvailable: boolean;
}
export interface SteamLinkBegin { url: string; handoff: string }
export type SteamLinkPoll =
  | { status: "pending" }
  | { status: "done"; connection: NonNullable<SteamConnectionStatus["connection"]> }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Instance administration (the person hosting the instance)
// ---------------------------------------------------------------------------

export interface InstanceSettings {
  registration: RegistrationMode;
  /** null = unlimited */
  maxServersPerUser: number | null;
  maxUploadMb: number;
}

export interface AdminUser {
  user: User;
  createdAt: string;
  isAdmin: boolean;
  bannedAt: string | null;
  banReason: string;
  serverCount: number;
  discordLinked: boolean;
  imported: boolean;
}

export interface AdminServer {
  server: ServerSummary;
  owner: User | null;
  memberCount: number;
  channelCount: number;
  createdAt: string;
}

export interface SignupInvite {
  code: string;
  uses: number;
  maxUses: number | null;
  expiresAt: string | null;
  createdAt: string;
  createdBy: User | null;
}

export interface AdminOverview {
  settings: InstanceSettings;
  userCount: number;
  serverCount: number;
  messageCount: number;
  uploadsBytes: number;
  /** Estimated Cloudflare SFU egress this month; null with the built-in backend. */
  voiceUsage: VoiceUsage | null;
}

/** Server updates, run by the "updater" Compose service next to the server. */
export interface UpdateStatus {
  current: string;
  /** Newest published server release; null when GitHub can't be reached. */
  latest: string | null;
  /** The updater is running and answering; without it, nothing below applies. */
  available: boolean;
  auto: boolean;
  /** Image tag followed (ANNOY_VERSION): "latest", or "0.7" to stay on 0.7.x. */
  channel: string | null;
  intervalHours: number | null;
  lastCheck: string | null;
  lastError: string | null;
  updating: boolean;
}

export interface VoiceUsage {
  /** UTC month, "YYYY-MM". */
  month: string;
  bytes: number;
  /** 0 = no budget. */
  limitBytes: number;
  /** "video_off": cameras and screens are paused; "off": voice is paused too. */
  level: "ok" | "video_off" | "off";
}

// ---------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------

export interface AuthResponse {
  token: string;
  user: User;
}

export interface ApiError {
  error: string;
  message: string;
}

/** Ephemeral, opt-in desktop metadata; sent only to confirmed friends. No paths or tokens. */
export interface UserActivity {
  kind: "game" | "music" | "development";
  provider: "steam" | "spotify" | "apple-music" | "vscode" | "intellij" | "dbeaver" | "ssms" | "visual-studio";
  name: string;
  artist?: string;
  album?: string;
  appId?: string;
  startedAt?: number;
  /** Small JPEG thumbnail, or an official Steam artwork URL. Ephemeral, like activity. */
  artwork?: string;
  file?: string;
  project?: string;
  language?: string;
}
export interface MessageSearchPage {
  items: { message: Message; channelName: string; serverId: string | null }[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export type VoiceMethod =
  | "join"
  | "createTransport"
  | "connectTransport"
  | "produce"
  | "consume"
  | "resumeConsumer"
  | "getProducers"
  | "closeProducer"
  // Cloudflare Realtime SFU backend (WebRTC negotiated through this server):
  | "publish"
  | "subscribe"
  | "renegotiate"
  /** Takes back a Cloudflare session after a reconnect or a server restart, without renegotiating media. */
  | "resume"
  | "leave";

/** Where voice media flows: the built-in mediasoup SFU, or Cloudflare's Realtime SFU (works behind CGNAT). */
export type VoiceBackend = "builtin" | "cloudflare";

export interface DirectCall { callerDeviceId?: string; calleeDeviceId?: string; id: string; callerId: string; calleeId: string; video: boolean; status: "ringing" | "active" | "ended"; reason?: string; iceServers?: { urls: string | string[]; username?: string; credential?: string }[] }

export type ClientOp =
  | { op: "identify"; features?: string[]; deviceId?: string; token: string; presence?: Presence }
  | { op: "heartbeat" }
  | { op: "presence"; idle: boolean; status?: Presence }
  | { op: "call"; deviceId: string; callId: string; action: "accept" | "reject" | "end" | "signal"; signal?: { description?: { type: "offer" | "answer"; sdp: string }; candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } } }
  | { op: "activity"; activities: UserActivity[] }
  | { op: "typing"; channelId: string }
  | { op: "voice_state"; selfMute: boolean; selfDeaf: boolean; screenQuality?: { height: number; fps: number; width?: number } }
  /** Client-measured speaking state; only used where the SFU can't measure levels (Cloudflare). */
  | { op: "speaking"; speaking: boolean }
  | { op: "voice"; id: number; method: VoiceMethod; data: Record<string, unknown> };

export type GatewayEvent =
  | {
      t: "READY";
      d: {
        user: User;
        servers: ServerSummary[];
        dms: DmChannel[];
        relationships: Relationship[];
        presences: Record<string, Presence>;
        activities?: Record<string, UserActivity[]>;
        instance: { isAdmin: boolean; registration: RegistrationMode; voiceBackend: VoiceBackend; activityArtwork?: boolean; steamConnection?: boolean; serverOwnership?: boolean; developmentActivity?: boolean; directCalls?: boolean; socialProfiles?: boolean; groupActivity?: boolean; reactions?: boolean; serverIcons?: boolean; gifSearch?: boolean; presenceStatus?: boolean; manualPresence?: boolean; channelTypes?: boolean; codeChannels?: boolean };
      };
    }
  | { t: "HEARTBEAT_ACK"; d: null }
  | { t: "SERVER_CREATE"; d: ServerSummary }
  | { t: "SERVER_UPDATE"; d: ServerSummary }
  | { t: "SERVER_REMOVE"; d: { serverId: string } }
  /** Structure, roles or permissions changed: refetch GET /servers/:id. */
  | { t: "SERVER_REFRESH"; d: { serverId: string } }
  | { t: "MESSAGE_CREATE"; d: Message }
  | { t: "MESSAGE_UPDATE"; d: Message }
  | { t: "MESSAGE_DELETE"; d: { channelId: string; messageId: string } }
  | { t: "TYPING_START"; d: { channelId: string; userId: string } }
  | { t: "PRESENCE_UPDATE"; d: { userId: string; presence: Presence } }
  | { t: "ACTIVITY_UPDATE"; d: { userId: string; activities: UserActivity[] } }
  | { t: "USER_UPDATE"; d: User }
  | { t: "VOICE_STATE_UPDATE"; d: { userId: string; serverId: string; state: VoiceState | null } }
  | { t: "VOICE_NEW_PRODUCER"; d: { channelId: string; producerId: string; userId: string; kind: "audio" | "video"; source: MediaSource } }
  | { t: "VOICE_PRODUCER_CLOSED"; d: { producerId: string } }
  | { t: "VOICE_KICKED"; d: { reason: string } }
  | { t: "VOICE_REPLY"; d: { id: number; ok: true; data: unknown } | { id: number; ok: false; message: string } }
  | { t: "DM_CREATE"; d: DmChannel }
  | { t: "CALL_UPDATE"; d: DirectCall }
  | { t: "CALL_SIGNAL"; d: { callId: string; signal: { description?: { type: "offer" | "answer"; sdp: string }; candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } } } }
  | { t: "RELATIONSHIP_UPDATE"; d: Relationship }
  | { t: "RELATIONSHIP_REMOVE"; d: { userId: string } }
  | { t: "INVALID_SESSION"; d: { reason: string } }
  | { t: "IMPORT_PROGRESS"; d: ImportJob }
  | { t: "PLAYBACK_UPDATE"; d: PlaybackState }
  /** A code channel's files (`paths`) or Git state changed. */
  | { t: "CODE_UPDATE"; d: { channelId: string; repo: CodeRepo; paths: string[]; by: string | null } };

// ---------------------------------------------------------------------------
// Theater and song rooms: one shared, synced playback per channel
// ---------------------------------------------------------------------------

/** "file" is an upload to this server, "direct" a media URL, "youtube" and "site" play in an embedded page. */
export type PlaybackKind = "file" | "direct" | "youtube" | "site";

export interface PlaybackItem {
  id: string;
  url: string;
  title: string;
  kind: PlaybackKind;
  addedBy: string;
  addedAt: string;
}

export interface PlaybackState {
  channelId: string;
  queue: PlaybackItem[];
  currentId: string | null;
  paused: boolean;
  /** Seconds into the current item at `updatedAt`; while playing, add the time elapsed since. */
  position: number;
  /** Server clock (ms since epoch) when `position` was taken. */
  updatedAt: number;
  /** Server clock when this state was sent, to correct for the viewer's clock offset. */
  serverTime: number;
  /** Advance to the next item when the current one ends. */
  autoplay: boolean;
}

export type PlaybackAction =
  | { op: "add"; url: string; title?: string; uploadId?: string }
  | { op: "remove"; itemId: string }
  | { op: "play"; itemId?: string }
  | { op: "pause"; position: number }
  | { op: "seek"; position: number }
  | { op: "next" }
  | { op: "ended"; itemId: string }
  | { op: "move"; itemId: string; index: number }
  | { op: "autoplay"; value: boolean };

/** Where the current item should be right now, in seconds. */
export function playbackPosition(state: PlaybackState, clockOffsetMs = 0): number {
  if (state.paused || !state.currentId) return state.position;
  return state.position + Math.max(0, Date.now() + clockOffsetMs - state.updatedAt) / 1000;
}

// ---------------------------------------------------------------------------
// Code channels: a server-side working copy of an external Git repository
// ---------------------------------------------------------------------------

export interface CodeRepo {
  channelId: string;
  /** Remote URL (https only, never a host on this server's network); null until someone links one. */
  url: string | null;
  status: "empty" | "cloning" | "ready" | "error";
  error: string | null;
  branch: string | null;
  head: string | null;
}

export interface CodeEntry {
  path: string;
  type: "file" | "dir";
  size: number;
}

export interface CodeFile {
  path: string;
  content: string;
  /** Hash of `content`; send it back when saving so concurrent edits are detected. */
  hash: string;
  binary: boolean;
}

export interface CodeStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Two-letter `git status --porcelain` codes, e.g. " M", "??", "A ". */
  files: { path: string; code: string }[];
  branches: string[];
  log: { hash: string; subject: string; author: string; date: string }[];
}

export type GatewayEventType = GatewayEvent["t"];
export type GatewayEventOf<T extends GatewayEventType> = Extract<GatewayEvent, { t: T }>;

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

const USER_MENTION = /<@([0-9a-z]+)>/g;

export function parseMentions(content: string): { userIds: string[]; everyone: boolean } {
  const ids = new Set<string>();
  for (const m of content.matchAll(USER_MENTION)) if (m[1]) ids.add(m[1]);
  return { userIds: [...ids], everyone: /(^|\s)@(everyone|here)\b/.test(content) };
}

export const LIMITS = {
  usernameMin: 2,
  usernameMax: 32,
  passwordMin: 8,
  messageMax: 4000,
  nameMax: 100,
  topicMax: 1024,
  attachmentsPerMessage: 10,
} as const;
