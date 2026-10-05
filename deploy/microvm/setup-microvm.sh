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
# Usage: sudo ./deploy/microvm/setup-microvm.sh [--remote BUNDLE_DIR]      (re-running changes nothing)
#
# --remote BUNDLE_DIR (P6 on Kubernetes, docs/specs/2026-10-04-p6-on-kubernetes-slice2-design.md §5):
# attach this host's worker to a relay in a cluster, over TLS, instead of to a local P6. The bundle is
# the directory deploy/k8s/setup.sh wrote for this host's ID; its token replaces a local one (the
# cluster is the token authority), and MICROVM_SANDBOX_ID comes from it. Nothing local is touched:
# no relay drop-in, no podman, no installed P6 needed. Running again without --remote switches back.
#
# Env overrides: SH_UNIT_DIR, SH_ENV_DIR, SH_BIN_DIR, MICROVM_SANDBOX_ID, MICROVM_WORKSPACE_IDLE,
# MICROVM_SNAPSHOT_DIR, MICROVM_BIN, MICROVM_ATTACH_TIMEOUT, MICROVM_ATTACH_SETTLE (--remote: seconds
# an attach must hold before it counts) -- defaults below -- and
# MICROVM_MAX_COMMITTED_MB (unset by default): a VM-memory budget in MiB for a host smaller than the
# shipped unit's 24 GiB, written as a drop-in that also lowers the unit's AssertMemory to match.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
: "${SH_UNIT_DIR:=/etc/systemd/system}"
: "${SH_ENV_DIR:=/etc/serverless-harness}"
: "${SH_BIN_DIR:=/usr/local/bin}"
SANDBOX_ID_GIVEN="${MICROVM_SANDBOX_ID+x}" # --remote refuses a given id that disagrees with the bundle
: "${MICROVM_SANDBOX_ID:=moca_microvm_0}"
: "${MICROVM_WORKSPACE_IDLE:=8h}"
: "${MICROVM_SNAPSHOT_DIR:=/srv/snapshots/default}"
: "${MICROVM_ATTACH_TIMEOUT:=60}"
: "${MICROVM_ATTACH_SETTLE:=5}"

RELAY_DROPIN="50-moca-microvm.conf"
WORKER_DROPIN="50-moca-p6.conf"
REMOTE_DROPIN="50-moca-remote.conf"
RELAY_CA_DST="$SH_ENV_DIR/microvm-relay-ca.crt"
REMOTE_BUNDLE='' # --remote's directory; empty in local mode
B_ADDR='' B_ID='' B_TOKEN='' B_CA=''
MEMORY_DROPIN="60-moca-memory.conf"
# The shipped unit's SH_MEMORY_RESERVE_MB: a budget at or below it admits nothing (Config.Normalize).
SHIPPED_RESERVE_MB=4096
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

parse_args() {
  while (($#)); do
    case "$1" in
    --remote)
      [[ $# -ge 2 && -n "$2" ]] || die '--remote needs the bundle directory deploy/k8s/setup.sh wrote for this host'
      REMOTE_BUNDLE="$2"
      shift 2
      ;;
    *) die "unknown argument: $1 (usage: setup-microvm.sh [--remote BUNDLE_DIR])" ;;
    esac
  done
}

# load_bundle: the bundle deploy/k8s/setup.sh writes per P4 ID, checked before anything is written.
# Every refusal names the field, never the token's value.
load_bundle() {
  local env="$REMOTE_BUNDLE/worker.env" tls
  [[ -f "$env" ]] ||
    die "no $env: --remote takes the bundle directory deploy/k8s/setup.sh writes (deploy/k8s/.generated/ocp/p4/<id>)"
  B_ADDR="$(env_value RELAY_ADDR "$env")"
  # Without a port the worker fails later, at dial, with an opaque error; the relay Route is on 443.
  [[ "$B_ADDR" =~ ^[A-Za-z0-9.-]+:[0-9]+$ ]] ||
    die "RELAY_ADDR='$B_ADDR' in $env must be host:port -- the relay Route is <host>:443"
  tls="$(env_value RELAY_TLS "$env")"
  [[ "$tls" == true ]] || die "RELAY_TLS='$tls' in $env: a relay outside this host is reached over TLS only"
  B_ID="$(env_value SANDBOX_ID "$env")"
  validate_sandbox_id "$B_ID" || exit 1
  [[ -z "$SANDBOX_ID_GIVEN" || "$MICROVM_SANDBOX_ID" == "$B_ID" ]] ||
    die "the bundle is for $B_ID but MICROVM_SANDBOX_ID=$MICROVM_SANDBOX_ID: unset it (--remote takes the id from the bundle)"
  B_TOKEN="$(env_value SANDBOX_TOKEN "$env")"
  [[ "$B_TOKEN" =~ ^[0-9a-f]{64}$ ]] ||
    die "SANDBOX_TOKEN in $env is not 64 hex characters: copy the bundle again from deploy/k8s/.generated/ocp/p4/$B_ID"
  B_CA=''
  if [[ -f "$REMOTE_BUNDLE/relay-ca.crt" ]]; then
    grep -q -- '-----BEGIN CERTIFICATE-----' "$REMOTE_BUNDLE/relay-ca.crt" ||
      die "$REMOTE_BUNDLE/relay-ca.crt holds no PEM certificate"
    B_CA="$REMOTE_BUNDLE/relay-ca.crt"
  fi
  MICROVM_SANDBOX_ID="$B_ID"
}

preflight() {
  [[ "$(id -u)" == 0 ]] || die "must run as root (installs units under $SH_UNIT_DIR)"
  if [[ -n "$REMOTE_BUNDLE" ]]; then load_bundle; else validate_sandbox_id "$MICROVM_SANDBOX_ID" || exit 1; fi
  if [[ -n "${MICROVM_MAX_COMMITTED_MB:-}" ]] &&
    ! { [[ "$MICROVM_MAX_COMMITTED_MB" =~ ^[1-9][0-9]*$ ]] && ((MICROVM_MAX_COMMITTED_MB > SHIPPED_RESERVE_MB)); }; then
    die "MICROVM_MAX_COMMITTED_MB='$MICROVM_MAX_COMMITTED_MB' must be a whole number of MiB above the unit's SH_MEMORY_RESERVE_MB ($SHIPPED_RESERVE_MB), or nothing is ever admitted"
  fi
  if [[ -z "$REMOTE_BUNDLE" ]]; then
    [[ -f "$SH_ENV_DIR/relay.env" && -f "$SH_UNIT_DIR/sh-relay.service" ]] ||
      die "no installed P6 found ($SH_ENV_DIR/relay.env, $SH_UNIT_DIR/sh-relay.service); run deploy/vm/setup-vm.sh first"
  fi
  [[ -f "$MICROVM_SNAPSHOT_DIR/manifest.json" ]] ||
    die "no golden snapshot at $MICROVM_SNAPSHOT_DIR; build one with deploy/microvm/build-rootfs.sh then build-snapshot.sh (deploy/microvm/P4-ON-P6.md)"
  # Remote: the tier rule is the cluster's (setup.sh refuses both tiers on one stack); this host's own
  # containers, if any, attach to its own relay, which the remote worker does not use.
  [[ -z "$REMOTE_BUNDLE" ]] || return 0
  local attached
  # -a: a STOPPED sandbox container still counts. setup-vm.sh runs them --restart=always, and
  # podman-restart.service brings every such container back at boot -- both tiers attached again.
  attached="$(podman ps -a --format '{{.Names}}' --filter 'name=^sh-sandbox-' | tr '\n' ' ')"
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

# remove_if_present <path>: delete a file this script once wrote, recording it in CHANGED.
remove_if_present() { if [[ -e "$1" ]]; then rm -f "$1"; CHANGED+=("$1"); fi; }

# render_env <file> <keep|set|drop> <key> <value> [<keep|set|drop> <key> <value>]... -> writes <file>.new
# keep: write only if the key is absent. set: replace the value IN PLACE (never delete-and-append,
# which reorders the file and makes an unchanged re-run look like a change). drop: delete every
# <key>= line; its value is ignored (pass '' to keep the triplet shape). Every other line --
# including ones an operator added -- is preserved where it is.
render_env() {
  local file="$1"; shift
  local out="$file.new" mode key value tmp
  (umask 077; if [[ -f "$file" ]]; then cp "$file" "$out"; else : >"$out"; fi)
  # An operator-edited file may lack a final newline; appending onto it would glue two assignments.
  if [[ -s "$out" && -n "$(tail -c 1 "$out")" ]]; then printf '\n' >>"$out"; fi
  while (($#)); do
    mode="$1" key="$2" value="$3"; shift 3
    if [[ "$mode" == drop ]]; then
      if grep -qE "^$key=" "$out"; then
        tmp="$(mktemp)"
        awk -v k="$key" 'index($0, k "=") != 1' "$out" >"$tmp"
        cat "$tmp" >"$out"; rm -f "$tmp"
      fi
      continue
    fi
    if grep -qE "^$key=" "$out"; then
      [[ "$mode" == keep ]] && continue
      tmp="$(mktemp)"
      # The value travels in the environment, never argv: it may be the relay token.
      RENDER_VALUE="$value" awk -v k="$key" 'index($0, k "=") == 1 { print k "=" ENVIRON["RENDER_VALUE"]; next } { print }' "$out" >"$tmp"
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
  if [[ -n "$REMOTE_BUNDLE" ]]; then
    printf '# Written by deploy/microvm/setup-microvm.sh --remote: attach this worker to a relay outside this host, over TLS.\n[Unit]\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nEnvironmentFile=%s\n' \
      "$SH_ENV_DIR/microvm-worker.env" >"$stage/worker.conf"
    install_if_changed "$stage/worker.conf" "$SH_UNIT_DIR/microvm-worker.service.d/$REMOTE_DROPIN" 0644
    remove_if_present "$SH_UNIT_DIR/microvm-worker.service.d/$WORKER_DROPIN"
  else
    printf '# Written by deploy/microvm/setup-microvm.sh: the per-sandbox relay token for the P4 worker.\n[Service]\nEnvironmentFile=%s\n' \
      "$SH_ENV_DIR/microvm-relay.env" >"$stage/relay.conf"
    install_if_changed "$stage/relay.conf" "$SH_UNIT_DIR/sh-relay.service.d/$RELAY_DROPIN" 0644
    printf '# Written by deploy/microvm/setup-microvm.sh: attach this worker to the P6 relay on this host.\n[Unit]\nAfter=sh-relay.service\nWants=sh-relay.service\n\n[Service]\nEnvironmentFile=%s\n' \
      "$SH_ENV_DIR/microvm-worker.env" >"$stage/worker.conf"
    install_if_changed "$stage/worker.conf" "$SH_UNIT_DIR/microvm-worker.service.d/$WORKER_DROPIN" 0644
    remove_if_present "$SH_UNIT_DIR/microvm-worker.service.d/$REMOTE_DROPIN"
  fi
  install_memory_dropin "$stage"
  rm -rf "$stage"
}

# The shipped unit budgets 24 GiB and asserts >=23G of physical memory, so on a smaller host it
# refuses to start -- correctly, since the budget would promise memory that is not there. A smaller
# host gets a smaller budget AND a matching assertion, in the same 90%-of-budget band
# systemd-units.test.sh holds the shipped values to. `AssertMemory=` (empty) resets the unit's list
# first; without it the shipped >=23G would still apply alongside the new one. The reset clears EVERY
# assertion, not just the memory one (systemd.unit(5); verified on a rig: a unit asserting a missing
# path started once the reset was in a drop-in), so each other Assert*= of the shipped unit -- the
# /dev/kvm guard above all -- is re-stated after it, read from the unit so a new one is carried too.
# A leading zero is refused: bash arithmetic would read it as octal while Go parses it as decimal.
install_memory_dropin() {
  local dst="$SH_UNIT_DIR/microvm-worker.service.d/$MEMORY_DROPIN"
  if [[ -z "${MICROVM_MAX_COMMITTED_MB:-}" ]]; then
    remove_if_present "$dst"
    return
  fi
  printf '%s\n' \
    "# Written by deploy/microvm/setup-microvm.sh (MICROVM_MAX_COMMITTED_MB): a VM-memory budget" \
    "# for a host smaller than the shipped unit assumes, and the physical-memory assertion to match." \
    "[Unit]" "AssertMemory=" "AssertMemory=>=$((MICROVM_MAX_COMMITTED_MB * 90 / 100))M" \
    >"$1/memory.conf"
  grep -E '^Assert[A-Za-z]+=' "$SCRIPT_DIR/microvm-worker.service" | grep -v '^AssertMemory=' >>"$1/memory.conf" || true
  printf '%s\n' "" "[Service]" "Environment=SH_MAX_COMMITTED_MB=$MICROVM_MAX_COMMITTED_MB" >>"$1/memory.conf"
  install_if_changed "$1/memory.conf" "$dst" 0644
}

install_env() {
  local worker="$SH_ENV_DIR/microvm-worker.env" relay="$SH_ENV_DIR/microvm-relay.env" port token
  port="$(relay_port "$SH_ENV_DIR/relay.env")"
  # Generated once, never rotated (setup-vm.sh's rule for its own secrets). The relay's copy is the
  # source of truth when there is one: after --remote the worker's file holds the CLUSTER's token,
  # and switching back must restore the one the local relay accepts -- never hand it the cluster's.
  token="$(env_value "SH_RELAY_TOKEN_$MICROVM_SANDBOX_ID" "$relay")"
  if [[ -z "$token" && "$(env_value RELAY_TLS "$worker")" != true ]]; then
    token="$(env_value SANDBOX_TOKEN "$worker")"
  fi
  if [[ -z "$token" ]]; then
    token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    [[ ${#token} == 64 ]] || die "could not generate a relay token"
  fi
  render_env "$worker" \
    set RELAY_ADDR "127.0.0.1:$port" \
    set SANDBOX_ID "$MICROVM_SANDBOX_ID" \
    set SANDBOX_TOKEN "$token" \
    keep SH_WORKSPACE_IDLE "$MICROVM_WORKSPACE_IDLE" \
    drop RELAY_TLS '' \
    drop RELAY_CA_FILE ''
  commit_env "$worker"
  remove_if_present "$RELAY_CA_DST"
  # The relay's file is wholly installer-owned, so it is rendered from scratch rather than merged:
  # a changed MICROVM_SANDBOX_ID must not leave the OLD id's token behind, still valid at the relay.
  (umask 077; printf 'SH_RELAY_TOKEN_%s=%s\n' "$MICROVM_SANDBOX_ID" "$token" >"$relay.new")
  commit_env "$relay"
}

# --remote: the worker env comes from the bundle; the CA is not secret (0644). A stale
# microvm-relay.env is left in place, so switching back restores the local token.
install_env_remote() {
  local worker="$SH_ENV_DIR/microvm-worker.env" ca
  if [[ -n "$B_CA" ]]; then
    install_if_changed "$B_CA" "$RELAY_CA_DST" 0644
    ca=(set RELAY_CA_FILE "$RELAY_CA_DST")
  else
    remove_if_present "$RELAY_CA_DST"
    ca=(drop RELAY_CA_FILE '')
  fi
  render_env "$worker" \
    set RELAY_ADDR "$B_ADDR" \
    set RELAY_TLS true \
    set SANDBOX_ID "$B_ID" \
    set SANDBOX_TOKEN "$B_TOKEN" \
    keep SH_WORKSPACE_IDLE "$MICROVM_WORKSPACE_IDLE" \
    "${ca[@]}"
  commit_env "$worker"
}

changed_any() { # changed_any <path>...: true iff one of them is in CHANGED
  local c p
  for p in "$@"; do for c in "${CHANGED[@]+"${CHANGED[@]}"}"; do [[ "$c" == "$p" ]] && return 0; done; done
  return 1
}

apply() {
  local relay_restart=0
  if changed_any "$SH_UNIT_DIR/microvm-worker.service" "$SH_UNIT_DIR/microvm-vms.slice" \
    "$SH_UNIT_DIR/sh-relay.service.d/$RELAY_DROPIN" "$SH_UNIT_DIR/microvm-worker.service.d/$WORKER_DROPIN" \
    "$SH_UNIT_DIR/microvm-worker.service.d/$REMOTE_DROPIN" "$SH_UNIT_DIR/microvm-worker.service.d/$MEMORY_DROPIN"; then
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
    "$SH_UNIT_DIR/microvm-worker.service.d/$REMOTE_DROPIN" "$SH_UNIT_DIR/microvm-worker.service.d/$MEMORY_DROPIN" \
    "$SH_ENV_DIR/microvm-worker.env" "$RELAY_CA_DST"; then
    systemctl stop microvm-worker.service
    start_worker
  elif ! systemctl is-active --quiet microvm-worker.service; then
    # Nothing changed, but the worker is not running -- the usual state after a snapshot problem
    # put it in `failed` (the unit's StartLimitBurst), which a rebuilt snapshot does not undo. A
    # re-run is how an operator expects to bring it back, and a running worker is left alone.
    log "microvm-worker.service is not running; starting it"
    systemctl reset-failed microvm-worker.service || true
    start_worker
  fi
}

# start_worker drops the worker's presence record BEFORE starting it, so verify_attached can only
# see a record the NEW process wrote. Records have no TTL, and a relay that died without its
# teardown leaves the previous connection's behind -- which would read as "attached" even when the
# new worker's attach is refused (a token mismatch, the silent failure that check exists for).
start_worker() {
  [[ -n "$REMOTE_BUNDLE" ]] || podman exec sh-redis redis-cli HDEL sh:sandbox:records "$MICROVM_SANDBOX_ID" >/dev/null
  systemctl start microvm-worker.service
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

# --remote cannot read the cluster's presence records, so the worker's own log is the evidence: its
# "attached, serving execs" line, read from the CURRENT process's journal (its InvocationID). A
# timestamp would also match the previous process's line, and an unchanged re-run -- worker left
# running -- logged its line before any timestamp this run could take. Captured, not piped into
# `grep -q`: under pipefail grep's early exit would SIGPIPE journalctl and fail the match.
#
# "attached" alone is not proof: the worker logs it as soon as its stream opens, before the relay
# has read the first frame. A wrong or revoked token is refused there -- the relay ends the stream,
# and the worker logs "stream ended" within milliseconds and reconnects, attached/ended in a loop.
# So an attach counts only once it has held for MICROVM_ATTACH_SETTLE seconds: the same invocation,
# and of its attached / stream-ended lines the LAST is an attached one.
last_attach_holds() { # last_attach_holds <journal text>
  local line last=''
  while IFS= read -r line; do
    case "$line" in *"attached, serving execs"* | *"stream ended"*) last="$line" ;; esac
  done <<<"$1"
  [[ "$last" == *"attached, serving execs"* ]]
}

verify_attached_remote() {
  local i inv='' now out
  for ((i = 0; i < MICROVM_ATTACH_TIMEOUT; i++)); do
    inv="$(systemctl show -p InvocationID --value microvm-worker.service)" || inv=''
    if [[ -n "$inv" ]]; then
      out="$(journalctl -q -o cat "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null || true)"
      if [[ "$out" == *"attached, serving execs"* ]]; then
        sleep "$MICROVM_ATTACH_SETTLE"
        now="$(systemctl show -p InvocationID --value microvm-worker.service)" || now=''
        out="$(journalctl -q -o cat "_SYSTEMD_INVOCATION_ID=$inv" 2>/dev/null || true)"
        if [[ "$now" == "$inv" ]] && last_attach_holds "$out"; then
          log "$MICROVM_SANDBOX_ID is attached to the relay at $B_ADDR"
          return 0
        fi
      fi
    fi
    sleep 1
  done
  die "$MICROVM_SANDBOX_ID did not stay attached to $B_ADDR within ${MICROVM_ATTACH_TIMEOUT}s (a wrong or revoked token, TLS or DNS); the reason is in: journalctl -u microvm-worker _SYSTEMD_INVOCATION_ID=$inv"
}

main() {
  parse_args "$@"
  preflight
  install_worker_binary
  install_units
  if [[ -n "$REMOTE_BUNDLE" ]]; then install_env_remote; else install_env; fi
  apply
  if [[ -n "$REMOTE_BUNDLE" ]]; then verify_attached_remote; else verify_attached; fi
  if ((${#CHANGED[@]})); then log "changed: ${CHANGED[*]}"; else log "nothing to change"; fi
}

if [[ "${SH_SOURCE_ONLY:-}" != 1 ]]; then main "$@"; fi
