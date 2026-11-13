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
default_auto="${ANNOY_AUTO_UPDATE:-off}"
write_status() {
  [ "$default_auto" = on ] && auto=true || auto=false
  printf '{"heartbeat":"%s","auto":%s,"channel":"%s","intervalHours":%s,"lastCheck":%s,"lastError":%s,"updating":%s,"protocol":2,"phase":"%s","currentVersion":%s,"targetVersion":%s,"waitingConnections":%s,"operationId":%s}\n' \
    "$(date -u '+%FT%TZ')" "$auto" "$channel" "$hours" "$last_check" "$last_error" "$updating" "$phase" "$current_version" "$target_version" "$waiting_connections" "$operation_id" > "$control/status.json.tmp" && mv "$control/status.json.tmp" "$control/status.json"
}
fail() { last_error="\"$1\""; phase=failed; echo "update failed: $1" >&2; write_status; }
cancelled() { [ -e "$control/cancel" ]; }
connections() {
  count="$(probe "$1" connections)" || return 1
  case "$count" in ''|*[!0-9]*) return 1 ;; esac
  echo "$count"
}
wait_idle() {
  phase=waiting_connections
  while :; do
    cancelled && { phase=cancelled; return 2; }
    waiting_connections="$(connections "$1")" || { fail 'Não foi possível verificar as conexões; o principal foi preservado.'; return 1; }
    write_status
    [ "$waiting_connections" -eq 0 ] && return 0
    sleep 2
  done
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
swap() {
  old="$(active)" || { fail 'Nenhum servidor ativo. Inicie a instância antes de atualizar.'; return 1; }
  [ "$old" = annoy ] && new=annoy-b || new=annoy
  if running "$new"; then
    leftover="$(connections "$new")" || { fail 'Não foi possível verificar o segundo contêiner.'; return 1; }
    [ "$leftover" -eq 0 ] || { fail 'O segundo contêiner ainda atende conexões e foi preservado.'; return 1; }
  fi
  wait_idle "$old" || return $?
  phase=starting; write_status
  if ! compose up --detach --no-deps --no-build --force-recreate "$new"; then fail 'A candidata não iniciou; o principal continua atendendo.'; return 1; fi
  phase=checking; write_status
  if ! healthy "$new" "$expected"; then
    compose stop "$new" || true
    fail 'A candidata não respondeu HTTP 200 com a versão esperada; o principal foi preservado.'; return 1
  fi
  if ! wait_idle "$old"; then compose stop "$new" || true; return 1; fi
  phase=promoting; write_status
  if ! (echo "$new" > "$control/active.tmp" && mv "$control/active.tmp" "$control/active"); then
    fail 'A rota não pôde ser alterada; nenhum contêiner ativo foi parado.'; return 1
  fi
  sleep 2
  phase=draining; write_status
  while :; do
    if ! probe "$new" health "$expected" >/dev/null 2>&1; then
      echo "$old" > "$control/active.tmp" && mv "$control/active.tmp" "$control/active"
      fail 'A candidata falhou. O tráfego voltou ao principal, que continua ligado.'; return 1
    fi
    waiting_connections="$(connections "$old")" || { fail 'O principal ficou ligado porque a drenagem não pôde ser confirmada.'; return 1; }
    write_status
    [ "$waiting_connections" -eq 0 ] && break
    sleep 2
  done
  compose stop "$old" || { fail 'A nova versão atende, mas o contêiner antigo não pôde ser encerrado.'; return 1; }
  current_version="\"$expected\""; phase=done; last_error=null
  echo "$(date -u '+%F %T') now serving $expected from $new; no live connections closed"
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
         if [ "$comparison" = 0 ]; then phase=no_change; echo "Already running $current; no container restarted"
         elif [ "$comparison" = 1 ]; then fail 'O canal aponta para uma versão mais antiga. Downgrade bloqueado; revise ANNOY_VERSION.'
         elif [ "$comparison" = -1 ]; then swap || true
         else fail 'Não foi possível comparar as versões; nada foi reiniciado.'; fi ;;
    esac
  fi
  if cancelled; then phase=cancelled; rm -f "$control/cancel"; fi
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
  if [ "$image_id" != "$configured_id" ]; then fail 'A imagem configurada difere da ativa. Use Atualizar para trocar de versão.'; else swap || true; fi
  updating=false; write_status
}
next=0
initial="$(active 2>/dev/null || true)"
if [ -n "$initial" ]; then initial_version="$(probe "$initial" health 2>/dev/null || true)"; [ -z "$initial_version" ] || current_version="\"$initial_version\""; fi
initial_image="$(compose config --images 2>/dev/null | grep '^ghcr.io/geglab/annoy-server:' | head -n 1)"
[ -z "$initial_image" ] || channel="${initial_image##*:}"
while :; do
  if [ -e "$control/restart" ]; then rm -f "$control/restart" "$control/cancel"; restart
  elif [ -e "$control/request" ]; then rm -f "$control/request" "$control/cancel"; update
  elif [ "$default_auto" = on ] && [ "$(date +%s)" -ge "$next" ]; then update; next=$(($(date +%s) + hours * 3600))
  fi
  write_status; sleep 2
done
