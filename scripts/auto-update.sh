#!/bin/sh
# Runs inside the "updater" Compose service. The instance admin controls it
# from the app (Administrar instância → Atualizações) through files in
# /control, shared with the server: "auto" (on/off) and "request" (update
# now). It answers with /control/status.json. Pinning ANNOY_VERSION=0.7 keeps
# updates within 0.7.x.
set -u

hours="${ANNOY_UPDATE_INTERVAL_HOURS:-6}"
case "$hours" in '' | *[!0-9]* | 0) echo "ANNOY_UPDATE_INTERVAL_HOURS must be a whole number of hours" >&2; exit 1 ;; esac

# Until the admin chooses in the app: ANNOY_AUTO_UPDATE, or "on" for setups
# that enabled the old COMPOSE_PROFILES=autoupdate.
default_auto="${ANNOY_AUTO_UPDATE:-}"
if [ -z "$default_auto" ]; then
  case ",${COMPOSE_PROFILES:-}," in *,autoupdate,*) default_auto=on ;; *) default_auto=off ;; esac
fi

control="${ANNOY_CONTROL_DIR:-/control}"
mkdir -p "$control"

# Act on the same Compose project that started this container, so the server
# keeps its volume, network and container name.
project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$(hostname)")" || exit 1
compose() { docker compose --project-name "$project" --project-directory /project "$@"; }

auto() {
  value="$(cat "$control/auto" 2>/dev/null)"
  [ "${value:-$default_auto}" = on ]
}

last_check=null
last_error=null
updating=false
write_status() {
  if auto; then a=true; else a=false; fi
  printf '{"heartbeat":"%s","auto":%s,"channel":"%s","intervalHours":%s,"lastCheck":%s,"lastError":%s,"updating":%s}\n' \
    "$(date -u '+%FT%TZ')" "$a" "${ANNOY_VERSION:-latest}" "$hours" "$last_check" "$last_error" "$updating" > "$control/status.json.tmp" &&
    mv "$control/status.json.tmp" "$control/status.json"
}

update() {
  updating=true
  write_status
  echo "$(date -u '+%F %T') checking for a new server image"
  if compose pull --quiet annoy && compose up --detach --no-deps --no-build annoy; then
    docker image prune --force --filter "label=org.opencontainers.image.source=https://github.com/GeGLab/annoy-server" >/dev/null
    last_error=null
  else
    echo "update failed; retrying next cycle" >&2
    last_error='"Não deu para baixar ou reiniciar a nova versão. Veja: docker compose logs updater"'
  fi
  last_check="\"$(date -u '+%FT%TZ')\""
  updating=false
}

next=0
while :; do
  if [ -e "$control/request" ]; then
    rm -f "$control/request"
    update
  elif auto && [ "$(date +%s)" -ge "$next" ]; then
    update
    next=$(($(date +%s) + hours * 3600))
  fi
  write_status
  sleep 10
done
