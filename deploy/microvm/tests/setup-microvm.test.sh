#!/usr/bin/env bash
# deploy/microvm/tests/setup-microvm.test.sh
#
# Root-free, KVM-free test for setup-microvm.sh. podman, systemctl, id and go are mocked onto PATH
# and log their argv; the installer runs against a temp SH_UNIT_DIR/SH_ENV_DIR/SH_BIN_DIR seeded with
# the two P6 files it reads. Asserts: refusals happen before anything is written, the token is
# generated once and shared by exactly the two files that need it, and a re-run changes nothing.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/setup-microvm.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }

export MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
printf 'podman %s\n' "$*" >>"$MOCK_LOG"
case "$1" in
  ps) [ -n "${MOCK_PODMAN_PS:-}" ] && printf '%s\n' $MOCK_PODMAN_PS
      # Stopped containers are listed only with -a, as podman does.
      [[ " $* " == *" -a "* && -n "${MOCK_PODMAN_PS_STOPPED:-}" ]] && printf '%s\n' $MOCK_PODMAN_PS_STOPPED ;;
  exec) echo "${MOCK_HEXISTS:-1}" ;; # redis-cli HEXISTS sh:sandbox:records <id>
esac
exit 0
MOCK
cat >"$TMP/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$MOCK_LOG"
# is-active answers MOCK_IS_ACTIVE's exit code (0 = active, 3 = inactive/failed, as systemd does).
[ "$1" = is-active ] && exit "${MOCK_IS_ACTIVE:-0}"
exit 0
MOCK
cat >"$TMP/bin/id" <<'MOCK'
#!/usr/bin/env bash
[ "$*" = "-u" ] && echo 0
MOCK
# go build -o <out> ...: write a deterministic fake binary so re-runs compare equal.
cat >"$TMP/bin/go" <<'MOCK'
#!/usr/bin/env bash
printf 'go %s\n' "$*" >>"$MOCK_LOG"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { printf 'fake-microvm-worker\n' >"$2"; }; shift; done
MOCK
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"

reset_host() { # a fresh P6 install: relay.env + sh-relay.service, a snapshot, nothing of ours
  rm -rf "${TMP:?}/units" "${TMP:?}/etc" "${TMP:?}/usrbin" "${TMP:?}/snap"
  mkdir -p "$TMP/units" "$TMP/etc" "$TMP/usrbin" "$TMP/snap"
  printf 'SH_RELAY_PORT=9443\nSH_RELAY_TOKEN=container-token\nMOCA_RELAY_EXEC_TOKEN=exec-secret\n' \
    >"$TMP/etc/relay.env"
  printf '[Service]\nExecStart=/bin/true\n' >"$TMP/units/sh-relay.service"
  printf '{}\n' >"$TMP/snap/manifest.json"
  : >"$MOCK_LOG"
}
export SH_UNIT_DIR="$TMP/units" SH_ENV_DIR="$TMP/etc" SH_BIN_DIR="$TMP/usrbin" \
  MICROVM_SNAPSHOT_DIR="$TMP/snap" MICROVM_ATTACH_TIMEOUT=1
run() { bash "$SCRIPT" >"$TMP/run.log" 2>&1; echo $?; }
val() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2-; }
hash_tree() { (cd "$TMP" && find units etc usrbin -type f -exec cksum {} + | sort); }

echo "== shellcheck"
if command -v shellcheck >/dev/null; then
  shellcheck "$SCRIPT"; check "shellcheck clean" "$?" "0"
fi

echo "== sourcing has no side effects"
reset_host
# shellcheck source=/dev/null
( SH_SOURCE_ONLY=1 source "$SCRIPT" )
check "no commands ran" "$(wc -l <"$MOCK_LOG" | tr -d ' ')" "0"

echo "== helpers"
# shellcheck source=/dev/null
SH_SOURCE_ONLY=1 source "$SCRIPT"
set +e # the script's own `set -euo pipefail` must not govern the rest of this test
check "underscore id accepted" "$(validate_sandbox_id moca_microvm_0 2>/dev/null && echo yes || echo no)" "yes"
check "dashed id refused (systemd drops the SH_RELAY_TOKEN_<id> line)" \
  "$(validate_sandbox_id sbx-microvm-1 2>/dev/null && echo yes || echo no)" "no"
printf 'SH_RELAY_PORT=9443\n' >"$TMP/p1"; check "plain port" "$(relay_port "$TMP/p1")" "9443"
printf 'SH_RELAY_PORT="9555"\n' >"$TMP/p2"; check "quoted port, as systemd strips it" "$(relay_port "$TMP/p2")" "9555"
printf 'REDIS_URL=x\n' >"$TMP/p3"; check "missing port falls back to the relay's 8443" "$(relay_port "$TMP/p3")" "8443"
printf 'SH_RELAY_PORT=abc\n' >"$TMP/p4"
check "non-numeric port refused" "$(relay_port "$TMP/p4" >/dev/null 2>&1 && echo yes || echo no)" "no"

echo "== first install"
reset_host
check "exit 0" "$(run)" "0"
W="$TMP/etc/microvm-worker.env"; R="$TMP/etc/microvm-relay.env"
tok="$(val SANDBOX_TOKEN "$W")"
check "a token was generated (64 hex chars)" "$(printf '%s' "$tok" | grep -cE '^[0-9a-f]{64}$')" "1"
check "the relay holds the SAME token under the per-sandbox name" "$(val SH_RELAY_TOKEN_moca_microvm_0 "$R")" "$tok"
check "worker dials the relay's attach port on loopback" "$(val RELAY_ADDR "$W")" "127.0.0.1:9443"
check "worker sandbox id" "$(val SANDBOX_ID "$W")" "moca_microvm_0"
check "workspace idle default" "$(val SH_WORKSPACE_IDLE "$W")" "8h"
check "worker env never carries the exec token" "$(grep -c 'MOCA_RELAY_EXEC_TOKEN' "$W")" "0"
check "worker env never carries the container token" "$(grep -c '^SH_RELAY_TOKEN' "$W")" "0"
check "worker env is 0600" "$(stat -f %Lp "$W" 2>/dev/null || stat -c %a "$W")" "600"
check "relay env is 0600" "$(stat -f %Lp "$R" 2>/dev/null || stat -c %a "$R")" "600"
check "P6's relay.env untouched" "$(val SH_RELAY_TOKEN "$TMP/etc/relay.env")" "container-token"
check "relay drop-in loads the new env file" \
  "$(grep -c "^EnvironmentFile=$TMP/etc/microvm-relay.env\$" "$TMP/units/sh-relay.service.d/50-moca-microvm.conf")" "1"
check "worker drop-in loads its env file" \
  "$(grep -c "^EnvironmentFile=$TMP/etc/microvm-worker.env\$" "$TMP/units/microvm-worker.service.d/50-moca-p6.conf")" "1"
check "worker is ordered after the relay" \
  "$(grep -c '^After=sh-relay.service$' "$TMP/units/microvm-worker.service.d/50-moca-p6.conf")" "1"
check "shipped unit installed verbatim" "$(cmp -s "$DIR/microvm-worker.service" "$TMP/units/microvm-worker.service" && echo yes || echo no)" "yes"
check "slice installed" "$([ -f "$TMP/units/microvm-vms.slice" ] && echo yes || echo no)" "yes"
check "binary installed" "$(cat "$TMP/usrbin/microvm-worker")" "fake-microvm-worker"
check "daemon-reload" "$(grep -c '^systemctl daemon-reload$' "$MOCK_LOG")" "1"
check "relay restarted to load the token" "$(grep -c '^systemctl restart sh-relay.service$' "$MOCK_LOG")" "1"
check "worker enabled" "$(grep -c '^systemctl enable microvm-worker.service$' "$MOCK_LOG")" "1"
check "worker stopped, its presence record cleared, then started -- in that order (I4)" \
  "$(grep -nE '^systemctl stop microvm-worker.service$|HDEL sh:sandbox:records moca_microvm_0$|^systemctl start microvm-worker.service$' "$MOCK_LOG" | cut -d: -f2- | sed 's/^podman exec sh-redis redis-cli //' | tr '\n' '|')" \
  "systemctl stop microvm-worker.service|HDEL sh:sandbox:records moca_microvm_0|systemctl start microvm-worker.service|"
check "attach verified against the presence records" \
  "$(grep -c 'podman exec sh-redis redis-cli HEXISTS sh:sandbox:records moca_microvm_0' "$MOCK_LOG")" "1"

echo "== a re-run changes nothing"
before="$(hash_tree)"; : >"$MOCK_LOG"
check "exit 0" "$(run)" "0"
check "every file byte-identical" "$(hash_tree)" "$before"
check "no daemon-reload" "$(grep -c 'daemon-reload' "$MOCK_LOG")" "0"
check "no restart" "$(grep -c 'restart' "$MOCK_LOG")" "0"
check "a running worker is not stopped or started" "$(grep -cE 'systemctl (stop|start) microvm-worker' "$MOCK_LOG")" "0"

echo "== a re-run starts a worker that is stopped or failed, restarting nothing (I1)"
: >"$MOCK_LOG"
check "exit 0" "$(MOCK_IS_ACTIVE=3 run)" "0"
check "files still byte-identical" "$(hash_tree)" "$before"
check "failed state cleared" "$(grep -c '^systemctl reset-failed microvm-worker.service$' "$MOCK_LOG")" "1"
check "worker started" "$(grep -c '^systemctl start microvm-worker.service$' "$MOCK_LOG")" "1"
check "stale presence record cleared first" "$(grep -c 'HDEL sh:sandbox:records moca_microvm_0$' "$MOCK_LOG")" "1"
check "nothing restarted" "$(grep -c 'restart' "$MOCK_LOG")" "0"

echo "== an operator's edit survives a re-run (Review Focus 1)"
sed -i.bak 's/^SH_WORKSPACE_IDLE=.*/SH_WORKSPACE_IDLE=12h/' "$W" && rm -f "$W.bak"
printf 'SH_DIAG_STATS_ADDR=127.0.0.1:9900\n' >>"$W"
: >"$MOCK_LOG"
check "exit 0" "$(run)" "0"
check "edited idle kept" "$(val SH_WORKSPACE_IDLE "$W")" "12h"
check "operator's extra line kept" "$(val SH_DIAG_STATS_ADDR "$W")" "127.0.0.1:9900"
check "token not rotated" "$(val SANDBOX_TOKEN "$W")" "$tok"
check "no restart (the installer did not change the file)" "$(grep -c 'restart' "$MOCK_LOG")" "0"

echo "== a changed sandbox id leaves no stale token at the relay"
: >"$MOCK_LOG"
check "exit 0" "$(MICROVM_SANDBOX_ID=moca_microvm_1 MOCK_HEXISTS=1 run)" "0"
check "only the new id's token line" "$(grep -c '^SH_RELAY_TOKEN_' "$R")" "1"
check "it names the new id" "$(grep -c '^SH_RELAY_TOKEN_moca_microvm_1=' "$R")" "1"
check "the relay was restarted to drop the old one" "$(grep -c '^systemctl restart sh-relay.service$' "$MOCK_LOG")" "1"

echo "== MICROVM_MAX_COMMITTED_MB: a budget for a host smaller than the shipped unit assumes"
M="$TMP/units/microvm-worker.service.d/60-moca-memory.conf"
: >"$MOCK_LOG"
check "exit 0" "$(MICROVM_SANDBOX_ID=moca_microvm_1 MICROVM_MAX_COMMITTED_MB=8192 run)" "0"
check "the budget reaches the worker" "$(grep -c '^Environment=SH_MAX_COMMITTED_MB=8192$' "$M")" "1"
# Same band systemd-units.test.sh holds the shipped unit to: AssertMemory at 90% of the budget.
check "the shipped AssertMemory is reset first" "$(grep -c '^AssertMemory=$' "$M")" "1"
check "then re-asserted at 90% of the budget" "$(grep -c '^AssertMemory=>=7372M$' "$M")" "1"
# `AssertMemory=` (empty) resets the WHOLE assertion list, not just AssertMemory (systemd.unit(5),
# verified on the rig: a unit asserting a missing path started once the reset was in a drop-in). So
# every other assertion the shipped unit makes -- /dev/kvm above all -- must be re-stated after it.
for a in $(grep -E '^Assert[A-Za-z]+=' "$DIR/microvm-worker.service" | grep -v '^AssertMemory='); do
  check "the drop-in re-states the shipped $a" "$(grep -cxF "$a" "$M")" "1"
done
check "the shipped unit has a non-memory assertion to re-state (else this test proves nothing)" \
  "$(grep -cE '^Assert[A-Za-z]+=' "$DIR/microvm-worker.service" | awk '{print ($1 > 1) ? "yes" : "no"}')" "yes"
check "reset precedes the new assertion" "$(grep -nE '^AssertMemory=' "$M" | cut -d: -f1 | tr '\n' ' ')" "4 5 "
check "the reset precedes every re-stated assertion" \
  "$(awk '/^AssertMemory=$/{r=NR} /^Assert/ && !/^AssertMemory=$/{if (!r || NR < r) bad=1} END{print bad ? "no" : "yes"}' "$M")" "yes"
check "daemon-reload" "$(grep -c '^systemctl daemon-reload$' "$MOCK_LOG")" "1"
check "worker started with the new budget" "$(grep -c '^systemctl start microvm-worker.service$' "$MOCK_LOG")" "1"
mem_before="$(hash_tree)"; : >"$MOCK_LOG"
check "re-run exit 0" "$(MICROVM_SANDBOX_ID=moca_microvm_1 MICROVM_MAX_COMMITTED_MB=8192 run)" "0"
check "re-run changes nothing" "$(hash_tree)" "$mem_before"
check "re-run restarts nothing" "$(grep -cE 'restart|systemctl (stop|start)' "$MOCK_LOG")" "0"
: >"$MOCK_LOG"
check "unset again: exit 0" "$(MICROVM_SANDBOX_ID=moca_microvm_1 run)" "0"
check "unset again: the override is removed" "$([ -e "$M" ] && echo present || echo absent)" "absent"
check "unset again: the worker picks up the shipped budget" "$(grep -c '^systemctl start microvm-worker.service$' "$MOCK_LOG")" "1"
# 0100000: bash arithmetic reads a leading zero as octal (32768) while Go parses 100000 -- the
# assertion and the budget would silently disagree.
for bad in abc 0 4096 -1 0100000; do
  reset_host
  check "MICROVM_MAX_COMMITTED_MB=$bad refused" "$(MICROVM_MAX_COMMITTED_MB="$bad" run)" "1"
  check "MICROVM_MAX_COMMITTED_MB=$bad: nothing written" "$(find "$TMP/etc" -name '*microvm*' | wc -l | tr -d ' ')" "0"
done
reset_host; MICROVM_MAX_COMMITTED_MB=4096 run >/dev/null
check "the refusal names the reserve it must exceed" "$(grep -c 'MICROVM_MAX_COMMITTED_MB.*SH_MEMORY_RESERVE_MB' "$TMP/run.log")" "1"

echo "== refusals write nothing"
for case in containers stopped-containers no-p6 no-snapshot dashed-id; do
  reset_host
  case "$case" in
    containers) export MOCK_PODMAN_PS="sh-sandbox-0 sh-sandbox-1" ;;
    # I3: a stopped --restart=always container comes back at boot (podman-restart.service).
    stopped-containers) export MOCK_PODMAN_PS_STOPPED="sh-sandbox-0" ;;
    no-p6) rm -f "$TMP/etc/relay.env" ;;
    no-snapshot) rm -f "$TMP/snap/manifest.json" ;;
    dashed-id) export MICROVM_SANDBOX_ID=sbx-microvm-1 ;;
  esac
  check "$case: exit 1" "$(run)" "1"
  check "$case: no microvm env files" "$(find "$TMP/etc" -name '*microvm*' | wc -l | tr -d ' ')" "0"
  check "$case: no systemctl" "$(grep -c '^systemctl' "$MOCK_LOG")" "0"
  unset MOCK_PODMAN_PS MOCK_PODMAN_PS_STOPPED MICROVM_SANDBOX_ID
done
reset_host; MOCK_PODMAN_PS="sh-sandbox-0" run >/dev/null
check "containers: the refusal names them and the fix" \
  "$(grep -c 'sh-sandbox-0.*SH_SANDBOX_COUNT=0' "$TMP/run.log")" "1"

echo "== an attach that never shows up fails the install, naming the journal"
reset_host
check "exit 1" "$(MOCK_HEXISTS=0 run)" "1"
check "points at journalctl" "$(grep -c 'journalctl -u microvm-worker' "$TMP/run.log")" "1"

if [ "$fails" -eq 0 ]; then echo "PASS"; else echo "FAIL ($fails)"; fi
exit "$fails"
