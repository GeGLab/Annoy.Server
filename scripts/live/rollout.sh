# Sourced by auto-update.sh. No Docker stop/recreate is allowed until the
# session controller confirms that the slot no longer owns any connection.
live_bundle_setup() {
  live_hash="$(cat /project/scripts/live/* | sha256sum | cut -d ' ' -f 1)" || return 1
  live_bundle="/tmp/annoy-live-$live_hash"
  mkdir -p "$live_bundle" || return 1
  cp /project/scripts/live/* "$live_bundle/" || return 1
  control_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/control"}}{{.Name}}{{end}}{{end}}' "$(hostname)")" || return 1
  data_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$(compose ps --quiet "$old")")" || return 1
  [ -n "$control_volume" ] && [ -n "$data_volume" ]
}
live_install() {
  live_slot="$1"; live_mode="${2:-server}"
  live_id="$(compose ps --quiet "$live_slot")" || return 1
  [ -n "$live_id" ] || return 1
  live_native="$(docker exec "$live_id" node -p 'require("./package.json").annoyLiveMigration||0')" || return 1
  if [ "$live_native" = 1 ]; then return 0; fi
  live_digest="$(docker inspect --format '{{.Image}}' "$live_id")" || return 1
  # Compatibility is limited to the exact images validated in isolation.
  case "$live_mode:$live_digest" in
    server:sha256:d6b4fe304cba5cebfa26ea298d75f69bf848fdc4785f14e7e633d75638365346|server:sha256:f7a2dc2bf1fa530573e8a6e9a0ebb7cab8f273b1c64ceb8dd45d92a6f9990a62|proxy:sha256:d6b4fe304cba5cebfa26ea298d75f69bf848fdc4785f14e7e633d75638365346) ;;
    *) echo 'Unverified compatibility image; serving processes preserved' >&2; return 1 ;;
  esac
  docker exec "$live_id" mkdir -p "$live_bundle" || return 1
  docker cp "$live_bundle"/. "$live_id":"$live_bundle"/ || return 1
  docker exec "$live_id" node "$live_bundle/install.cjs" "$live_mode" "$live_bundle"
}
live_probe() {
  live_probe_id="$(compose ps --quiet "$1")" || return 1
  live_probe_method="${2:-status}"
  if docker exec "$live_probe_id" node -p 'require("./package.json").annoyLiveMigration||0' | grep -qx 1; then
    docker exec "$live_probe_id" node /app/scripts/live/probe.cjs "$live_probe_method"
  else docker exec "$live_probe_id" node "$live_bundle/probe.cjs" "$live_probe_method"; fi
}
live_empty() {
  live_state="$(live_probe "$1")" || return 1
  printf '%s' "$live_state" | grep -q '"connections":0' || return 1
  printf '%s' "$live_state" | grep -q '"voices":0' || return 1
  live_http="$(live_probe "$1" idle-http)" || return 1
  printf '%s' "$live_http" | grep -q '"pending":0'
}
live_move() {
  live_source="$1"; live_target="$2"; live_relay="${3:-}"
  live_install "$live_source" && live_install "$live_target" || return 1
  phase=migrating_sessions; write_status
  docker run --rm --network none --user 1000 \
    --mount "type=volume,src=$control_volume,dst=/control" \
    --mount "type=volume,src=$data_volume,dst=/data,readonly" \
    --entrypoint node "$image" /app/scripts/live/move.mjs "$live_source" "$live_target" "$live_relay" &
  live_move_pid=$!
  while kill -0 "$live_move_pid" 2>/dev/null; do write_status; sleep 1; done
  wait "$live_move_pid" || return 1
  live_empty "$live_source"
}
live_recreate_empty() {
  recreate_slot="$1"
  # A stopped standby has no process to query. A running one must prove empty.
  if running "$recreate_slot"; then live_empty "$recreate_slot" || return 1; fi
  phase=starting; write_status
  compose up --detach --no-deps --no-build --force-recreate "$recreate_slot" || return 1
  phase=checking; write_status
  healthy "$recreate_slot" "$expected"
}
rolling_live() {
  old="$(active)" || return 1
  live_bundle_setup && live_install proxy proxy || return 1
  if [ -e "$control/migration.json" ] && ! grep -Eq '"phase":"(done|rolled_back)"' "$control/migration.json"; then
    docker run --rm --network none --user 1000 \
      --mount "type=volume,src=$control_volume,dst=/control" \
      --mount "type=volume,src=$data_volume,dst=/data,readonly" \
      --entrypoint node "$image" /app/scripts/live/move.mjs recover || return 1
    old="$(active)" || return 1
  fi
  # Finish the actual gateway move first, rather than waiting for users to go
  # away. This also bootstraps the already deployed API/gateway split.
  if [ -e "$control/legacy.json" ]; then
    legacy_source="$(cat "$control/legacy-slot" 2>/dev/null || true)"
    case "$legacy_source" in annoy|annoy-b) ;; *) return 1 ;; esac
    [ "$legacy_source" != "$old" ] || return 1
    live_move "$legacy_source" "$old" "$old" || return 1
    rm -f "$control/legacy-slot"
  fi
  [ "$old" = annoy ] && new=annoy-b || new=annoy
  # Both slots remain healthy at the target release when the job completes.
  live_install "$old" || return 1
  live_recreate_empty "$new" || return 1
  live_move "$old" "$new" || return 1
  live_recreate_empty "$old" || return 1
  probe "$new" health "$expected" >/dev/null && probe "$old" health "$expected" >/dev/null || return 1
  current_version="\"$expected\""; target_version="\"$expected\""
  slot_versions="{\"annoy\":\"$expected\",\"annoy-b\":\"$expected\"}"
  waiting_connections=0; phase=done; last_error=null; write_status
}
