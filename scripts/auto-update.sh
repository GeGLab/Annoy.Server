#!/bin/sh
# Protocol 2: never force-disconnect live clients to install an update.
set -u
hours="${ANNOY_UPDATE_INTERVAL_HOURS:-6}"
case "$hours" in ''|*[!0-9]*|0) echo 'Invalid update interval' >&2; exit 1 ;; esac
control="${ANNOY_CONTROL_DIR:-/control}"
mkdir -p "$control"
chown 1000:1000 "$control" 2>/dev/null || chmod 0777 "$control"
project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$(hostname)")" || exit 1
compose() { env -u ANNOY_VERSION docker compose --project-name "$project" --project-directory /project --profile standby "$@"; }
probe() {
  probe_slot="$1"; shift
  probe_id="$(compose ps --quiet "$probe_slot" 2>/dev/null)" || return 1
  [ -n "$probe_id" ] || return 1
  docker exec -i "$probe_id" node - "$@" < /project/scripts/update-probe.cjs
}
running() { [ -n "$(compose ps --status running --quiet "$1" 2>/dev/null)" ]; }
active() {
  a="$(cat "$control/active" 2>/dev/null || true)"
  case "$a" in annoy|annoy-b) ;; *) a=annoy ;; esac
  if running "$a"; then echo "$a"; elif running annoy; then echo annoy; elif running annoy-b; then echo annoy-b; else return 1; fi
}
channel=unknown; phase=idle; updating=false; last_check=null; last_error=null
target_version=null; current_version=null; waiting_connections=0; operation_id=null
slot_versions=null
. /project/scripts/live/rollout.sh
default_auto="${ANNOY_AUTO_UPDATE:-off}"
write_status() {
  [ "$default_auto" = on ] && auto=true || auto=false
  legacy_json="$(cat "$control/legacy.json" 2>/dev/null || printf null)"
  printf '{"heartbeat":"%s","auto":%s,"channel":"%s","intervalHours":%s,"lastCheck":%s,"lastError":%s,"updating":%s,"protocol":3,"phase":"%s","currentVersion":%s,"targetVersion":%s,"waitingConnections":%s,"operationId":%s,"legacyGateway":%s,"slotVersions":%s}\n' \
    "$(date -u '+%FT%TZ')" "$auto" "$channel" "$hours" "$last_check" "$last_error" "$updating" "$phase" "$current_version" "$target_version" "$waiting_connections" "$operation_id" "$legacy_json" "$slot_versions" > "$control/status.json.tmp" && mv "$control/status.json.tmp" "$control/status.json"
}
fail() { last_error="\"$1\""; phase=failed; echo "update failed: $1" >&2; write_status; }
cancelled() { [ -e "$control/cancel" ]; }
connections() {
  count="$(probe "$1" connections)" || return 1
  case "$count" in ''|*[!0-9]*) return 1 ;; esac
  echo "$count"
}
healthy() {
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    cancelled && return 2
    probe "$1" health "$2" >/dev/null 2>&1 && return 0
    write_status; attempt=$((attempt + 1)); sleep 2
  done
  return 1
}
handoff_command() {
  command_slot="$1"; command_action="$2"
  command_id="$(compose ps --quiet "$command_slot")" || return 1
  docker exec -i "$command_id" node - "$command_action" < /project/scripts/handoff/control.cjs
}
prepare_handoff() {
  if probe "$old" prepare "$old" "$new" >/dev/null 2>&1; then return 0; fi
  old_id="$(compose ps --quiet "$old")" || return 1
  legacy_image="$(docker inspect --format '{{.Image}}' "$old_id")" || return 1
  # One-time bootstrap is audited against this exact published alpha.2 image.
  [ "$legacy_image" = sha256:d6b4fe304cba5cebfa26ea298d75f69bf848fdc4785f14e7e633d75638365346 ] || return 1
  new_id="$(compose ps --quiet "$new")" || return 1
  bundle_hash="$(docker exec "$new_id" node -e 'const f=require("node:fs"),c=require("node:crypto"),p="scripts/handoff/";let h=c.createHash("sha256");for(const n of f.readdirSync(p).sort())h.update(f.readFileSync(p+n));console.log(h.digest("hex"))')" || return 1
  case "$bundle_hash" in ''|*[!a-f0-9]*) return 1 ;; esac
  bundle="/tmp/annoy-handoff-$bundle_hash"
  mkdir -p "$bundle" || return 1
  docker cp "$new_id":/app/scripts/handoff/. "$bundle" || return 1
  docker exec "$old_id" mkdir -p "$bundle" || return 1
  docker cp "$bundle"/. "$old_id":"$bundle"/ || return 1
  docker exec -i "$old_id" node - "$old" "$new" "$bundle" < "$bundle/install.cjs"
}
swap() {
  old="$(active)" || { fail 'Nenhum servidor ativo. Inicie a instância antes de atualizar.'; return 1; }
  [ "$old" = annoy ] && new=annoy-b || new=annoy
  # A legacy gateway is a live component, never an idle slot to overwrite.
  if [ -e "$control/legacy.json" ]; then fail 'A API já foi atualizada; o gateway anterior ainda preserva conexões. Aguarde a drenagem antes de outra troca.'; return 1; fi
  if running "$new"; then
    leftover="$(connections "$new")" || { fail 'Não foi possível verificar o segundo contêiner.'; return 1; }
    [ "$leftover" -eq 0 ] || { fail 'O segundo contêiner ainda atende conexões e foi preservado.'; return 1; }
  fi
  phase=starting; write_status
  if ! compose up --detach --no-deps --no-build --force-recreate "$new"; then fail 'A candidata não iniciou; o principal continua atendendo.'; return 1; fi
  phase=checking; write_status
  if ! healthy "$new" "$expected"; then
    compose stop "$new" || true
    fail 'A candidata não respondeu HTTP 200 com a versão esperada; o principal foi preservado.'; return 1
  fi
  echo "$old" > "$control/legacy-slot"
  phase=preparing_handoff; write_status
  if ! prepare_handoff; then
    compose stop "$new" || true
    fail 'Esta versão não confirmou a compatibilidade sem desconexões. O principal foi preservado.'; return 1
  fi
  if cancelled; then if handoff_command "$old" rollback; then compose stop "$new" || true; fi; phase=cancelled; return 1; fi
  if ! handoff_command "$old" activate; then
    if handoff_command "$old" rollback; then compose stop "$new" || true; fi
    fail 'A transferência da API não foi confirmada. O principal foi preservado.'; return 1
  fi
  phase=promoting; write_status
  if ! (echo "$new" > "$control/active.tmp" && mv "$control/active.tmp" "$control/active"); then
    handoff_command "$old" rollback || true
    fail 'A rota não pôde ser alterada; nenhum contêiner ativo foi parado.'; return 1
  fi
  current_version="\"$expected\""; phase=active_draining; last_error=null
  echo "$(date -u '+%F %T') API $expected active on $new; existing gateways and media preserved on $old"
}
maybe_retire() {
  [ "$phase" = active_draining ] || return 0
  serving="$(active)" || return 0
  previous="$(cat "$control/legacy-slot" 2>/dev/null || true)"
  case "$previous" in
    annoy|annoy-b)
      if ! waiting_connections="$(connections "$previous" 2>/dev/null)"; then
        last_error='"Não foi possível confirmar as conexões do gateway anterior. Ele foi preservado."'; return 0
      fi ;;
    *) return 0 ;;
  esac
  if ! probe "$serving" health "$(printf '%s' "$current_version" | tr -d '\"')" >/dev/null 2>&1; then
    last_error='"A API nova não confirmou saúde. Os dois contêineres foram preservados; nenhuma sessão será encerrada automaticamente."'
    return 0
  fi
  last_error=null
  ready="$(probe "$serving" retire-ready 2>/dev/null || true)"
  if [ "$ready" = 1 ]; then
    case "$previous" in annoy|annoy-b) compose stop "$previous" && rm -f "$control/legacy.json" "$control/legacy-slot" && phase=done ;; esac
  fi
}

update() {
  updating=true; last_error=null; target_version=null; waiting_connections=0
  operation_id="\"$(date +%s)-$$\""; phase=downloading; write_status
  old="$(active)" || { fail 'Nenhum servidor ativo.'; updating=false; return; }
  current="$(probe "$old" health)" || { fail 'O principal não respondeu à consulta local; nada foi alterado.'; updating=false; return; }
  current_version="\"$current\""
  image="$(compose config --images | grep '^ghcr.io/geglab/annoy-server:' | head -n 1)"
  case "$image" in ghcr.io/geglab/annoy-server:*) channel="${image##*:}" ;; *) fail 'Imagem da instância não identificada.'; updating=false; return ;; esac
  write_status
  compose pull --quiet annoy &
  download_pid=$!
  while kill -0 "$download_pid" 2>/dev/null; do write_status; sleep 2; done
  if ! wait "$download_pid"; then fail 'Não foi possível baixar a imagem. O principal foi preservado.'
  else
    expected="$(docker run --rm --network none --read-only --entrypoint node "$image" -p 'require("./package.json").version')" || expected=''
    case "$expected" in ''|*[!0-9A-Za-z.+-]*) fail 'A imagem não informou uma versão válida.' ;;
      *) target_version="\"$expected\""
         comparison="$(probe "$old" compare "$current" "$expected")" || comparison=unknown
         live_backend="$(docker exec "$(compose ps --quiet "$old")" node -p 'process.env.ANNOY_VOICE_BACKEND||"builtin"')"
         if [ "$live_backend" = cloudflare ] && [ "$comparison" != 1 ] && [ "$comparison" != unknown ]; then
           if [ "$comparison" = 0 ] && live_both_current; then phase=no_change
           elif ! rolling_live; then fail 'A migração das sessões não foi confirmada. Nenhum slot com usuários será reiniciado; consulte a transação de migração.'; fi
         elif [ "$comparison" = 0 ]; then phase=no_change; echo "Already running $current; no container restarted"
         elif [ "$comparison" = 1 ]; then fail 'O canal aponta para uma versão mais antiga. Downgrade bloqueado; revise ANNOY_VERSION.'
         elif [ "$comparison" = -1 ]; then swap || true
         else fail 'Não foi possível comparar as versões; nada foi reiniciado.'; fi ;;
    esac
  fi
  if cancelled; then [ "$phase" = active_draining ] || phase=cancelled; rm -f "$control/cancel"; fi
  last_check="\"$(date -u '+%FT%TZ')\""; updating=false; write_status
}
restart() {
  updating=true; last_error=null; waiting_connections=0; operation_id="\"$(date +%s)-$$\""
  old="$(active)" || { fail 'Nenhum servidor ativo.'; updating=false; return; }
  expected="$(probe "$old" health)" || { fail 'O servidor não respondeu.'; updating=false; return; }
  current_version="\"$expected\""; target_version="\"$expected\""
  image_id="$(docker inspect --format '{{.Image}}' "$(compose ps --quiet "$old")")" || { updating=false; return; }
  configured="$(compose config --images | grep '^ghcr.io/geglab/annoy-server:' | head -n 1)"
  configured_id="$(docker image inspect --format '{{.Id}}' "$configured" 2>/dev/null || true)"
  live_backend="$(docker exec "$(compose ps --quiet "$old")" node -p 'process.env.ANNOY_VOICE_BACKEND||"builtin"')"
  if [ "$live_backend" = cloudflare ]; then
    # Keep the published corrective runtime available to both slots. Restart
    # follows the configured image, just like applying the saved configuration.
    image="$configured"
    if ! compose pull --quiet annoy; then fail 'Não foi possível obter a imagem configurada; processos preservados.'
    else
      expected="$(docker run --rm --network none --read-only --entrypoint node "$image" -p 'require("./package.json").version')" || expected=''
      case "$expected" in ''|*[!0-9A-Za-z.+-]*) fail 'Imagem configurada inválida.' ;; *)
        target_version="\"$expected\""
        restart_comparison="$(probe "$old" compare "$(printf '%s' "$current_version" | tr -d '\"')" "$expected")" || restart_comparison=unknown
        if [ "$restart_comparison" = 1 ] || [ "$restart_comparison" = unknown ]; then fail 'Downgrade ou versão inválida bloqueada; processos preservados.'
        elif ! rolling_live; then fail 'A migração das sessões não foi confirmada; slots com usuários foram preservados.'; fi ;;
      esac
    fi
  elif [ "$image_id" != "$configured_id" ]; then fail 'A imagem configurada difere da ativa. Use Atualizar para trocar de versão.'; else swap || true; fi
  updating=false; write_status
}
next=0
initial="$(active 2>/dev/null || true)"
if [ -n "$initial" ]; then initial_version="$(probe "$initial" health 2>/dev/null || true)"; [ -z "$initial_version" ] || current_version="\"$initial_version\""; fi
initial_image="$(compose config --images 2>/dev/null | grep '^ghcr.io/geglab/annoy-server:' | head -n 1)"
[ -z "$initial_image" ] || channel="${initial_image##*:}"
if [ -e "$control/legacy.json" ]; then
  phase="$(probe "$initial" handoff-phase 2>/dev/null || printf handoff_recovery)"
  if [ "$phase" = active_draining ]; then target_version="$current_version"
  else phase=handoff_recovery; last_error='"Preparação anterior incompleta. Os dois contêineres foram preservados; revise a transferência antes de outra atualização."'; fi
fi
while :; do
  if [ -e "$control/restart" ]; then rm -f "$control/restart" "$control/cancel"; restart
  elif [ -e "$control/request" ]; then rm -f "$control/request" "$control/cancel"; update
  elif [ "$default_auto" = on ] && [ "$(date +%s)" -ge "$next" ]; then update; next=$(($(date +%s) + hours * 3600))
  fi
  maybe_retire
  write_status; sleep 2
done
