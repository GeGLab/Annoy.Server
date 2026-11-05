#!/bin/sh
# Runs `annoy-admin` inside the annoy-server container that is serving now
# (annoy or annoy-b, see auto-update.sh). Run it on the host, in the folder
# with docker-compose.yml:   ./scripts/annoy-admin.sh invite create --uses 5
set -eu
slot="$(docker compose exec -T proxy cat /control/active 2>/dev/null || true)"
case "$slot" in annoy-b) ;; *) slot=annoy ;; esac
exec docker compose exec "$slot" node_modules/.bin/tsx src/admin-cli.ts "$@"
