#!/usr/bin/env bash
# Bring up the P6 single-VM deployment: Redis, relay, sandbox containers, supervisor unit.
# Sibling of deploy/knative/setup-kind.sh and setup-ocp.sh (spec §4.4).
#
# Prerequisites:
#   - a Linux VM with systemd and podman, Node 22+
#   - run as a user that can sudo to root (installs units under /etc/systemd/system)
#
# Usage:
#   ./deploy/vm/setup-vm.sh
#
# Env overrides:
#   SH_UNIT_DIR       Where systemd unit files are installed (default /etc/systemd/system)
#   SH_ENV_DIR        Where the supervisor/relay env files live (default /etc/moca)
#   SH_INSTALL_DIR    Where the harness checkout lives on the VM (default /opt/moca)
#   SH_SANDBOX_COUNT     Number of sandbox containers to start (default 2)
#   SANDBOX_IMAGE        Sandbox container image (default
#                          ghcr.io/rossoctl/moca-remote-worker:latest, the image
#                          that attaches to the relay -- compose's sandbox image too)
#   SH_SANDBOX_RELAY_ADDR  Address each sandbox container uses to dial the relay (default
#                          host.containers.internal:<SH_RELAY_PORT from relay.env>). Reaching
#                          the host from inside a container is the part of this script least
#                          verified on real hardware -- override this if the default does not
#                          resolve on your VM (see deploy/vm/README.md). install_sandbox_firewall
#                          opens the port from THIS address, not SH_RELAY_PORT unconditionally,
#                          so overriding it also changes which port the firewall opens.
#   MOCA_SANDBOX_SUBNET    Dedicated podman network subnet for sandbox containers (default
#                          10.89.40.0/24). MI1 R8: sandboxes no longer share the default podman
#                          network, so the firewall below can name this subnet precisely.
#   MOCA_SANDBOX_GATEWAY   Gateway address on that subnet (default 10.89.40.1); also what
#                          host.containers.internal resolves to inside a sandbox container.
#   MOCA_SANDBOX_BRIDGE    Name of that network's bridge interface (default moca-sandbox0, at most
#                          15 characters). The firewall matches sandbox traffic by the bridge it
#                          arrives on, so it covers every address family, IPv6 link-local included.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${SH_UNIT_DIR:=/etc/systemd/system}"
: "${SH_ENV_DIR:=/etc/moca}"
: "${SH_INSTALL_DIR:=/opt/moca}"
: "${SH_SANDBOX_COUNT:=2}"
: "${SANDBOX_IMAGE:=ghcr.io/rossoctl/moca-remote-worker:latest}"
MOCA_SANDBOX_SUBNET="${MOCA_SANDBOX_SUBNET:-10.89.40.0/24}"
MOCA_SANDBOX_GATEWAY="${MOCA_SANDBOX_GATEWAY:-10.89.40.1}"
MOCA_SANDBOX_BRIDGE="${MOCA_SANDBOX_BRIDGE:-moca-sandbox0}"

log() { printf '==> %s\n' "$*"; }

require_cmds() {
  local missing=()
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  if ((${#missing[@]})); then
    echo "missing required commands: ${missing[*]}" >&2
    return 1
  fi
}

# Both units run as User=harness/Group=harness; nothing here creates that account (uid
# policy, shell, and home are an operator decision, not this script's to make). Fail loudly
# before install_units, naming the account and the units that need it, instead of letting
# systemd fail later with a confusing "user harness does not exist".
# install -d -m 0750 /etc/moca and systemctl enable both need root. Failing here
# with a clear message beats dying partway through on a confusing `install: Permission denied`.
# uid defaults to the real effective uid (via `id -u`, not $EUID, so a test can override it
# without actually running as another user). main() always calls this with zero arguments --
# only the test suite passes one -- so shellcheck's cross-call-site analysis of this file alone
# cannot see a call that uses $1, hence the disable below.
# shellcheck disable=SC2120
require_root() {
  local uid="${1:-}"
  [[ -n "$uid" ]] || uid="$(id -u)"
  if [[ "$uid" != "0" ]]; then
    echo "must run as root: this installs systemd units under $SH_UNIT_DIR and files under" \
      "$SH_ENV_DIR. Re-run as: sudo $0" >&2
    return 1
  fi
}

# ExecStart is `node --import tsx src/main.ts`; tsx is a devDependency and the workspace's
# link: targets (harness -> pi-fork) only resolve after root `pnpm install`, and pi-fork's own
# type/JS output only exists after its own build (spec §9). A fresh VM checkout has run neither,
# so both units would die with ERR_MODULE_NOT_FOUND. Building here would take minutes inside a
# bring-up script that is supposed to be fast and idempotent -- fail loudly instead, naming the
# exact commands, and let the operator run them once.
#
# root defaults to the repo root two levels above this script (deploy/vm/../..), overridable
# by SH_REPO_ROOT, itself overridable by a positional argument -- production behaviour
# (running unmodified, with no env var set) is unchanged; SH_REPO_ROOT exists only so a test
# can point this at a fabricated tree without needing a second real checkout or claiming this
# script's own worktree is built when the caller (e.g. CI's toolchain-free deploy-scripts job)
# never ran pnpm install or built pi-fork. main() always calls this with zero arguments, same
# SC2120 rationale as require_root above.
# shellcheck disable=SC2120
require_build() {
  local root="${1:-${SH_REPO_ROOT:-$SCRIPT_DIR/../..}}"
  local missing=()
  [[ -d "$root/packages/supervisor/node_modules" ]] ||
    missing+=("pnpm install has not run (packages/supervisor/node_modules is missing)")
  if [[ ! -d "$root/pi-fork/packages/ai/dist" || ! -d "$root/pi-fork/packages/coding-agent/dist" ]]; then
    missing+=("pi-fork is not built (pi-fork/packages/{ai,coding-agent}/dist is missing)")
  fi
  if ((${#missing[@]})); then
    printf 'workspace is not built:\n' >&2
    printf '  - %s\n' "${missing[@]}" >&2
    echo "run, in order (spec §9): git submodule update --init --recursive; " \
      "cd pi-fork && npm ci && npm run build && cd ..; pnpm install" >&2
    return 1
  fi
}

require_user() {
  local user="$1"
  if ! getent passwd "$user" >/dev/null 2>&1; then
    echo "missing system user '$user': sh-supervisor.service and sh-relay.service both run" \
      "as User=$user/Group=$user. Create it first, e.g.:" \
      "sudo useradd --system --no-create-home --shell /usr/sbin/nologin $user" >&2
    return 1
  fi
}

install_units() {
  log "installing systemd units into $SH_UNIT_DIR"
  install -m 0644 "$SCRIPT_DIR/systemd/sh-supervisor.service" "$SH_UNIT_DIR/"
  install -m 0644 "$SCRIPT_DIR/systemd/sh-relay.service" "$SH_UNIT_DIR/"
  systemctl daemon-reload
}

# install_env_file <name> <hint> installs deploy/vm/env/<name>.env.example to
# $SH_ENV_DIR/<name>.env, once. Never clobber an operator-edited env file: it holds the S
# that an E8 run established (supervisor.env) or the shared token a worker was configured
# with (relay.env) — either one, a silent overwrite on re-run would be a real outage.
install_env_file() {
  local name="$1" hint="${2:-}"
  if [[ ! -f "$SH_ENV_DIR/$name.env" ]]; then
    install -m 0640 "$SCRIPT_DIR/env/$name.env.example" "$SH_ENV_DIR/$name.env"
    log "wrote $SH_ENV_DIR/$name.env${hint:+ — $hint}"
  else
    log "keeping existing $SH_ENV_DIR/$name.env"
  fi
}

install_env() {
  install -d -m 0750 "$SH_ENV_DIR"
  install_env_file supervisor "set SH_TURNS_PER_WORKER before starting"
  install_env_file relay "set SH_RELAY_TOKEN before starting"
}

start_redis() {
  log "starting Redis container"
  # LOOPBACK ONLY, and this is the execution path rather than a data-at-rest concern.
  #
  # `-p 6379:6379` binds 0.0.0.0 in podman, and this image runs with no --requirepass, no ACL and no
  # TLS. On THIS deployment the supervisor ships SH_SANDBOX_DISCOVERY=records
  # (env/supervisor.env.example), and select-sandbox.ts honours that by never listing pods:
  # `const pods = source === 'records' ? [] : await list(...)`. So the only inventory of executors is
  # a set of Redis records. Anyone who can write to Redis chooses the sandbox every turn dispatches
  # to -- receiving the user's prompts and repository contents and returning whatever they like as
  # the agent's output. Admission control, the fail-closed relay token and RestrictAddressFamilies on
  # both units are all bypassed, because none of them is in that path.
  #
  # Nothing loses access: both env templates already point at redis://127.0.0.1:6379, and the sandbox
  # containers reach the RELAY, not Redis -- start_sandboxes hands them RELAY_ADDR, SANDBOX_TOKEN and
  # SANDBOX_ID and nothing else.
  #
  # The invariant was already written down for the admin listener (setup-vm.test.sh asserts it binds
  # 127.0.0.1 *because* it is unauthenticated). It simply had not been applied to the listener that
  # exposes session state, the ownership index, the lease store and sh:sandbox:records.
  #
  # NO VOLUME, deliberately for this round: session state, the ownership index and the lease store
  # are lost on every reboot and on every `podman rm` of this container. That is acceptable only
  # because this deployment exists to run E8 rungs, where each run starts from an empty Redis
  # anyway. It is stated here (and in README.md's "What round one does not claim") rather than left
  # for an operator to discover after a reboot: --restart=always below brings the container back,
  # not the data that was in it.
  podman run -d --name sh-redis --replace --restart=always \
    -p 127.0.0.1:6379:6379 docker.io/redis:7-alpine
}

# Podman's --restart=always covers a container that exits, but explicitly NOT a host reboot:
# podman-run(1) says "--restart will not restart containers after a system reboot", and points at
# podman-restart.service as the supported way to get that. Without it, the units come back on boot
# (both are WantedBy=multi-user.target) while Redis and every sandbox container do not --
# sh:sandbox:records is empty and every turn fails until somebody re-runs this script, which is a
# far worse failure than a unit that refuses to start, because everything looks healthy.
#
# Not fatal if it is unavailable: this is one podman package's unit name, and a host where it is
# missing is a host with a working bring-up and a documented reboot gap, not a host that should
# refuse to install. Warn with the consequence named, since `set -e` would otherwise abort the whole
# script here on an older podman.
enable_container_restart() {
  log "enabling podman-restart.service (containers do not survive a reboot without it)"
  if ! systemctl enable podman-restart.service; then
    echo "WARNING: could not enable podman-restart.service. --restart=always still restarts a" \
      "container that exits, but podman-run(1) is explicit that it does NOT survive a host" \
      "reboot. After a reboot, re-run this script (or start sh-redis and the sh-sandbox-*" \
      "containers by hand) before expecting any turn to succeed." >&2
  fi
}

# remote-worker/cmd/worker/main.go:93-105 reads RELAY_ADDR (default localhost:8443),
# SANDBOX_TOKEN (default dev-token), and SANDBOX_ID (default sbx-laptop-1) from its own
# environment. A bare `podman run` with none of those set means: "localhost" resolves to the
# container itself, not the host, so the worker can never reach the relay; every container
# shares one SANDBOX_ID and collides on the same Redis record; and dev-token never matches a
# fail-closed relay. relay_port/relay_token read the INSTALLED relay.env (not the .example),
# so they see the operator's real values once install_env has run. file defaults to
# $SH_ENV_DIR/relay.env; a caller may override it for testing.
# R46 (see setup-vm.test.sh): under `set -euo pipefail`, a no-match grep aborts the whole
# script right here rather than leaving these functions to report "no token"/"default port" --
# `|| true` on the grep stage keeps a missing SH_RELAY_TOKEN/SH_RELAY_PORT line a normal empty
# result instead of a fatal error. sandbox_relay_addr below always calls this with zero
# arguments -- only the test suite passes a file override -- same SC2120 rationale as
# require_root/require_build above.
# shellcheck disable=SC2120
relay_port() {
  local file="${1:-$SH_ENV_DIR/relay.env}"
  local port
  port="$( (grep -oE '^SH_RELAY_PORT=[0-9]+' "$file" 2>/dev/null || true) | tail -1 | cut -d= -f2)"
  echo "${port:-8443}"
}

relay_token() {
  local file="${1:-$SH_ENV_DIR/relay.env}"
  local token
  token="$( (grep -oE '^SH_RELAY_TOKEN=.+' "$file" 2>/dev/null || true) | tail -1 | cut -d= -f2-)"
  # systemd's EnvironmentFile= strips exactly one matched pair of surrounding quotes before
  # handing the value to the relay's own process (systemd.exec(5), "Environment Variables in
  # Spawned Processes") -- so an operator writing SH_RELAY_TOKEN="s3cr3t" gives the relay
  # s3cr3t, not "s3cr3t". Strip the same single matched pair here so this function always
  # returns what the relay actually validates against; otherwise start_sandboxes would hand
  # every container the quoted literal, the fail-closed validator would reject every attach,
  # and require_relay_token's non-empty check would still pass -- the exact silently-empty
  # sh:sandbox:records outcome B5 exists to prevent, reachable through an ordinary quoting habit.
  if ((${#token} >= 2)); then
    case "$token" in
    \"*\")
      token="${token#\"}"
      token="${token%\"}"
      ;;
    \'*\')
      token="${token#\'}"
      token="${token%\'}"
      ;;
    esac
  fi
  echo "$token"
}

# The relay's token validation is fail-closed (makeDefaultValidateToken in
# packages/sandbox-relay/src/main.ts): with SH_RELAY_TOKEN unset, every attach -- including a
# tokenless one -- is rejected. relay.env.example ships it commented out on purpose (an
# operator secret, not a default), so a fresh install produces a relay.env that cannot
# authenticate a single sandbox. Fail loudly here, before start_sandboxes ever runs a
# container that is guaranteed to fail to attach, instead of leaving that discovery to a
# silently-empty sh:sandbox:records set on the VM. main() always calls this with zero
# arguments, same SC2120 rationale as require_root/require_build above.
# shellcheck disable=SC2120
require_relay_token() {
  local file="${1:-$SH_ENV_DIR/relay.env}"
  if [[ -z "$(relay_token "$file")" ]]; then
    echo "SH_RELAY_TOKEN is not set in $file: the relay's token validation is fail-closed" \
      "(packages/sandbox-relay/src/main.ts), so every sandbox attach would be rejected." \
      "Set SH_RELAY_TOKEN there to a shared secret matching each worker's SANDBOX_TOKEN, then" \
      "re-run." >&2
    return 1
  fi
}

# The workers' credential for the relay's SandboxExec (MI1 §5 R5). Only the relay and the
# supervisor hold it, so it is generated here when absent -- into BOTH files, one value -- and an
# existing value is never replaced. It is never handed to a sandbox container (start_sandboxes).
# Terminate an operator-edited file's last line before appending to it: `>>` onto a file with no final
# newline glues the new assignment onto the last one (SH_RELAY_TOKEN=<t>MOCA_RELAY_EXEC_TOKEN=...),
# silently changing that value. $(...) strips a trailing newline, so it is empty only when the file
# already ends in one.
end_with_newline() {
  if [[ -s "$1" && -n "$(tail -c 1 "$1")" ]]; then printf '\n' >>"$1"; fi
}

ensure_exec_token() {
  local relay="$SH_ENV_DIR/relay.env" sup="$SH_ENV_DIR/supervisor.env" token
  token="$( (grep -oE '^MOCA_RELAY_EXEC_TOKEN=.+' "$relay" 2>/dev/null || true) | tail -1 | cut -d= -f2-)"
  if [[ -z "$token" ]]; then
    token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    [[ -n "$token" ]] || { echo "could not generate MOCA_RELAY_EXEC_TOKEN" >&2; return 1; }
    end_with_newline "$relay"
    (umask 077; printf 'MOCA_RELAY_EXEC_TOKEN=%s\n' "$token" >>"$relay")
  fi
  if ! grep -qE "^MOCA_RELAY_EXEC_TOKEN=${token}\$" "$sup" 2>/dev/null; then
    local tmp
    tmp="$(mktemp)"
    { grep -vE '^MOCA_RELAY_EXEC_TOKEN=' "$sup" 2>/dev/null || true; printf 'MOCA_RELAY_EXEC_TOKEN=%s\n' "$token"; } >"$tmp"
    cat "$tmp" >"$sup"
    rm -f "$tmp"
  fi
}

# env_file_value <key> <file> prints the last <key>= value in <file>, with one matched pair of
# surrounding quotes stripped the way systemd's EnvironmentFile= strips them (see relay_token).
env_file_value() {
  local v
  v="$( (grep -oE "^$1=.*" "$2" 2>/dev/null || true) | tail -1 | cut -d= -f2-)"
  if ((${#v} >= 2)); then
    case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
    esac
  fi
  printf '%s' "$v"
}

# The relay serves SandboxExec on its own loopback listener (MOCA_RELAY_EXEC_ADDR) and the
# supervisor dials it (SH_RELAY_ADDR) -- MI1 §5 R5. install_env never rewrites an existing env file,
# so on a VM set up before MI1 relay.env has no MOCA_RELAY_EXEC_ADDR (one listener for everything)
# and supervisor.env dials PRE_MI1_RELAY_ADDR. That exact pair is migrated here, both files together,
# to the templates' split listener. A pair that already agrees (the two ports equal) is left alone.
# Anything else -- one file migrated and not the other, or ports that disagree -- is refused, naming
# both values: guessing would leave the supervisor dialing a port nothing serves SandboxExec on.
PRE_MI1_RELAY_ADDR="127.0.0.1:9443"
ensure_exec_listener() {
  local relay="$SH_ENV_DIR/relay.env" sup="$SH_ENV_DIR/supervisor.env"
  local exec_addr dial_addr new_addr tmp
  exec_addr="$(env_file_value MOCA_RELAY_EXEC_ADDR "$relay")"
  dial_addr="$(env_file_value SH_RELAY_ADDR "$sup")"
  if [[ -n "$exec_addr" && -n "$dial_addr" && "${exec_addr##*:}" == "${dial_addr##*:}" ]]; then
    return 0
  fi
  if [[ -z "$exec_addr" && "$dial_addr" == "$PRE_MI1_RELAY_ADDR" ]]; then
    new_addr="$(env_file_value MOCA_RELAY_EXEC_ADDR "$SCRIPT_DIR/env/relay.env.example")"
    [[ -n "$new_addr" ]] || { echo "relay.env.example has no MOCA_RELAY_EXEC_ADDR" >&2; return 1; }
    if [[ "${new_addr##*:}" == "$(relay_port "$relay")" ]]; then
      echo "cannot migrate to the split exec listener: relay.env's SH_RELAY_PORT is" \
        "$(relay_port "$relay"), the port MOCA_RELAY_EXEC_ADDR=$new_addr would take. Set" \
        "MOCA_RELAY_EXEC_ADDR in $relay and SH_RELAY_ADDR in $sup to one free loopback port," \
        "then re-run." >&2
      return 1
    fi
    log "migrating to the split exec listener: MOCA_RELAY_EXEC_ADDR=$new_addr in $relay," \
      "SH_RELAY_ADDR=$new_addr in $sup"
    end_with_newline "$relay"
    printf 'MOCA_RELAY_EXEC_ADDR=%s\n' "$new_addr" >>"$relay"
    tmp="$(mktemp)"
    sed -E "s|^SH_RELAY_ADDR=.*\$|SH_RELAY_ADDR=$new_addr|" "$sup" >"$tmp"
    cat "$tmp" >"$sup" # in place, so the file keeps its owner and mode
    rm -f "$tmp"
    return 0
  fi
  echo "relay.env and supervisor.env disagree on the relay's exec listener:" \
    "MOCA_RELAY_EXEC_ADDR=${exec_addr:-<unset>} ($relay), SH_RELAY_ADDR=${dial_addr:-<unset>} ($sup)." \
    "The supervisor must dial the port the relay serves SandboxExec on. Set both to the same" \
    "loopback address (the templates use $(env_file_value MOCA_RELAY_EXEC_ADDR "$SCRIPT_DIR/env/relay.env.example")), then re-run." >&2
  return 1
}

# Sandboxes run on their OWN podman network (MI1 §5 R8), with a fixed subnet so the firewall below
# can name it, and with isolate=strict so it exchanges no traffic with any other podman network --
# sh-redis runs on podman's default one. --ignore: a re-run finds it already there. If an operator
# pre-created moca-sandbox with another subnet, set MOCA_SANDBOX_SUBNET/MOCA_SANDBOX_GATEWAY to match
# it. --ignore accepts a pre-existing network unconditionally, though, so this also reads back the
# live subnet/gateway, isolate option and bridge name and fails closed on a mismatch, rather than
# letting the firewall below install rules for a network that does not have the expected values.
# The read-back proves only what podman STORED. A podman that rejects isolate=strict fails the create
# here, but one that accepts and stores the option over a netavark too old to enforce it passes every
# check below. Nothing in setup can detect that; the live verification that isolation is enforced ran
# on netavark 1.17.2 (MI1 S1, PR #350). Use a netavark at least that recent.
ensure_sandbox_network() {
  podman network create --ignore --subnet "$MOCA_SANDBOX_SUBNET" --gateway "$MOCA_SANDBOX_GATEWAY" \
    --opt isolate=strict --interface-name "$MOCA_SANDBOX_BRIDGE" moca-sandbox
  local expected="$MOCA_SANDBOX_SUBNET $MOCA_SANDBOX_GATEWAY" actual isolate bridge
  actual="$(podman network inspect moca-sandbox --format '{{range .Subnets}}{{.Subnet}} {{.Gateway}}{{end}}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "moca-sandbox network exists with subnet/gateway '$actual', but" \
      "MOCA_SANDBOX_SUBNET/MOCA_SANDBOX_GATEWAY expect '$expected'." \
      "install_sandbox_firewall writes its rules against the expected values, so recreate the" \
      "network to match, or set MOCA_SANDBOX_SUBNET/MOCA_SANDBOX_GATEWAY to the network's actual" \
      "values, then re-run." >&2
    return 1
  fi
  isolate="$(podman network inspect moca-sandbox --format '{{index .Options "isolate"}}')"
  if [[ "$isolate" != "strict" ]]; then
    [[ -n "$isolate" && "$isolate" != "<no value>" ]] || isolate="<unset>"
    echo "moca-sandbox network has isolate=$isolate, but setup expects isolate=strict: sandboxes" \
      "must exchange no traffic with any other podman network. Stop the sh-sandbox-* containers," \
      "remove the network (podman network rm moca-sandbox), then re-run -- with a netavark that" \
      "supports isolate=strict." >&2
    return 1
  fi
  bridge="$(podman network inspect moca-sandbox --format '{{.NetworkInterface}}')"
  if [[ "$bridge" != "$MOCA_SANDBOX_BRIDGE" ]]; then
    echo "moca-sandbox network's bridge interface is '$bridge', but setup expects" \
      "'$MOCA_SANDBOX_BRIDGE': the firewall matches sandbox traffic by that bridge. Stop the" \
      "sh-sandbox-* containers, remove the network (podman network rm moca-sandbox), then re-run," \
      "or set MOCA_SANDBOX_BRIDGE to the network's actual bridge." >&2
    return 1
  fi
}

# Traffic from the sandbox network TO THIS HOST is dropped except the address sandboxes actually
# dial (sandbox_relay_addr(), which SH_SANDBOX_RELAY_ADDR may point at a different port than
# relay_port()) and DNS (podman's resolver answers on the gateway), both over IPv4 from the
# sandbox subnet. The rules match the bridge a packet arrives on, not only its source address:
# netavark leaves IPv6 enabled on the bridge and in every container, so link-local IPv6 reaches the
# host even though the network has no IPv6 subnet, and everything on the bridge that is not one of
# the three accepts (established/related replies, and the two IPv4 ones) -- IPv6 included -- is
# dropped. Forwarded (internet) traffic is
# untouched in S1; MI1 S5 routes it through moca-egress. The declare/delete/redeclare idiom makes
# `nft -f` replace the table atomically, so a re-run never stacks duplicate rules. The checked-in
# unit carries an @SH_ENV_DIR@ placeholder rather than a literal path -- SH_ENV_DIR is itself
# overridable, so this renders the placeholder into the real value before installing the unit. The
# same for @NFT@: require_cmds accepts nft anywhere on PATH, so the unit runs the nft this script
# ran, not a hardcoded /usr/sbin/nft that dies 203/EXEC on a distro shipping it in /usr/bin.
install_sandbox_firewall() {
  local attach nft="$SH_ENV_DIR/moca-sandbox.nft" tmp_unit nft_bin
  nft_bin="$(command -v nft)"
  [[ "$nft_bin" == /* ]] || { echo "nft resolves to '$nft_bin', not an absolute path the unit can run" >&2; return 1; }
  attach="$(sandbox_relay_addr)"
  attach="${attach##*:}"
  cat >"$nft" <<NFT
table inet moca_sandbox
delete table inet moca_sandbox
table inet moca_sandbox {
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "$MOCA_SANDBOX_BRIDGE" ct state established,related accept
    iifname "$MOCA_SANDBOX_BRIDGE" ip saddr $MOCA_SANDBOX_SUBNET tcp dport $attach accept
    iifname "$MOCA_SANDBOX_BRIDGE" ip saddr $MOCA_SANDBOX_SUBNET meta l4proto { tcp, udp } th dport 53 accept
    iifname "$MOCA_SANDBOX_BRIDGE" counter drop
    ip saddr $MOCA_SANDBOX_SUBNET counter drop
  }
}
NFT
  nft -f "$nft"
  tmp_unit="$(mktemp)"
  sed -e "s|@SH_ENV_DIR@|$SH_ENV_DIR|g" -e "s|@NFT@|$nft_bin|g" \
    "$SCRIPT_DIR/systemd/moca-sandbox-firewall.service" >"$tmp_unit"
  install -m 0644 "$tmp_unit" "$SH_UNIT_DIR/moca-sandbox-firewall.service"
  rm -f "$tmp_unit"
  systemctl daemon-reload
  systemctl enable moca-sandbox-firewall.service
  # The table is already loaded by the nft -f above; start only marks the unit active, and the
  # rendered unit takes effect at the next boot. Never restart it: through RequiredBy= a restart
  # also restarts podman-restart.service, which stops every --restart=always container on the host.
  systemctl start moca-sandbox-firewall.service
}

# Reaching the host's relay port from inside a container has been confirmed on one real host
# (deploy/vm/README.md lists what was and was not verified there).
# host.containers.internal is podman's documented analogue of Docker's host.docker.internal
# (podman-run(1): the host-gateway special string), but the alias is now pinned to the
# moca-sandbox gateway rather than podman's host-gateway value: host-gateway resolves to whatever
# the host actually listens on, which is every port bound to 0.0.0.0, not just the relay's attach
# port (MI1 R8). install_sandbox_firewall is what actually restricts that reachability;
# --add-host here only controls what address a sandbox dials. SH_SANDBOX_RELAY_ADDR overrides the
# whole address if this default does not reach the relay on your VM's actual network setup.
sandbox_relay_addr() {
  echo "${SH_SANDBOX_RELAY_ADDR:-host.containers.internal:$(relay_port)}"
}

start_sandboxes() {
  log "starting $SH_SANDBOX_COUNT sandbox containers"
  local i token addr
  token="$(relay_token)"
  addr="$(sandbox_relay_addr)"
  for ((i = 0; i < SH_SANDBOX_COUNT; i++)); do
    # SANDBOX_TOKEN is passed BY NAME (`-e SANDBOX_TOKEN`, no `=`), so podman takes the value from
    # its own environment and the secret never enters argv. `-e "SANDBOX_TOKEN=$token"` would put it
    # in this process's command line, and /proc/<pid>/cmdline is world-readable on Linux unless
    # hidepid is set -- so for the lifetime of each of these invocations any unprivileged local user
    # running `ps` in a loop reads the token that require_relay_token just insisted must be a real
    # secret. The token is the whole of the relay's authentication (makeDefaultValidateToken is
    # fail-closed), so holding it means being able to attach as a sandbox, i.e. to become an executor.
    SANDBOX_TOKEN="$token" podman run -d --name "sh-sandbox-$i" --replace --restart=always \
      --network moca-sandbox \
      --add-host "host.containers.internal:$MOCA_SANDBOX_GATEWAY" \
      -e "SANDBOX_ID=sh-sandbox-$i" \
      -e "RELAY_ADDR=$addr" \
      -e SANDBOX_TOKEN \
      "$SANDBOX_IMAGE"
  done
}

start_services() {
  log "enabling and restarting the relay; enabling the supervisor (restarted only if running)"
  # `enable --now` leaves an already-running unit alone, so a re-run's env and unit changes would
  # wait for the next reboot. restart applies them now (and starts the relay on a fresh install).
  systemctl enable sh-relay.service
  systemctl restart sh-relay.service
  # SH_TURNS_PER_WORKER ships empty on purpose (§3.8) and readConfig throws on blank, so this
  # unit is EXPECTED to fail until the operator sets it. Restart=always/RestartSec=2 with no
  # StartLimitIntervalSec=0 means systemd's default 5-starts-in-10s limit trips in about ten
  # seconds if this were `enable --now`, after which even the documented recovery command
  # (`systemctl start sh-supervisor.service`) is refused with "start request repeated too
  # quickly" until `systemctl reset-failed`. Enable without --now instead: the unit is wired
  # into multi-user.target for the next boot, but nothing tries to start it yet. try-restart then
  # restarts it only if it is already running -- a re-run's env reaches a configured supervisor,
  # and an unconfigured one stays stopped.
  systemctl enable sh-supervisor.service
  systemctl try-restart sh-supervisor.service
}

main() {
  require_cmds podman systemctl install node getent pnpm nft
  require_root
  require_build
  require_user harness
  install_env
  require_relay_token
  ensure_exec_token
  ensure_exec_listener
  install_units
  # Before the containers, so a `podman run` that lands between the two is already covered.
  enable_container_restart
  start_redis
  ensure_sandbox_network
  install_sandbox_firewall
  start_sandboxes
  start_services
  log "done — relay is running. Before starting the supervisor, set SH_TURNS_PER_WORKER in" \
    "$SH_ENV_DIR/supervisor.env, then: systemctl start sh-supervisor.service"
}

# Sourcing guard: lets the test load these functions without touching the machine.
if [[ -z "${SH_SOURCE_ONLY:-}" ]]; then
  main "$@"
fi
