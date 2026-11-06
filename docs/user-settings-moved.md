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
