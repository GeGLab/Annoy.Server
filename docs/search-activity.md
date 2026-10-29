# Message search and private activity

Install updated dependencies and restart both server and client. The protocol
source remains owned by this repository; sync it into the client using
`npm run sync:protocol -- <server>/packages/protocol/src`.

## Search

`GET /api/search/messages` requires bearer authentication. Parameters:

| Parameter | Meaning |
|---|---|
| `q` | Up to 200 characters; Unicode words, accent-insensitive prefix matching |
| `serverId` | Restrict to one server; caller must be a member |
| `channelId` | Restrict to one channel; caller must have VIEW_CHANNEL |
| `authorId` | Restrict author |
| `has` | `image`, `video`, `audio`, `file`, or `link` |
| `before`, `after` | ISO date; before is exclusive, after inclusive |
| `cursor` | Last message ID from previous page |

At least text or a substantive filter is required. Results contain at most 25
`{ message, channelName, serverId }` items and a nullable `nextCursor`. All
candidate channels are filtered through current membership/DM recipients and
VIEW_CHANNEL before searching. Filters never bypass that restriction. Hidden
channels return 404 when explicitly targeted.

The startup migration creates an external-content FTS5 table, indexes existing
messages once, and registers insert/update/delete triggers. Keep the database
in persistent storage. No separate search service is required.

`GET /api/channels/:id/messages?around=:messageId` returns the target with up to
25 messages on each side. Both channel access and target membership in that
channel are checked. This powers navigation from a result into its context.

## Activity

Authenticated gateway clients send `{ op: "activity", activities: [...] }`.
Payloads have at most one game and one music item. Allowed properties are:
`kind`, `provider`, `name`, optional `artist`, `album`, `appId`, `startedAt`.
Game requires `provider: "steam"` and a numeric app ID. Music accepts `spotify`
or `apple-music`. Strings and timestamps are bounded; unknown properties are
rejected. There is a per-connection update budget. Treat metadata as a user's
reported activity, not proof of ownership/gameplay.

`READY.d.activities` and `ACTIVITY_UPDATE` contain only the authenticated user's
own activity and activity from **mutual confirmed friends**. Server membership,
DM participation, instance administrator status and pending friend requests
grant no activity access. Activity is not added to public user/member responses.

State is per authenticated connection, kept only in memory. Empty updates clear
that connection; another opted-in device may still report activity. Latest
nonempty source wins. Clients renew every 25 seconds; entries expire after 75
seconds and are removed on the next 30-second gateway sweep. Disconnect clears
immediately. Friendship removal clears both viewers; acceptance sends relationship
events before activity so clients can authorize rendering. Account deletion or
suspension clears activity before removing relationships/sessions.

## Tests

`npm run test:discovery` covers authenticated search, hidden channels, filters,
accent handling and index synchronization, plus actual local TCP/WebSocket
delivery to friends, denial to shared-server strangers, unfriend, reaccept and
disconnect. It uses isolated temporary data and does not start the voice SFU.
