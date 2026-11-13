# Releases


- Releases must be automatic and only AFTER the delivery PR is merged into the default main/master branch and its merged source passes CI. Never publish an open PR or reuse a published release branch for new work.

# Maintenance

- User requirement: every managed restart, update, configuration application or replacement must preserve active sessions through the verified handoff. Never fall back to stopping/recreating a live traffic container or proxy.
- If a safe handoff cannot be confirmed, reject the maintenance request and preserve the running processes. Restore/migration requires an already offline instance and an exclusive data lock; never take users offline implicitly.
- Keep intentional full shutdown separate from maintenance, with an explicit shutdown confirmation. Direct per-service traffic stops are not a maintenance API.
