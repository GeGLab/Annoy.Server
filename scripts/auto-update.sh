#!/bin/sh
# Runs inside the "updater" Compose service. The instance admin controls it
# from the app (Administrar instância → Atualizações) through files in
# /control, shared with the server: "auto" (on/off) and "request" (update
# now). It answers with /control/status.json. Pinning ANNOY_VERSION=0.7 keeps
# updates within 0.7.x.
#
# Updates never stop the server first: the new version starts in the idle
# slot (annoy or annoy-b), /control/active points the proxy at it once it
# answers, and only then the old slot stops.
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
compose() { docker compose --project-name "$project" --project-directory /project --profile standby "$@"; }

active() {
  slot="$(cat "$control/active" 2>/dev/null)"
  case "$slot" in annoy-b) echo annoy-b ;; *) echo annoy ;; esac
}
idle() { [ "$(active)" = annoy ] && echo annoy-b || echo annoy; }
running() { [ -n "$(compose ps --status running --quiet "$1" 2>/dev/null)" ]; }

# Image the slot runs vs. the newest pulled one for ANNOY_VERSION.
current_image() {
  id="$(compose ps --quiet "$1" 2>/dev/null)"
  [ -n "$id" ] && docker inspect --format '{{.Image}}' "$id"
}
pulled_image() { docker image inspect --format '{{.Id}}' "ghcr.io/geglab/annoy-server:${ANNOY_VERSION:-latest}" 2>/dev/null; }

healthy() {
  i=0
  while [ "$i" -lt 90 ]; do
    wget -q -T 2 -O /dev/null "http://$1:8787/api/info" && return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# Only one slot serves; a leftover one (e.g. after `docker compose up -d` by
# hand) would answer nobody but still run background work.
if running "$(active)" && running "$(idle)"; then compose stop "$(idle)"; fi

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

fail() {
  echo "update failed: $1" >&2
  last_error="\"$1 Veja: docker compose logs updater\""
}

update() {
  updating=true
  write_status
  echo "$(date -u '+%F %T') checking for a new server image"
  old="$(active)"
  new="$(idle)"
  if ! compose pull --quiet annoy; then
    fail "Não deu para baixar a nova versão."
  elif [ "$(current_image "$old")" = "$(pulled_image)" ] && running "$old"; then
    last_error=null
  elif ! compose up --detach --no-deps --no-build --force-recreate "$new"; then
    fail "Não deu para iniciar a nova versão."
  elif ! healthy "$new"; then
    compose stop "$new"
    fail "A nova versão não respondeu; o servidor continua na anterior."
  else
    echo "$new" > "$control/active.tmp" && mv "$control/active.tmp" "$control/active"
    # The proxy rereads the file every half second; then the old process
    # tells its clients to reconnect, and they land on the new one.
    sleep 2
    compose stop "$old"
    docker image prune --force --filter "label=org.opencontainers.image.source=https://github.com/GeGLab/annoy-server" >/dev/null
    echo "$(date -u '+%F %T') now serving from $new"
    last_error=null
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
