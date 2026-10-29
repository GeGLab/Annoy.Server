#!/bin/sh
# Runs inside the "updater" Compose service (profile "autoupdate"). Every few
# hours it pulls the image for ANNOY_VERSION and recreates the server only when
# the image changed. Pinning ANNOY_VERSION=0.4 keeps updates within 0.4.x.
set -u

hours="${ANNOY_UPDATE_INTERVAL_HOURS:-6}"
case "$hours" in '' | *[!0-9]* | 0) echo "ANNOY_UPDATE_INTERVAL_HOURS must be a whole number of hours" >&2; exit 1 ;; esac

# Act on the same Compose project that started this container, so the server
# keeps its volume, network and container name.
project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$(hostname)")" || exit 1
compose() { docker compose --project-name "$project" --project-directory /project "$@"; }

while :; do
  echo "$(date -u '+%F %T') checking for a new server image"
  if compose pull --quiet annoy && compose up --detach --no-deps --no-build annoy; then
    docker image prune --force --filter "label=org.opencontainers.image.source=https://github.com/GeGLab/annoy-server" >/dev/null
  else
    echo "update failed; retrying next cycle" >&2
  fi
  sleep "$((hours * 3600))"
done
