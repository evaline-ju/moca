#!/usr/bin/env bash
# Cluster-free tests for deploy/k8s/smoke.sh's own failure handling (#423): the runs that fail are
# the ones whose logs matter, so none of them may delete $OUT, and a kubectl error in a claim must
# become a FAIL line and the summary, not a set -e death before it. kubectl, curl and sleep are
# mocks on PATH; every other tool is the real one.
set -euo pipefail

SMOKE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/smoke.sh"
TMP="$(mktemp -d)"
# Every log dir a run kept, removed at exit (runs happen in subshells, so a variable would not do).
cleanup() {
  local d
  if [[ -f "$TMP/kept" ]]; then while IFS= read -r d; do rm -rf "$d"; done <"$TMP/kept"; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
mkdir -p "$TMP/bin"
export MOCK_STATE="$TMP/state"

fail() {
  echo "FAIL: $*" >&2
  [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2
  exit 1
}
pass() { echo "ok - $*"; }

cat >"$TMP/bin/sleep" <<'MOCK'
#!/bin/sh
exit 0
MOCK

# curl: /healthz succeeds for the first $MOCK_HEALTHZ_OK calls (default: always); /v1/sessions
# returns a session when MOCK_SESSIONS=1; /v1/turn streams the file $MOCK_TURN_SSE when it is set;
# everything else is a refused connection.
cat >"$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
url=''
for a in "$@"; do [[ "$a" == http* ]] && url="$a"; done
case "$url" in
*/healthz)
  n=$(($(cat "$MOCK_STATE/healthz" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$MOCK_STATE/healthz"
  [[ "$n" -le "${MOCK_HEALTHZ_OK:-1000}" ]] ;;
*/v1/sessions)
  [[ "${MOCK_SESSIONS-}" == 1 ]] || exit 7
  echo '{"sessionId":"s1","token":"t1"}' ;;
*/v1/turn)
  [[ -n "${MOCK_TURN_SSE-}" ]] || exit 7
  cat "$MOCK_TURN_SSE" ;;
*) exit 7 ;;
esac
MOCK

cat >"$TMP/bin/kubectl" <<'MOCK'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >>"$MOCK_STATE/kubectl.log"
case " $* " in
*" port-forward "*) exit 0 ;;
*" exec deploy/moca-control-plane "*) printf 'api.token.not-a-secret' ;;
*" exec moca-sandbox-0 "*) echo BLOCKED ;;
*" exec redis-0 "*) printf '%s' "${MOCK_REDIS_OUT-}" ;;
*" get statefulset "*) echo 1 ;;
*" get configmap moca-setup "*)
  [[ -z "${MOCK_SETUP_CM_FAIL-}" ]] || { echo 'Error from server (Forbidden): configmaps "moca-setup" is forbidden' >&2; exit 1; }
  printf '%s' "${MOCK_P4_IDS-moca_microvm_0}" ;;
*" get route moca-relay "*) echo moca-relay-moca.apps.example.test ;;
*" get secret moca-relay "*) jq -n '{data: {MOCA_RELAY_EXEC_TOKEN: ("exec-token-must-stay-off-argv-0123" | @base64)}}' ;;
*" get secret moca-relay-tls "*) jq -n '{data: {"tls.crt": ("-----BEGIN CERTIFICATE-----" | @base64)}}' ;;
*" exec -i deploy/moca-control-plane "*) cat >"$MOCK_STATE/probe.stdin"; echo "${MOCK_PROBE_OUT-attach=0 exec=12}" ;;
*" get nodes "*) echo 5.14.0-427.el9.x86_64 ;;
*" get configmap "*) echo http://127.0.0.1:8080 ;;
*" get pods -l "*) echo '{"items":[{"metadata":{"name":"moca-supervisor-x"}}]}' ;;
*" delete pod redis-0 "*)
  [[ -z "${MOCK_REDIS_DELETE_FAIL-}" ]] || { echo 'Error from server (Forbidden): pods "redis-0" is forbidden' >&2; exit 1; } ;;
*" delete pod "* | *" rollout status "*) exit 0 ;;
*" get pods "*)
  [[ -z "${MOCK_GET_PODS_FAIL-}" ]] || { echo 'Unable to connect to the server: dial tcp: i/o timeout' >&2; exit 1; }
  echo '{"items":[]}' ;;
*) echo "mock kubectl: unhandled: $*" >&2; exit 2 ;;
esac
MOCK
chmod +x "$TMP/bin/sleep" "$TMP/bin/curl" "$TMP/bin/kubectl"

# run_smoke: the caller's exported MOCK_* shape the run; sets RC and KEPT_DIR.
run_smoke() {
  rm -rf "$MOCK_STATE"
  mkdir -p "$MOCK_STATE"
  local args=("$@")
  [[ $# -gt 0 ]] || args=(--target kind-ci)
  if PATH="$TMP/bin:$PATH" K8S_LIVE_SMOKE=1 bash "$SMOKE" "${args[@]}" >"$TMP/out" 2>&1; then RC=0; else RC=$?; fi
  KEPT_DIR="$(sed -n 's/^logs kept in //p' "$TMP/out" | tail -1)"
  [[ -z "$KEPT_DIR" ]] || printf '%s\n' "$KEPT_DIR" >>"$TMP/kept"
}
expect_out() { grep -qF -- "$1" "$TMP/out" || fail "output lacks: $1"; }
expect_kept() {
  [[ -n "$KEPT_DIR" && -d "$KEPT_DIR" ]] || fail "a failed run deleted its logs ($1)"
  [[ -z "$(find "$KEPT_DIR" -name '*.hdr')" ]] || fail "a kept log dir still holds a token header file ($1)"
}

echo "== smoke.sh failure handling"
(export MOCK_HEALTHZ_OK=0; run_smoke; [[ "$RC" != 0 ]] || fail 'a port-forward that never came up exited 0'
  expect_out 'port-forward to the supervisor never came up'
  expect_kept 'port-forward never came up'
  [[ -f "$KEPT_DIR/pf-sup.log" ]] || fail 'the port-forward log is not among the kept logs')
pass 'an early exit (port-forward never up, FAIL still 0) keeps its logs'

(export MOCK_REDIS_DELETE_FAIL=1 MOCK_GET_PODS_FAIL=1; run_smoke; [[ "$RC" != 0 ]] || fail 'a failing run exited 0'
  expect_out 'Claim 11'
  expect_out 'PASS='
  grep -E '^  FAIL .*redis' "$TMP/out" | grep -q . || fail 'claim 10 kubectl error did not become a FAIL line'
  grep -E '^  FAIL .*restart' "$TMP/out" | grep -q . || fail 'claim 11 kubectl error did not become a FAIL line'
  expect_kept 'claims 10 and 11')
pass 'a kubectl error in claims 10 and 11 becomes FAIL lines and the summary, logs kept, no *.hdr left'

(export MOCK_SESSIONS=1 MOCK_HEALTHZ_OK=2; run_smoke; [[ "$RC" != 0 ]] || fail 'a failing run exited 0'
  grep -q 'port-forward' <(grep -E '^  FAIL' "$TMP/out") || fail 'the post-drain forward failure did not become a FAIL line'
  expect_out 'Claim 10'
  expect_out 'PASS='
  expect_kept 'post-drain forward')
pass 'a post-drain port-forward that never comes back is a FAIL, and the run reaches the summary'

if out="$(bash "$SMOKE" 2>&1)" && [[ "$out" == SKIP:* ]]; then pass 'without K8S_LIVE_SMOKE=1 it SKIPs'; else fail "no SKIP without K8S_LIVE_SMOKE: $out"; fi

rc=0
out="$(K8S_LIVE_SMOKE=1 PATH="$TMP/bin:$PATH" bash "$SMOKE" --target 2>&1)" || rc=$?
[[ "$rc" == 2 && "$out" == *'--target needs a value'* ]] || fail "--target with no value: rc=$rc out=$out"
pass '--target with no value exits 2 and says why'

echo "== --tier p4 (#424)"
for bad in "--tier p4 --target kind-ci" "--tier bogus --target ocp" "--target ocp --tier"; do
  rc=0
  # shellcheck disable=SC2086 # word-split on purpose: each case is an argv
  out="$(K8S_LIVE_SMOKE=1 PATH="$TMP/bin:$PATH" bash "$SMOKE" $bad 2>&1)" || rc=$?
  [[ "$rc" == 2 ]] || fail "'$bad' exited $rc, want 2: $out"
done
rc=0
out="$(K8S_LIVE_SMOKE=1 PATH="$TMP/bin:$PATH" bash "$SMOKE" --tier p4 --target kind-ci 2>&1)" || rc=$?
[[ "$out" == *'--tier p4 needs --target ocp'* ]] || fail "--tier p4 on kind-ci does not say why: $out"
rc=0
out="$(K8S_LIVE_SMOKE=1 SMOKE_P4_ADD_ID=bad-id PATH="$TMP/bin:$PATH" bash "$SMOKE" --target ocp --tier p4 2>&1)" || rc=$?
[[ "$rc" == 2 && "$out" == *'SMOKE_P4_ADD_ID'* ]] || fail "a dashed SMOKE_P4_ADD_ID was not refused: rc=$rc $out"
pass '--tier: p4 needs ocp, an unknown tier and a missing value exit 2, a bad SMOKE_P4_ADD_ID exits 2'

(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_REDIS_OUT=moca_microvm_0
  run_smoke --target ocp --tier p4
  [[ "$RC" != 0 ]] || fail 'a p4 run whose turns fail exited 0'
  grep -q '^  ok attached: moca_microvm_0' "$TMP/out" || fail 'claim P2 did not pass with the P4 record present'
  grep -q '^  ok .*attach=0 exec=12' "$TMP/out" || fail 'claim P6 did not pass on attach=0 exec=12'
  grep -qF 'exec-token-must-stay-off-argv' "$MOCK_STATE/probe.stdin" || fail 'the probe did not get the exec token on stdin'
  ! grep -qF 'exec-token-must-stay-off-argv' "$MOCK_STATE/kubectl.log" || fail 'the exec token reached a kubectl argv'
  expect_out 'skipped: set SMOKE_P4_ADD_ID'
  expect_out 'Claim P3'
  expect_out 'PASS='
  ! grep -qE 'Claim (7|8|9|10|11):' "$TMP/out" || fail 'the p4 tier ran container-tier claims'
  expect_kept 'p4 tier')
pass 'p4 tier: P2 reads moca-setup and the records, P6 passes the exec token on stdin only, P7 is skipped, no container claims'

(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real \
  MOCK_REDIS_OUT=$'moca_microvm_0\nmoca-sandbox-0' MOCK_PROBE_OUT='attach=14 exec=14'
  run_smoke --target ocp --tier p4
  grep -qE '^  FAIL container sandboxes attached alongside P4' "$TMP/out" || fail 'a container record beside P4 did not fail claim P2'
  grep -qE '^  FAIL probe: .attach=14' "$TMP/out" || fail 'an UNAVAILABLE attach (TLS/dial failure) did not fail claim P6')
pass 'p4 tier: a container record fails P2; an attach that never reached the relay (14) fails P6'

(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_SETUP_CM_FAIL=1
  run_smoke --target ocp --tier p4
  grep -qE '^  FAIL could not read configmap moca-setup' "$TMP/out" || fail 'a failed moca-setup read was not reported as a read failure'
  ! grep -qF 'holds no SH_P4_SANDBOX_IDS' "$TMP/out" || fail 'a failed moca-setup read was reported as an empty SH_P4_SANDBOX_IDS'
  expect_out 'PASS=')
pass 'p4 tier: a failed read of moca-setup is a read failure in P2, not an empty SH_P4_SANDBOX_IDS'

# A real model's tool_result preview is a JSON envelope, not plain text (live run, #424): P3 must
# read the kernel out of .content[].text, not compare the whole envelope against the nodes'.
# p4_sse FILE TEXT: an SSE turn whose bash result is TEXT, wrapped as the live run saw it.
p4_sse() {
  jq -nc --arg t "$2" '{type: "tool_result", preview: ({content: [{type: "text", text: $t}]} | tojson)}' |
    sed 's/^/data: /' >"$1"
  echo 'data: {"type":"done","sessionId":"s1"}' >>"$1"
}
cat >"$TMP/guest.sse" <<'SSE'
data: {"type":"tool_result","preview":"{\"content\":[{\"type\":\"text\",\"text\":\"6.18.44+\\np4-proof\\n\"}]}"}
data: {"type":"done","sessionId":"s1"}
SSE
p4_sse "$TMP/guest-built.sse" $'6.18.44+\np4-proof\n'
cmp -s "$TMP/guest.sse" "$TMP/guest-built.sse" || fail 'the literal envelope fixture is not the live format p4_sse builds'
p4_sse "$TMP/node.sse" $'5.14.0-427.el9.x86_64\np4-proof\n'
(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_REDIS_OUT=moca_microvm_0 \
  MOCK_SESSIONS=1 MOCK_TURN_SSE="$TMP/guest.sse"
  run_smoke --target ocp --tier p4
  grep -qE '^  ok session s1 ran on kernel 6\.18\.44\+ \(nodes run 5\.14\.0-427\.el9\.x86_64\)$' "$TMP/out" ||
    fail 'P3 did not pass naming the guest kernel 6.18.44+ out of the JSON envelope')
pass 'p4 tier: P3 reads the guest kernel out of a JSON-envelope preview and passes naming it'

(export SMOKE_MODEL_URL=https://model.example.test SMOKE_MODEL_TOKEN=model-token-not-real MOCK_REDIS_OUT=moca_microvm_0 \
  MOCK_SESSIONS=1 MOCK_TURN_SSE="$TMP/node.sse"
  run_smoke --target ocp --tier p4
  ! grep -qE '^  ok session s1 ran on kernel' "$TMP/out" || fail 'P3 passed on a turn that ran on a node kernel'
  grep -qE "^  FAIL the turn's kernel '5\.14\.0-427\.el9\.x86_64'" "$TMP/out" ||
    fail 'P3 did not FAIL naming the node kernel read out of the envelope')
pass 'p4 tier: P3 FAILs when the envelope text is a node kernel'

echo "smoke.test.sh: all passed"
