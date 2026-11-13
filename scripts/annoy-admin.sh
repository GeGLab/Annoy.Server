#!/bin/sh
# Runs `annoy-admin` inside the annoy-server container that is serving now
# (annoy or annoy-b, see auto-update.sh). Run it on the host, in the folder
# with docker-compose.yml:   ./scripts/annoy-admin.sh invite create --uses 5
# ./scripts/annoy-admin.sh restart applies .env changes without downtime.
set -eu
# Every maintenance request goes through the verified updater. An occupied
# gateway or unknown/busy updater is a refusal, never a direct Docker restart.
if [ "${1:-}" = restart ] || { [ "${1:-}" = update ] && [ "${2:-}" = apply ]; }; then
  docker compose exec -T proxy node - <<'NODE'
const fs = require('node:fs');
try {
  const dir=process.env.ANNOY_CONTROL_DIR||'/control';
  const state=JSON.parse(fs.readFileSync(dir+'/status.json','utf8'));
  const age=Date.now()-Date.parse(state.heartbeat);
  if(![2,3].includes(state.protocol)||!Number.isFinite(age)||age< -5000||age>60_000||state.updating||['handoff_recovery','migrating_sessions'].includes(state.phase)||(state.protocol===2&&fs.existsSync(dir+'/legacy.json'))||fs.existsSync(dir+'/request')||fs.existsSync(dir+'/restart'))throw Error();
}catch{
  process.stderr.write('Troca suave indisponível: há sessões preservadas, uma operação pendente ou estado não confirmado. Nenhum serviço foi reiniciado.\n');
  process.exitCode=1;
}
NODE
  if [ "$1" = restart ]; then
    docker compose exec -T updater sh -c 'date -u +%FT%TZ > /control/restart'
  else
    docker compose exec -T updater sh -c 'date -u +%FT%TZ > /control/request'
  fi
  echo "Troca suave solicitada. A conclusão depende da confirmação do updater: docker compose logs -f updater"
  exit 0
fi
slot="$(docker compose exec -T proxy cat /control/active 2>/dev/null || true)"
case "$slot" in annoy-b) ;; *) slot=annoy ;; esac
exec docker compose exec "$slot" node_modules/.bin/tsx src/admin-cli.ts "$@"
