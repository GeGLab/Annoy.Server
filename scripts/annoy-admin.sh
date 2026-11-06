#!/bin/sh
# Runs `annoy-admin` inside the annoy-server container that is serving now
# (annoy or annoy-b, see auto-update.sh). Run it on the host, in the folder
# with docker-compose.yml:   ./scripts/annoy-admin.sh invite create --uses 5
# ./scripts/annoy-admin.sh restart applies .env changes without downtime.
set -eu
# Restart without downtime, e.g. after editing .env: the updater starts the
# other slot with the new settings and switches to it once it answers.
if [ "${1:-}" = restart ]; then
  docker compose exec -T updater sh -c 'date -u +%FT%TZ > /control/restart'
  echo "Reinício pedido ao updater. Acompanhe: docker compose logs -f updater"
  exit 0
fi
slot="$(docker compose exec -T proxy cat /control/active 2>/dev/null || true)"
case "$slot" in annoy-b) ;; *) slot=annoy ;; esac
exec docker compose exec "$slot" node_modules/.bin/tsx src/admin-cli.ts "$@"
