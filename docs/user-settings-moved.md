# User settings live in the Annoy account

With Annoy accounts (`ANNOY_ACCOUNT_MODE=global`) a server owns only server
things: channels, chat, voice, roles, limits, stickers and the server nickname.
Everything about the person belongs to the Annoy account (usersannoy):

- name, bio and photo: the app copies the Annoy profile to the server
  (`PATCH /api/users/@me`, `POST /api/users/@me/avatar`) so members see it;
- profile contacts and who sees them, activity history, Steam link and extra
  sign-in methods (Discord): the routes answer `410 moved_to_annoy`.

On the first start in global mode the server deletes the Steam links, profile
contacts, privacy choices, activity history and Discord links it held
(`retireServerUserSettings` in `src/social-moved.ts`, marker
`instance_settings.profile.movedToAnnoy`). Sessions are not touched.

READY announces `steamConnection` and `profileDetails` only in local mode.

## Members and account deletion

- `src/annoy-members.ts` sends the Global every server here with its owner,
  member count and members by Annoy ID (`PUT /v1/servers/self/members`), 10 s
  after a change and with the hourly Global check. The Annoy account uses it for
  "friends and communities in common" contacts and to require a transfer before
  deleting an account that owns servers with other members.
- Each hourly check reads `GET /v1/servers/self/deletions`: for a deleted Annoy
  account, servers where it is the only member are deleted, it leaves every
  other server, its messages stay with the author "Usuário desconhecido"
  (`unknown-user`), and its user row goes.
- "Sair do servidor" keeps the person's messages in that server, with the author
  "Usuário desconhecido".
