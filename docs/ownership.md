# Ownership and server removal

An owner cannot delete a community while it has other members. Offline members
count too. `DELETE /api/servers/:id` checks membership again within the deletion
transaction, so a stale "alone" snapshot cannot bypass the rule. The same guard
applies when the owner uses the instance administration route. Moderation by an
independent instance administrator keeps its existing authorization.

`POST /api/servers/:id/ownership` takes `{ userId }`. Only the current owner can
transfer, and the target must be another existing member with an active account.
Deleted, suspended and unclaimed imported profiles are rejected. The update is
atomic and refreshes the community for all members. The gateway advertises
`READY.d.instance.serverOwnership: true` for compatible clients.

After transfer, the former owner can leave through
`DELETE /api/servers/:id/members/@me`; they cannot delete the community or transfer
it again. An owner who is alone can delete the community. Owners cannot leave a
community orphaned by deleting only their membership.

The desktop client separately permits an owner to forget a saved connection
after seven full days of observed connection failure. Its outage timestamp
survives restarts, is cleared when the gateway responds, and is not started by
a rejected session or a locally offline network. Unknown history starts at the
first observed failure. This exception affects only local shortcuts: an offline
server cannot be contacted to delete its data. Signing out remains a separate
account action and does not change community ownership.

`npm run test:ownership` covers owner/membership guards, offline members, a member
joining after a client snapshot, validated transfers, former-owner permissions,
and the owner attempting deletion through instance administration. Tests use
an isolated SQLite database and Fastify injection, without a live SFU.
