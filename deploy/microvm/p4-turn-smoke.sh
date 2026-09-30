#!/usr/bin/env bash
# deploy/microvm/p4-turn-smoke.sh
#
# Drives real harness turns through the P6 supervisor on a P4-only host and checks that they ran in
# microVMs (#369 acceptance). Needs the supervisor pointed at a model that follows the P4-SMOKE-*
# scripts -- deploy/microvm/mock-anthropic.mjs via SH_MODEL_CUSTOM/SH_MODEL_BASE_URL (P4-ON-P6.md).
# Unauthenticated /turn, so it is for the single-user P6 install (SH_REQUIRE_AUTH=false).
#
#   sudo deploy/microvm/p4-turn-smoke.sh [--supervisor URL] [--out DIR] [--failure-paths]
set -uo pipefail

SUP="http://127.0.0.1:8080"
OUT="/tmp/p4-smoke-$(date +%s)"
FAILURE_PATHS=0
: "${MICROVM_SANDBOX_ID:=moca_microvm_0}"
: "${SH_WORKSPACE_ROOT:=/srv/workspaces}"
while [ $# -gt 0 ]; do
  case "$1" in
  --supervisor) SUP="$2"; shift 2 ;;
  --out) OUT="$2"; shift 2 ;;
  --failure-paths) FAILURE_PATHS=1; shift ;;
  *) echo "usage: $0 [--supervisor URL] [--out DIR] [--failure-paths]" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1" | tee -a "$OUT/SUMMARY"; else
  echo "  FAIL: $1 (want '$3', got '$2')" | tee -a "$OUT/SUMMARY"; fails=$((fails + 1)); fi; }
has() { grep -qF -- "$2" "$OUT/$1.out" && echo yes || echo no; }
turn() { # turn <name> <session> <prompt>
  curl -sS --max-time 300 -X POST "$SUP/turn" -H 'content-type: application/json' \
    -d "{\"sessionId\":\"$2\",\"prompt\":\"$3\"}" >"$OUT/$1.out" 2>"$OUT/$1.err"
  echo "$?" >"$OUT/$1.rc"
}

echo "== preconditions" | tee "$OUT/SUMMARY"
check "the microVM worker is in the pool" \
  "$(podman exec sh-redis redis-cli HEXISTS sh:sandbox:records "$MICROVM_SANDBOX_ID")" "1"
check "no container sandbox is attached (P4-only host)" \
  "$(podman ps --format '{{.Names}}' --filter 'name=^sh-sandbox-' | wc -l | tr -d ' ')" "0"

since="$(date '+%Y-%m-%d %H:%M:%S')"
A="p4smoke-$(date +%s)-a"
B="p4smoke-$(date +%s)-b"
host_kernel="$(uname -r)"

echo "== session A, turn 1: write, clone-free git, python, rg" | tee -a "$OUT/SUMMARY"
turn a1 "$A" "P4-SMOKE-WRITE"
check "a1 completed" "$(cat "$OUT/a1.rc")" "0"
check "a1 ran the model's final text" "$(has a1 done-write)" "yes"
check "a1 ran on the golden rootfs (provenance file)" "$(has a1 'image=')" "yes"
check "a1 python3 ran" "$(has a1 42)" "yes"
check "a1 guest kernel is not the host's" "$(has a1 "$host_kernel")" "no"

echo "== session A, turn 2: the workspace survived between turns" | tee -a "$OUT/SUMMARY"
turn a2 "$A" "P4-SMOKE-READ"
check "a2 read turn 1's file" "$(has a2 p4-proof)" "yes"
check "a2 saw turn 1's repo" "$(has a2 continuity-ok)" "yes"

echo "== session B: a different workspace" | tee -a "$OUT/SUMMARY"
turn b1 "$B" "P4-SMOKE-READ"
check "b1 did not see A's file" "$(has b1 p4-proof)" "no"
check "b1 did not see A's repo" "$(has b1 continuity-missing)" "yes"

echo "== evidence on the host" | tee -a "$OUT/SUMMARY"
journalctl -u microvm-worker --since "$since" --no-pager >"$OUT/journal.log" 2>&1
# At-least, not exact: the harness may issue Execs of its own (file ops) besides the model's
# three bash calls, and the check is that they all landed in A's workspace, not how many there were.
nA="$(grep -c "workspace_key=\"$A\"" "$OUT/journal.log")"
nB="$(grep -c "workspace_key=\"$B\"" "$OUT/journal.log")"
check "journal: A's Execs name its workspace_key (>= 3 tool calls)" "$([ "$nA" -ge 3 ] && echo yes || echo "no ($nA)")" "yes"
check "journal: B's Execs name its workspace_key (>= 1)" "$([ "$nB" -ge 1 ] && echo yes || echo "no ($nB)")" "yes"
nExec="$(grep -cE 'vmpool: exec .*vm=vm-' "$OUT/journal.log")"
check "journal: every Exec ran in a distinct VM (#274: one VM per Exec)" \
  "$(grep -oE 'vm=vm-[0-9]+' "$OUT/journal.log" | sort -u | wc -l | tr -d ' ')" "$nExec"
check "workspace dir for A" "$([ -d "$SH_WORKSPACE_ROOT/$A" ] && echo yes || echo no)" "yes"
check "workspace dir for B" "$([ -d "$SH_WORKSPACE_ROOT/$B" ] && echo yes || echo no)" "yes"
du -sh "$SH_WORKSPACE_ROOT/$A" "$SH_WORKSPACE_ROOT/$B" >"$OUT/workspace-du.txt" 2>&1

if [ "$FAILURE_PATHS" = 1 ]; then
  echo "== failure path 1: worker restarted mid-Exec" | tee -a "$OUT/SUMMARY"
  turn f1 "$A" "P4-SMOKE-SLEEP" &
  tpid=$!; sleep 10; systemctl restart microvm-worker.service; wait "$tpid"
  check "f1 ended (did not hang)" "$(cat "$OUT/f1.rc")" "0"
  check "f1's tool error is named" "$(has f1 'worker disconnected')" "yes"
  check "f1 never reported the command finishing" "$(has f1 slept)" "no"
  for _ in $(seq 60); do
    [ "$(podman exec sh-redis redis-cli HEXISTS sh:sandbox:records "$MICROVM_SANDBOX_ID")" = 1 ] && break; sleep 1
  done
  echo "== failure path 2: the VM running the Exec is killed" | tee -a "$OUT/SUMMARY"
  turn f2 "$A" "P4-SMOKE-SLEEP" &
  tpid=$!; sleep 10
  # The newest firecracker process is the one serving this Exec (standbys are paused, older).
  vmpid="$(pgrep -n -f '/firecracker' || true)"
  echo "killing firecracker pid ${vmpid:-none}" >>"$OUT/SUMMARY"
  [ -n "$vmpid" ] && kill -KILL "$vmpid"
  wait "$tpid"
  check "f2 ended (did not hang)" "$(cat "$OUT/f2.rc")" "0"
  check "f2 never reported the command finishing" "$(has f2 slept)" "no"
  grep -oE '"(error|message)":"[^"]{0,200}' "$OUT/f2.out" | head -5 >"$OUT/f2-error.txt"
  echo "  f2 error text (record in the runbook): $(head -1 "$OUT/f2-error.txt")" | tee -a "$OUT/SUMMARY"
fi

if [ "$fails" -eq 0 ]; then echo "PASS ($OUT)" | tee -a "$OUT/SUMMARY"; else echo "FAIL ($fails) ($OUT)" | tee -a "$OUT/SUMMARY"; fi
exit "$fails"
