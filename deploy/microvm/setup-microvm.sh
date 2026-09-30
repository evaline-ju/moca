#!/usr/bin/env bash
# deploy/microvm/setup-microvm.sh
#
# Installs the P4 microVM tier NEXT TO an installed P6 (deploy/vm/setup-vm.sh): the microvm-worker
# binary, its unit and slice, and the wiring that attaches it to P6's relay under its OWN relay
# token (#369). It reads P6's installed relay.env and never writes a P6-owned file: the relay learns
# the new token through a systemd drop-in that loads a separate env file.
#
# Prerequisites: P6 installed and running; /dev/kvm; Firecracker + jailer in /usr/local/bin; a golden
# snapshot at $MICROVM_SNAPSHOT_DIR (build-rootfs.sh, then build-snapshot.sh -- see P4-ON-P6.md);
# Go, unless MICROVM_BIN names a prebuilt binary.
#
# P4-ONLY HOST (#369 gap 4, decision T1): selectPoolSandbox leases the least-loaded of ALL presence
# records and re-selects every turn, so with container sandboxes attached a session's turns can hop
# between tiers and lose the microVM workspace. This script therefore refuses while any sh-sandbox-*
# container is running.
#
# Usage: sudo ./deploy/microvm/setup-microvm.sh      (re-running changes nothing)
#
# Env overrides: SH_UNIT_DIR, SH_ENV_DIR, SH_BIN_DIR, MICROVM_SANDBOX_ID, MICROVM_WORKSPACE_IDLE,
# MICROVM_SNAPSHOT_DIR, MICROVM_BIN, MICROVM_ATTACH_TIMEOUT -- defaults below.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
: "${SH_UNIT_DIR:=/etc/systemd/system}"
: "${SH_ENV_DIR:=/etc/serverless-harness}"
: "${SH_BIN_DIR:=/usr/local/bin}"
: "${MICROVM_SANDBOX_ID:=moca_microvm_0}"
: "${MICROVM_WORKSPACE_IDLE:=8h}"
: "${MICROVM_SNAPSHOT_DIR:=/srv/snapshots/default}"
: "${MICROVM_ATTACH_TIMEOUT:=60}"

RELAY_DROPIN="50-moca-microvm.conf"
WORKER_DROPIN="50-moca-p6.conf"
CHANGED=() # destination paths this run actually rewrote

log() { printf '==> %s\n' "$*"; }
die() { echo "setup-microvm.sh: $*" >&2; exit 1; }

# The relay authenticates a sandbox by SH_RELAY_TOKEN_<sandboxId> (sandbox-relay/src/main.ts), and
# systemd's EnvironmentFile= only accepts shell-valid names -- a dashed id's line is dropped with a
# log message, and the attach then fails closed with nothing pointing at why.
validate_sandbox_id() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    { echo "MICROVM_SANDBOX_ID='$1' must match ^[A-Za-z_][A-Za-z0-9_]*\$ (it becomes the env name SH_RELAY_TOKEN_$1)" >&2; return 1; }
}

# env_value <key> <file>: the last <key>= value, one matched pair of surrounding quotes stripped the
# way systemd's EnvironmentFile= strips them. Same semantics as setup-vm.sh's helpers, re-implemented
# rather than sourced because that script is being reworked in parallel (#366).
env_value() {
  local v
  v="$( (grep -E "^$1=" "$2" 2>/dev/null || true) | tail -1 | cut -d= -f2-)"
  if ((${#v} >= 2)); then
    case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  fi
  printf '%s' "$v"
}

# relay_port <relay.env>: the relay's attach port, 8443 when unset (sandbox-relay/src/main.ts).
relay_port() {
  local p
  p="$(env_value SH_RELAY_PORT "$1")"
  [[ -z "$p" ]] && { echo 8443; return; }
  [[ "$p" =~ ^[0-9]+$ ]] || { echo "SH_RELAY_PORT='$p' in $1 is not a port number" >&2; return 1; }
  echo "$p"
}

preflight() {
  [[ "$(id -u)" == 0 ]] || die "must run as root (installs units under $SH_UNIT_DIR)"
  validate_sandbox_id "$MICROVM_SANDBOX_ID" || exit 1
  [[ -f "$SH_ENV_DIR/relay.env" && -f "$SH_UNIT_DIR/sh-relay.service" ]] ||
    die "no installed P6 found ($SH_ENV_DIR/relay.env, $SH_UNIT_DIR/sh-relay.service); run deploy/vm/setup-vm.sh first"
  [[ -f "$MICROVM_SNAPSHOT_DIR/manifest.json" ]] ||
    die "no golden snapshot at $MICROVM_SNAPSHOT_DIR; build one with deploy/microvm/build-rootfs.sh then build-snapshot.sh (deploy/microvm/P4-ON-P6.md)"
  local attached
  attached="$(podman ps --format '{{.Names}}' --filter 'name=^sh-sandbox-' | tr '\n' ' ')"
  if [[ -n "${attached// /}" ]]; then
    die "container sandboxes are attached to the relay (${attached% }). This host must be P4-only while the microVM tier serves: sessions re-select a sandbox every turn and would hop between tiers. Stop them (podman rm -f ${attached% }) and re-run deploy/vm/setup-vm.sh with SH_SANDBOX_COUNT=0 so a re-run does not start them again."
  fi
}

# install_if_changed <src> <dst> <mode>: copy only when the content differs, recording dst in CHANGED.
install_if_changed() {
  if ! cmp -s "$1" "$2" 2>/dev/null; then
    mkdir -p "$(dirname "$2")"
    install -m "$3" "$1" "$2"
    CHANGED+=("$2")
  fi
}

# render_env <file> <keep|set> <key> <value> [<keep|set> <key> <value>]... -> writes <file>.new
# keep: write only if the key is absent. set: replace the value IN PLACE (never delete-and-append,
# which reorders the file and makes an unchanged re-run look like a change). Every other line --
# including ones an operator added -- is preserved where it is.
render_env() {
  local file="$1"; shift
  local out="$file.new" mode key value tmp
  (umask 077; if [[ -f "$file" ]]; then cp "$file" "$out"; else : >"$out"; fi)
  # An operator-edited file may lack a final newline; appending onto it would glue two assignments.
  if [[ -s "$out" && -n "$(tail -c 1 "$out")" ]]; then printf '\n' >>"$out"; fi
  while (($#)); do
    mode="$1" key="$2" value="$3"; shift 3
    if grep -qE "^$key=" "$out"; then
      [[ "$mode" == keep ]] && continue
      tmp="$(mktemp)"
      awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$out" >"$tmp"
      cat "$tmp" >"$out"; rm -f "$tmp"
    else
      printf '%s=%s\n' "$key" "$value" >>"$out"
    fi
  done
}

commit_env() { # commit_env <file>: move <file>.new into place iff it differs
  if cmp -s "$1.new" "$1" 2>/dev/null; then rm -f "$1.new"; return; fi
  chmod 0600 "$1.new"; mv "$1.new" "$1"; CHANGED+=("$1")
}

install_worker_binary() {
  local stage; stage="$(mktemp -d)"
  if [[ -n "${MICROVM_BIN:-}" ]]; then
    cp "$MICROVM_BIN" "$stage/microvm-worker"
  else
    log "building microvm-worker from $REPO_ROOT/remote-worker"
    (cd "$REPO_ROOT/remote-worker" &&
      CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w' -o "$stage/microvm-worker" ./cmd/microvm-worker)
  fi
  install_if_changed "$stage/microvm-worker" "$SH_BIN_DIR/microvm-worker" 0755
  rm -rf "$stage"
}

install_units() {
  local stage; stage="$(mktemp -d)"
  install_if_changed "$SCRIPT_DIR/microvm-worker.service" "$SH_UNIT_DIR/microvm-worker.service" 0644
  install_if_changed "$SCRIPT_DIR/microvm-vms.slice" "$SH_UNIT_DIR/microvm-vms.slice" 0644
  printf '# Written by deploy/microvm/setup-microvm.sh: the per-sandbox relay token for the P4 worker.\n[Service]\nEnvironmentFile=%s\n' \
    "$SH_ENV_DIR/microvm-relay.env" >"$stage/relay.conf"
  install_if_changed "$stage/relay.conf" "$SH_UNIT_DIR/sh-relay.service.d/$RELAY_DROPIN" 0644
  printf '# Written by deploy/microvm/setup-microvm.sh: attach this worker to the P6 relay on this host.\n[Unit]\nAfter=sh-relay.service\nWants=sh-relay.service\n\n[Service]\nEnvironmentFile=%s\n' \
    "$SH_ENV_DIR/microvm-worker.env" >"$stage/worker.conf"
  install_if_changed "$stage/worker.conf" "$SH_UNIT_DIR/microvm-worker.service.d/$WORKER_DROPIN" 0644
  rm -rf "$stage"
}

install_env() {
  local worker="$SH_ENV_DIR/microvm-worker.env" relay="$SH_ENV_DIR/microvm-relay.env" port token
  port="$(relay_port "$SH_ENV_DIR/relay.env")"
  # Generated once, never rotated (setup-vm.sh's rule for its own secrets): the worker's file is
  # the source of truth, and the relay's copy is re-derived from it every run.
  token="$(env_value SANDBOX_TOKEN "$worker")"
  if [[ -z "$token" ]]; then
    token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    [[ ${#token} == 64 ]] || die "could not generate a relay token"
  fi
  render_env "$worker" \
    set RELAY_ADDR "127.0.0.1:$port" \
    set SANDBOX_ID "$MICROVM_SANDBOX_ID" \
    keep SANDBOX_TOKEN "$token" \
    keep SH_WORKSPACE_IDLE "$MICROVM_WORKSPACE_IDLE"
  commit_env "$worker"
  # The relay's file is wholly installer-owned, so it is rendered from scratch rather than merged:
  # a changed MICROVM_SANDBOX_ID must not leave the OLD id's token behind, still valid at the relay.
  (umask 077; printf 'SH_RELAY_TOKEN_%s=%s\n' "$MICROVM_SANDBOX_ID" "$token" >"$relay.new")
  commit_env "$relay"
}

changed_any() { # changed_any <path>...: true iff one of them is in CHANGED
  local c p
  for p in "$@"; do for c in "${CHANGED[@]+"${CHANGED[@]}"}"; do [[ "$c" == "$p" ]] && return 0; done; done
  return 1
}

apply() {
  local relay_restart=0
  if changed_any "$SH_UNIT_DIR/microvm-worker.service" "$SH_UNIT_DIR/microvm-vms.slice" \
    "$SH_UNIT_DIR/sh-relay.service.d/$RELAY_DROPIN" "$SH_UNIT_DIR/microvm-worker.service.d/$WORKER_DROPIN"; then
    systemctl daemon-reload
  fi
  if changed_any "$SH_UNIT_DIR/sh-relay.service.d/$RELAY_DROPIN" "$SH_ENV_DIR/microvm-relay.env"; then
    log "restarting sh-relay.service to load the microVM worker's token (in-flight turns fail and retry)"
    systemctl restart sh-relay.service
    relay_restart=1
  fi
  systemctl enable microvm-worker.service
  if ((relay_restart)) || changed_any "$SH_BIN_DIR/microvm-worker" "$SH_UNIT_DIR/microvm-worker.service" \
    "$SH_UNIT_DIR/microvm-vms.slice" "$SH_UNIT_DIR/microvm-worker.service.d/$WORKER_DROPIN" \
    "$SH_ENV_DIR/microvm-worker.env"; then
    systemctl restart microvm-worker.service
  fi
}

# The install is not done until the relay has mirrored the worker into sh:sandbox:records -- the
# set the supervisor leases from. A unit that is "active" but never attached is the silent failure.
verify_attached() {
  local i
  for ((i = 0; i < MICROVM_ATTACH_TIMEOUT; i++)); do
    [[ "$(podman exec sh-redis redis-cli HEXISTS sh:sandbox:records "$MICROVM_SANDBOX_ID")" == 1 ]] && {
      log "$MICROVM_SANDBOX_ID is attached to the relay"; return 0; }
    sleep 1
  done
  die "$MICROVM_SANDBOX_ID did not attach within ${MICROVM_ATTACH_TIMEOUT}s; see journalctl -u microvm-worker -u sh-relay"
}

main() {
  preflight
  install_worker_binary
  install_units
  install_env
  apply
  verify_attached
  if ((${#CHANGED[@]})); then log "changed: ${CHANGED[*]}"; else log "nothing to change"; fi
}

if [[ "${SH_SOURCE_ONLY:-}" != 1 ]]; then main "$@"; fi
