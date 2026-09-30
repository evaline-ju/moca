#!/usr/bin/env bash
# deploy/microvm/p4-turn-smoke.sh
#
# Drives real harness turns through the P6 supervisor on a P4-only host and checks that they ran in
# microVMs (#369 acceptance). Needs the supervisor pointed at a model that follows the P4-SMOKE-*
# scripts -- deploy/microvm/mock-anthropic.mjs via SH_MODEL_CUSTOM/SH_MODEL_BASE_URL (P4-ON-P6.md).
# Unauthenticated /turn, so it is for the single-user P6 install (SH_REQUIRE_AUTH=false).
#
# The /turn contract it relies on (packages/knative-server/src/server.ts, harness/src/run-turn.ts):
#   - a NEW session is created by omitting sessionId; the response names it. A sessionId the backend
#     has never seen is a 404 session_not_found, so this driver never invents one.
#   - the response is {sessionId, response, ...}, and `response` is only the final assistant text.
#     mock-anthropic.mjs puts every tool result into that text, which is how the checks below see
#     what ran in the sandbox.
#
#   sudo deploy/microvm/p4-turn-smoke.sh [--supervisor URL] [--out DIR] [--failure-paths]
set -uo pipefail

SUP="http://127.0.0.1:8080"
OUT="/tmp/p4-smoke-$(date +%s)"
FAILURE_PATHS=0
: "${MICROVM_SANDBOX_ID:=moca_microvm_0}"
: "${SH_WORKSPACE_ROOT:=/srv/workspaces}"
# The shipped unit's SH_CHROOT_BASE; jailer puts each VM at <base>/firecracker/<vm-id>/root.
: "${SH_JAIL_BASE:=/srv/jail}"
# Seconds a failure-path turn runs before the fault is injected (long enough to be inside the Exec).
: "${SMOKE_FAIL_DELAY:=10}"
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

# json_field <file> <field>: one top-level string field of a JSON response ("" if absent/unparseable).
json_field() {
  node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    process.stdout.write(typeof v === "string" ? v : "") } catch {}' "$1" "$2"
}
# turn <name> <session id, or "" for a new session> <prompt>: writes <name>.json, <name>.code and
# <name>.txt (the response text), and prints nothing.
turn() {
  local body
  # Built by JSON.stringify, not interpolated: a prompt with a quote, backslash or newline would
  # otherwise be malformed JSON and a 400 that reads like a server fault. node is already required.
  body="$(node -e 'const [s, p] = process.argv.slice(1);
    process.stdout.write(JSON.stringify(s ? { sessionId: s, prompt: p } : { prompt: p }))' "$2" "$3")"
  curl -sS --max-time 300 -o "$OUT/$1.json" -w '%{http_code}' -X POST "$SUP/turn" \
    -H 'content-type: application/json' -d "$body" >"$OUT/$1.code" 2>"$OUT/$1.err"
  json_field "$OUT/$1.json" response >"$OUT/$1.txt"
}
has() { grep -qF -- "$2" "$OUT/$1.txt" && echo yes || echo no; }
# absent <name> <needle> <proof>: "absent" only if the response is demonstrably there (it contains
# <proof>, a string this turn must print) and <needle> is not in it. Without the proof a missing or
# empty response would make every "did not see X" check pass, proving nothing.
absent() {
  if [ "$(has "$1" "$3")" != yes ]; then echo "no-response"
  elif [ "$(has "$1" "$2")" = yes ]; then echo "present"
  else echo "absent"; fi
}
code() { cat "$OUT/$1.code"; }

# running_vm: the id of the one Firecracker VM whose state is Running. Standbys are restored and
# PAUSED; the newest process is usually the replacement standby an acquire just triggered, so
# "newest pid" is the wrong VM.
running_vm() {
  local sock vm
  for sock in "$SH_JAIL_BASE"/firecracker/vm-*/root/run/firecracker.socket; do
    [ -e "$sock" ] || continue
    if curl -sS --max-time 2 --unix-socket "$sock" http://localhost/ 2>/dev/null | grep -q '"state":"Running"'; then
      vm="${sock#"$SH_JAIL_BASE"/firecracker/}"
      echo "${vm%%/*}"
      return 0
    fi
  done
  return 1
}

echo "== preconditions" | tee "$OUT/SUMMARY"
check "the microVM worker is in the pool" \
  "$(podman exec sh-redis redis-cli HEXISTS sh:sandbox:records "$MICROVM_SANDBOX_ID")" "1"
check "no container sandbox exists (P4-only host)" \
  "$(podman ps -a --format '{{.Names}}' --filter 'name=^sh-sandbox-' | wc -l | tr -d ' ')" "0"

since="$(date '+%Y-%m-%d %H:%M:%S')"
host_kernel="$(uname -r)"

echo "== session A, turn 1: write a file, git, python, rg" | tee -a "$OUT/SUMMARY"
turn a1 "" "P4-SMOKE-WRITE"
A="$(json_field "$OUT/a1.json" sessionId)"
echo "$A" >"$OUT/session-a"
check "a1 HTTP 200" "$(code a1)" "200"
check "a1 named its new session" "$([ -n "$A" ] && echo yes || echo no)" "yes"
check "a1 ran the model's final text" "$(has a1 done-write)" "yes"
check "a1 ran on the golden rootfs (provenance file)" "$(has a1 'image=')" "yes"
check "a1 python3 ran" "$(has a1 42)" "yes"
check "a1 guest kernel is not the host's" "$(absent a1 "$host_kernel" 'image=')" "absent"

echo "== session A, turn 2: the workspace survived between turns" | tee -a "$OUT/SUMMARY"
turn a2 "$A" "P4-SMOKE-READ"
check "a2 HTTP 200" "$(code a2)" "200"
check "a2 read turn 1's file" "$(has a2 p4-proof)" "yes"
check "a2 saw turn 1's repo" "$(has a2 continuity-ok)" "yes"

echo "== session B: a different workspace" | tee -a "$OUT/SUMMARY"
turn b1 "" "P4-SMOKE-READ"
B="$(json_field "$OUT/b1.json" sessionId)"
echo "$B" >"$OUT/session-b"
check "b1 HTTP 200" "$(code b1)" "200"
check "b1 is a different session" "$([ -n "$B" ] && [ "$B" != "$A" ] && echo yes || echo no)" "yes"
check "b1 did not see A's file" "$(absent b1 p4-proof continuity-missing)" "absent"
check "b1 did not see A's repo" "$(has b1 continuity-missing)" "yes"

echo "== evidence on the host" | tee -a "$OUT/SUMMARY"
journalctl -u microvm-worker --since "$since" --no-pager >"$OUT/journal.log" 2>&1
# At-least, not exact: the harness may issue Execs of its own (file ops) besides the model's
# three bash calls, and the check is that they all landed in A's workspace, not how many there were.
count_key() { # count_key <session id>: journal Exec lines for that workspace_key (0 for no id)
  [ -n "$1" ] || { echo 0; return; }
  grep -c "workspace_key=\"$1\"" "$OUT/journal.log" || true
}
nA="$(count_key "$A")"
nB="$(count_key "$B")"
check "journal: A's Execs name its workspace_key (>= 3 tool calls)" "$([ "$nA" -ge 3 ] && echo yes || echo "no ($nA)")" "yes"
check "journal: B's Execs name its workspace_key (>= 1)" "$([ "$nB" -ge 1 ] && echo yes || echo "no ($nB)")" "yes"
nExec="$(grep -cE 'vmpool: exec .*vm=vm-' "$OUT/journal.log")"
check "journal: every Exec ran in a distinct VM (#274: one VM per Exec)" \
  "$(grep -oE 'vm=vm-[0-9]+' "$OUT/journal.log" | sort -u | wc -l | tr -d ' ')" "$nExec"
check "workspace dir for A" "$([ -n "$A" ] && [ -d "$SH_WORKSPACE_ROOT/$A" ] && echo yes || echo no)" "yes"
check "workspace dir for B" "$([ -n "$B" ] && [ -d "$SH_WORKSPACE_ROOT/$B" ] && echo yes || echo no)" "yes"
du -sh "$SH_WORKSPACE_ROOT/$A" "$SH_WORKSPACE_ROOT/$B" >"$OUT/workspace-du.txt" 2>&1

if [ "$FAILURE_PATHS" = 1 ]; then
  echo "== failure path 1: worker restarted mid-Exec" | tee -a "$OUT/SUMMARY"
  turn f1 "$A" "P4-SMOKE-SLEEP" &
  tpid=$!
  sleep "$SMOKE_FAIL_DELAY"
  systemctl restart microvm-worker.service
  wait "$tpid"
  check "f1 HTTP 200 (the turn ended, it did not hang)" "$(code f1)" "200"
  check "f1's tool error is named" "$(has f1 'worker disconnected')" "yes"
  check "f1 never reported the command finishing" "$(absent f1 slept done-sleep)" "absent"
  for _ in $(seq 60); do
    [ "$(podman exec sh-redis redis-cli HEXISTS sh:sandbox:records "$MICROVM_SANDBOX_ID")" = 1 ] && break
    sleep 1
  done

  echo "== failure path 2: the VM running the Exec is killed" | tee -a "$OUT/SUMMARY"
  turn f2 "$A" "P4-SMOKE-SLEEP" &
  tpid=$!
  sleep "$SMOKE_FAIL_DELAY"
  vm="$(running_vm || true)"
  vmpid=""
  [ -n "$vm" ] && vmpid="$(pgrep -f -- "--id $vm( |\$)" | head -1)"
  echo "  killed ${vm:-none} (pid ${vmpid:-none})" | tee -a "$OUT/SUMMARY"
  check "a Running VM was found for the in-flight Exec" "$([ -n "$vmpid" ] && echo yes || echo no)" "yes"
  # `env kill`, the external kill, not the shell builtin: the builtin cannot be intercepted, so a
  # test could never stand in for it, and it would signal a REAL pid on whatever machine runs the test.
  [ -n "$vmpid" ] && env kill -KILL "$vmpid"
  wait "$tpid"
  check "f2 HTTP 200 (the turn ended, it did not hang)" "$(code f2)" "200"
  check "f2 never reported the command finishing" "$(absent f2 slept done-sleep)" "absent"
  # Recorded, not asserted: which layer names a killed VM is what this run finds out.
  echo "  f2 error text (record in the runbook): $(sed -n '2p' "$OUT/f2.txt")" | tee -a "$OUT/SUMMARY"
fi

if [ "$fails" -eq 0 ]; then echo "PASS ($OUT)" | tee -a "$OUT/SUMMARY"; else echo "FAIL ($fails) ($OUT)" | tee -a "$OUT/SUMMARY"; fi
exit "$fails"
