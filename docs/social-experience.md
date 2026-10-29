# Profiles, presence and private calls

These features use additive database migrations and optional protocol fields.
Deploy the server and client updates together. The gateway advertises
`socialProfiles`, `presenceStatus`, `directCalls` and `developmentActivity` in
`READY.d.instance`. New clients identify their per-window `deviceId` and supported
`features`; legacy clients do not receive development activities or idle states
they cannot render.

## Profiles and relationships

- `PATCH /api/users/@me` accepts `bio`, a string of at most 1,000 UTF-16 code units,
  together with existing profile fields. Updates use the existing `USER_UPDATE`
  audience. The client displays a three-line preview.
- `PATCH /api/relationships/:userId/nickname` accepts `{ "nickname": "..." }`, up
  to 64 characters, only for mutual friends. Empty text removes the nickname.
  Both users receive `RELATIONSHIP_UPDATE`; `nickname` is the viewer's choice and
  `nicknameByOther` tells the viewer how that friend named them.
- `presence` gateway operations set idle state per connection. A person stays
  online while any connected session is active. The client defaults to ten
  minutes of system mouse/keyboard inactivity, configurable or disabled.

## Private calls

`POST /api/calls` accepts `{ "userId": "...", "video": true, "deviceId": "..." }`.
Both people must be mutual friends, connected, and free of another private call.
The receiving client must support private calls. Ringing expires after 45 seconds.
The gateway's `call` operation supports `accept`, `reject`, `end` and `signal`.
Only the selected authenticated device can accept/relay active signaling; other
users never receive SDP or ICE data. Unfriend, disconnect and shutdown end calls.
The media travels over a separate WebRTC peer connection, not the room SFU.

For connectivity across restrictive NATs, configure a TURN service using
`ANNOY_CALL_ICE_SERVERS`, a JSON array of WebRTC ICE servers, for example:

```json
[{"urls":"turn:turn.example.com:3478","username":"configured-user","credential":"configured-password"}]
```

Without this setting the client receives a public STUN server. Local WebRTC
tests exercise real audio/video transport using synthetic capture; production
TURN credentials and cross-network connectivity must be verified by the host.

## Room screen sharing and activities

Clients select 480p, 720p, 1080p, 1440p, 2K (2048×1080) or 4K, with 15–120 FPS.
Selected dimensions/FPS constrain capture and bitrate, and `voice_state` carries
`screenQuality` for the participant/stream label. Hardware may capture less than
the selected maximum. Both built-in and Cloudflare backends relay this label.

Development activity uses provider IDs `vscode`, `intellij`, `dbeaver`, `ssms`
and `visual-studio`. Optional `file`, `project` and `language` fields are bounded;
the client obtains them from window titles, without reading source files.
Activity still expires and is visible only to mutual friends. The single sharing
preference controls games, music and development activity together.

Message sound and mute preferences are local client settings; they do not remove
messages, change channel permissions or mute room media.

## Validation

`npm run test:discovery` covers profile limits, nickname visibility, friendship
authorization, call signaling isolation, disconnect cleanup and multi-session
idle behavior, in addition to the existing activity/search checks.
