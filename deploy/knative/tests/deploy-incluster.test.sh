#!/usr/bin/env bash
# deploy/knative/tests/deploy-incluster.test.sh
#
# Unit test for remote-worker/deploy-incluster.sh's handling of the sh-relay-token Secret.
# The Secret holds TWO keys: SH_RELAY_TOKEN (the sandboxes' Attach credential, which the
# in-cluster worker also reads) and MOCA_RELAY_EXEC_TOKEN (the harness's SandboxExec
# credential, MI1 R5). The relay needs both and refuses to boot without the second, so the
# script must write each key on its own and never replace the Secret as a whole, and must add
# the exec key when an older Secret lacks it -- without ever rotating an existing one.
#
# No cluster required: `oc` is mocked on PATH with a tiny file-backed Secret store, and
# `oc apply` of a Secret replaces the whole object (as last-applied merging does for a key the
# applied manifest omits). Run: bash deploy/knative/tests/deploy-incluster.test.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$REPO/remote-worker/deploy-incluster.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/calls.log" SECRET_DIR="$TMP/secret"

mkdir -p "$TMP/bin"
cat >"$TMP/bin/oc" <<'EOF'
#!/usr/bin/env bash
# A minimal oc: one Secret (sh-relay-token) stored as one file per key under $SECRET_DIR.
echo "oc $*" >>"$MOCK_LOG"
args=("$@")
has() { local a; for a in "${args[@]}"; do [ "$a" = "$1" ] && return 0; done; return 1; }
case "$1 $2" in
"get secret")
  [ -d "$SECRET_DIR" ] || exit 1
  for a in "$@"; do
    case "$a" in
    jsonpath=*) key="${a#jsonpath=\{.data.}"; key="${key%\}}"
      [ -f "$SECRET_DIR/$key" ] && base64 <"$SECRET_DIR/$key" | tr -d '\n'
      ;;
    esac
  done
  exit 0 ;;
"create secret")
  if has --dry-run=client; then
    # Emitted as a manifest for `oc apply -f -`: every key it names, and nothing else.
    echo "kind: Secret"
    for a in "$@"; do case "$a" in --from-literal=*) kv="${a#--from-literal=}"; echo "data ${kv%%=*} ${kv#*=}";; esac; done
    exit 0
  fi
  [ -d "$SECRET_DIR" ] && { echo 'Error from server (AlreadyExists)' >&2; exit 1; }
  mkdir -p "$SECRET_DIR"
  for a in "$@"; do case "$a" in --from-literal=*) kv="${a#--from-literal=}"; printf '%s' "${kv#*=}" >"$SECRET_DIR/${kv%%=*}";; esac; done
  exit 0 ;;
"patch secret")
  [ -d "$SECRET_DIR" ] || { echo 'Error from server (NotFound)' >&2; exit 1; }
  for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[$i]}" = "-p" ] && payload="${args[$((i + 1))]}"; done
  python3 - "$SECRET_DIR" "$payload" <<'PY'
import json, os, sys
d, payload = sys.argv[1], json.loads(sys.argv[2])
for k, v in payload.get("stringData", {}).items():
    open(os.path.join(d, k), "w").write(v)
PY
  exit 0 ;;
"apply -f")
  manifest="$(cat)"
  if printf '%s\n' "$manifest" | grep -q '^kind: Secret'; then
    # A whole-object apply: the Secret ends up holding exactly the keys the manifest names.
    rm -rf "$SECRET_DIR"; mkdir -p "$SECRET_DIR"
    printf '%s\n' "$manifest" | while read -r tag k v; do
      [ "$tag" = data ] && printf '%s' "$v" >"$SECRET_DIR/$k"
    done
    echo "applied-secret" >>"$MOCK_LOG"
  fi
  exit 0 ;;
"rollout status")
  # The relay refuses to boot without MOCA_RELAY_EXEC_TOKEN; model that as a failed rollout.
  if [ "$3" = deploy/sandbox-relay ] && [ ! -s "$SECRET_DIR/MOCA_RELAY_EXEC_TOKEN" ]; then
    echo 'error: deployment "sandbox-relay" exceeded its progress deadline' >&2
    exit 1
  fi
  exit 0 ;;
"create serviceaccount") echo "kind: ServiceAccount"; exit 0 ;;
"exec deploy/redis") echo '{"transport":"grpc"}'; exit 0 ;;
*) exit 0 ;;
esac
EOF
chmod +x "$TMP/bin/oc"
# The script needs only coreutils, sed, od and python3 besides oc; keep the real ones on PATH.
export PATH="$TMP/bin:$PATH"

FAILS=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  FAILS=$((FAILS + 1))
fi; }
key() { cat "$SECRET_DIR/$1" 2>/dev/null || true; }
run() {
  : >"$MOCK_LOG"
  env NS=default SANDBOX_ID=sbx-worker-1 IMAGE=example.invalid/remote-worker:test "$@" \
    bash "$SCRIPT" >"$TMP/out.txt" 2>&1
}

echo "case 1: a fresh namespace gets both keys, distinct"
rm -rf "$SECRET_DIR"
rc=0; run SANDBOX_TOKEN=tok-under-test || rc=$?
check "the script succeeds" "$rc" "0"
check "SH_RELAY_TOKEN holds the sandbox token" "$(key SH_RELAY_TOKEN)" "tok-under-test"
check "MOCA_RELAY_EXEC_TOKEN is generated as 32 random bytes of hex" \
  "$([[ "$(key MOCA_RELAY_EXEC_TOKEN)" =~ ^[0-9a-f]{64}$ ]] && echo yes || echo no)" "yes"
check "the two keys differ (the relay refuses an exec token equal to a sandbox token)" \
  "$([ "$(key MOCA_RELAY_EXEC_TOKEN)" != "$(key SH_RELAY_TOKEN)" ] && echo yes || echo no)" "yes"

echo "case 2: a Secret setup-ocp.sh created keeps its exec token on a re-run"
rm -rf "$SECRET_DIR"; mkdir -p "$SECRET_DIR"
printf '%s' old-sandbox-token >"$SECRET_DIR/SH_RELAY_TOKEN"
printf '%s' existing-exec-token >"$SECRET_DIR/MOCA_RELAY_EXEC_TOKEN"
rc=0; run SANDBOX_TOKEN=tok-under-test || rc=$?
check "the script succeeds" "$rc" "0"
check "MOCA_RELAY_EXEC_TOKEN is kept, never rotated" "$(key MOCA_RELAY_EXEC_TOKEN)" "existing-exec-token"
check "SH_RELAY_TOKEN is set to the requested sandbox token" "$(key SH_RELAY_TOKEN)" "tok-under-test"
check "the Secret is never replaced as a whole object" "$(grep -c applied-secret "$MOCK_LOG")" "0"

echo "case 3: an older Secret with only SH_RELAY_TOKEN gains the exec key, and the relay starts"
rm -rf "$SECRET_DIR"; mkdir -p "$SECRET_DIR"
printf '%s' old-sandbox-token >"$SECRET_DIR/SH_RELAY_TOKEN"
rc=0; run SANDBOX_TOKEN=tok-under-test || rc=$?
check "the script succeeds (the restarted relay has its exec token)" "$rc" "0"
check "MOCA_RELAY_EXEC_TOKEN was added" \
  "$([[ "$(key MOCA_RELAY_EXEC_TOKEN)" =~ ^[0-9a-f]{64}$ ]] && echo yes || echo no)" "yes"

echo "case 4: the in-cluster worker (a sandbox) is never handed the exec token"
check "the script never sets env on the remote-worker Deployment from the Secret" \
  "$(grep -cE 'oc set env deploy/remote-worker' "$MOCK_LOG")" "0"
check "worker-deployment.yaml does not reference MOCA_RELAY_EXEC_TOKEN" \
  "$(grep -c MOCA_RELAY_EXEC_TOKEN "$REPO/remote-worker/worker-deployment.yaml")" "0"
exec_tok="$(key MOCA_RELAY_EXEC_TOKEN)"
check "the exec token never appears in the script's output" \
  "$([ -n "$exec_tok" ] && ! grep -qF -- "$exec_tok" "$TMP/out.txt" && echo yes || echo no)" "yes"

echo
echo "Total failures: $FAILS"
exit "$FAILS"
