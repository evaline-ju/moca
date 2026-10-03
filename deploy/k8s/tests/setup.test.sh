#!/usr/bin/env bash
# Cluster-free tests for deploy/k8s/setup.sh (#423). kubectl, kind, docker and oc are mocks that log
# their argv and keep a small JSON object store; every other external setup.sh can reach goes
# through a logging shim. PATH is the shim dir alone, so nothing real stands in for a mock, and the
# argv log is complete -- which is what lets this test prove no secret reaches any process's argv
# (spec §4.2). Same approach as deploy/compose/tests/install.test.sh.
set -euo pipefail

SRC_K8S="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log" MOCK_STATE="$TMP/state" SH_WAIT_SECONDS=2
REAL_PATH="$PATH"
export REAL_PATH
REAL_BASH="$(command -v bash)"
mkdir -p "$TMP/bin" "$MOCK_STATE"

fail() {
  echo "FAIL: $*" >&2
  [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2
  exit 1
}
pass() { echo "ok - $*"; }

# A throwaway copy of the repo layout setup.sh expects, so .generated/ lands in $TMP, not the checkout.
REPO="$TMP/repo"
mkdir -p "$REPO/deploy/microvm" "$REPO/remote-worker"
cp -R "$SRC_K8S" "$REPO/deploy/k8s"
rm -rf "$REPO/deploy/k8s/.generated"
cp "$SRC_K8S/../microvm/mock-anthropic.mjs" "$REPO/deploy/microvm/"
: >"$REPO/Dockerfile"
: >"$REPO/remote-worker/Dockerfile"
SETUP="$REPO/deploy/k8s/setup.sh"

for cmd in awk base64 basename cat chmod cp cut dirname grep head jq mkdir mktemp mv openssl rm sed sleep sort tail tr wc; do
  real="$(command -v "$cmd" 2>/dev/null)" || continue
  [[ "$real" == /* ]] || continue
  printf '#!/bin/sh\nprintf "%%s %%s\\n" %s "$*" >>"$MOCK_LOG"\nexec %s "$@"\n' "$cmd" "$real" >"$TMP/bin/$cmd"
  chmod +x "$TMP/bin/$cmd"
done

cat >"$TMP/bin/kubectl" <<'MOCK'
#!/usr/bin/env bash
# Mock kubectl. Secrets and ConfigMaps live as JSON files in $MOCK_STATE/<ns>__<Kind>__<name>.json.
printf 'kubectl %s\n' "$*" >>"$MOCK_LOG"
export PATH="$REAL_PATH"
set -euo pipefail
if [[ "${1-}" == --context ]]; then shift 2; fi
ns=default
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
  -n) ns="$2"; shift 2 ;;
  *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]}"
store() { printf '%s/%s__%s__%s.json' "$MOCK_STATE" "$1" "$2" "$3"; }
case "${1-} ${2-}" in
"config current-context") echo "${MOCK_CURRENT_CONTEXT:-kind-moca}" ;;
"version --client") echo 'Client Version: v1.31.0' ;;
"get secret" | "get configmap")
  kind=Secret
  [[ "$2" == configmap ]] && kind=ConfigMap
  if [[ "$kind" == Secret && -n "${MOCK_GET_FAIL-}" ]]; then
    echo 'Error from server (InternalError): etcd timeout' >&2
    exit 1
  fi
  f="$(store "$ns" "$kind" "$3")"
  if [[ ! -f "$f" ]]; then
    [[ " $* " != *" --ignore-not-found "* ]] || exit 0
    echo "Error from server (NotFound): $2 \"$3\" not found" >&2
    exit 1
  fi
  cat "$f" ;;
"apply --server-side")
  obj="$(cat)"
  obj="$(jq 'if .stringData then .data = ((.data // {}) + (.stringData | map_values(@base64))) | del(.stringData) else . end' <<<"$obj")"
  printf '%s\n' "$obj" >"$(store "$(jq -r .metadata.namespace <<<"$obj")" "$(jq -r .kind <<<"$obj")" "$(jq -r .metadata.name <<<"$obj")")" ;;
"apply -f") : ;; # a file path (namespaces.yaml); stdin applies all go through --server-side
"apply -k") cp "$3/kustomization.yaml" "$MOCK_STATE/applied-kustomization.yaml" ;;
"create configmap")
  jq -n --arg n "$3" --arg ns "$ns" '{apiVersion: "v1", kind: "ConfigMap", metadata: {name: $n, namespace: $ns}, data: {"mock-anthropic.mjs": "x"}}' ;;
"create secret")
  jq -n --arg n "$4" --arg ns "$ns" '{apiVersion: "v1", kind: "Secret", type: "kubernetes.io/tls", metadata: {name: $n, namespace: $ns}, data: {"tls.crt": "Y3J0", "tls.key": "a2V5"}}' ;;
"run moca-genkeys")
  hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
  if [[ -n "${MOCK_GENKEYS_BAD-}" ]]; then
    printf 'SH_SESSION_TOKEN_PRIVATE_KEY=MC4C%s\n' "$(hex 16)"
    printf 'SH_SESSION_TOKEN_PUBLIC_KEYS=%s:MCow\n' "$(hex 8)"
    printf 'SH_CREDENTIAL_KEK=not a key\n'
    printf 'SH_EXCHANGE_TOKEN=%s\n' "$(hex 32)"
    exit 0
  fi
  printf 'SH_SESSION_TOKEN_PRIVATE_KEY=MC4CAQAwBQYDK2VwBCIEI%s\n' "$(hex 22)"
  printf 'SH_SESSION_TOKEN_PUBLIC_KEYS=%s:MCowBQYDK2VwAyEA%s\n' "$(hex 8)" "$(hex 22)"
  printf 'SH_CREDENTIAL_KEK=%s=\n' "$(hex 22 | cut -c1-43)"
  printf 'SH_EXCHANGE_TOKEN=%s\n' "$(hex 32)" ;;
"delete pod") : ;;
"rollout status" | "rollout restart") : ;;
"exec redis-0") echo "${MOCK_RECORDS:-2}" ;;
"get storageclass")
  if [[ -n "${MOCK_NO_DEFAULT_SC-}" ]]; then echo '{"items":[{"metadata":{"name":"slow"}}]}'
  else echo '{"items":[{"metadata":{"name":"standard","annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}]}'; fi ;;
*) echo "mock kubectl: unhandled: $*" >&2; exit 2 ;;
esac
MOCK

cat >"$TMP/bin/kind" <<'MOCK'
#!/usr/bin/env bash
printf 'kind %s\n' "$*" >>"$MOCK_LOG"
case "$*" in
version) echo "kind v${MOCK_KIND_VERSION:-0.27.0} go1.23.4 linux/amd64" ;;
"get clusters") [[ -z "${MOCK_KIND_CLUSTERS-moca}" ]] || echo "${MOCK_KIND_CLUSTERS-moca}" ;;
"create cluster"* | "load docker-image"*) : ;;
*) echo "mock kind: unhandled: $*" >&2; exit 2 ;;
esac
MOCK

cat >"$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$MOCK_LOG"
case "${1-}" in
pull) [[ -z "${MOCK_PULL_FAIL-}" ]] ;;
tag | build) : ;;
*) echo "mock docker: unhandled: $*" >&2; exit 2 ;;
esac
MOCK

cat >"$TMP/bin/oc" <<'MOCK'
#!/usr/bin/env bash
printf 'oc %s\n' "$*" >>"$MOCK_LOG"
case "$*" in
whoami) echo kube:admin ;;
"get ingresses.config/cluster"*) echo apps.example.test ;;
"adm policy add-scc-to-user"*) : ;;
*) echo "mock oc: unhandled: $*" >&2; exit 2 ;;
esac
MOCK
# run_setup's PATH is $TMP/bin alone, where `#!/usr/bin/env bash` finds no bash: pin the mocks' interpreter.
for m in kubectl kind docker oc; do
  { printf '#!%s\n' "$REAL_BASH"; tail -n +2 "$TMP/bin/$m"; } >"$TMP/bin/$m.new"
  mv "$TMP/bin/$m.new" "$TMP/bin/$m"
done
chmod +x "$TMP/bin/kubectl" "$TMP/bin/kind" "$TMP/bin/docker" "$TMP/bin/oc"

reset_state() {
  rm -rf "$MOCK_STATE" "$REPO/deploy/k8s/.generated"
  mkdir -p "$MOCK_STATE"
  : >"$MOCK_LOG"
}
# The run's environment is whatever the caller exported (use a subshell: `(export X=1; expect_ok …)`).
run_setup() { PATH="$TMP/bin" "$REAL_BASH" "$SETUP" "$@" >"$TMP/out" 2>&1; }
expect_ok() { run_setup "$@" || fail "setup.sh $* failed"; }
expect_fail() { if run_setup "$@"; then fail "setup.sh $* succeeded; expected a refusal"; fi; }
expect_out() { grep -qF -- "$1" "$TMP/out" || fail "output lacks: $1"; }
sv() { jq -r --arg k "$3" '.data[$k] // empty' "$MOCK_STATE/$1__Secret__$2.json" | base64 --decode; }
assert_no_secret_in_argv() {
  local f k v b
  for f in "$MOCK_STATE"/*__Secret__*.json; do
    [[ -e "$f" ]] || continue
    for k in $(jq -r '.data | keys[]' "$f"); do
      [[ "$k" != redis.conf ]] || continue # multi-line; its password is checked through REDIS_PASSWORD
      v="$(jq -r --arg k "$k" '.data[$k]' "$f" | base64 --decode)"
      [[ ${#v} -ge 16 ]] || continue
      if grep -qF -- "$v" "$MOCK_LOG"; then fail "secret $k of $(basename "$f") reached a process argv"; fi
      b="$(printf '%s' "$v" | base64 | tr -d '\n')"
      [[ ${#b} -ge 16 ]] || continue
      if grep -qF -- "$b" "$MOCK_LOG"; then fail "secret $k of $(basename "$f") reached a process argv (base64)"; fi
    done
  done
}

echo "== Task 12: arguments, preflight, context pinning, images"
reset_state
expect_fail
expect_out '--target is required'
expect_fail --target prod
expect_out "unknown --target 'prod'"
touch "$TMP/c.pem" "$TMP/k.pem"
expect_fail --target kind --tls-cert "$TMP/c.pem" --tls-key "$TMP/k.pem"
expect_out 'apply to --target ocp only'
(export SH_SANDBOX_COUNT=abc; expect_fail --target kind)
expect_out "SH_SANDBOX_COUNT='abc'"
(export MOCK_KIND_VERSION=0.23.0; expect_fail --target kind)
expect_out 'kind v0.24.0 or newer is required'
pass 'bad arguments and an old kind are refused, naming the fix'

reset_state
(export MOCK_CURRENT_CONTEXT=prod-cluster SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind)
bad="$(grep '^kubectl ' "$MOCK_LOG" | grep -v '^kubectl --context kind-moca ' || true)"
[[ -z "$bad" ]] || fail "kubectl ran without --context kind-moca: $bad"
pass 'every kubectl call on kind is pinned to kind-moca, whatever the ambient context (Review Focus 1)'
for pair in 'ghcr.io/rossoctl/moca:latest dev.local/moca:local' \
  'ghcr.io/rossoctl/moca-remote-worker:latest dev.local/moca-remote-worker:local'; do
  src="${pair% *}"
  tag="${pair#* }"
  grep -qx "docker pull $src" "$MOCK_LOG" || fail "no docker pull of $src"
  grep -qx "docker tag $src $tag" "$MOCK_LOG" || fail "no docker tag $src -> $tag"
  grep -qx "kind load docker-image $tag --name moca" "$MOCK_LOG" || fail "no kind load of $tag"
done
pass 'images are pulled, retagged and loaded into kind'

reset_state
(export MOCK_PULL_FAIL=1 SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind)
grep -qF "docker build --load -t dev.local/moca:local -f $REPO/Dockerfile $REPO" "$MOCK_LOG" || fail 'no fallback build of the harness image'
grep -qF "docker build --load -t dev.local/moca-remote-worker:local -f $REPO/remote-worker/Dockerfile $REPO" "$MOCK_LOG" || fail 'no fallback build of the sandbox image'
pass 'a failed pull falls back to building from the checkout'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
! grep -qE '^(docker (pull|build)|kind load)' "$MOCK_LOG" || fail '--skip-build still touched images'
reset_state
(export MOCK_KIND_CLUSTERS='' SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
grep -q '^kind create cluster --name moca$' "$MOCK_LOG" || fail 'a missing kind cluster was not created'
pass '--skip-build skips images; a missing cluster is created'

echo "== Task 13: secrets"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
relay="$(sv moca moca-relay SH_RELAY_TOKEN)"
exec_t="$(sv moca moca-relay MOCA_RELAY_EXEC_TOKEN)"
[[ "$relay" =~ ^[0-9a-f]{64}$ && "$exec_t" =~ ^[0-9a-f]{64}$ && "$relay" != "$exec_t" ]] || fail 'relay tokens are not two distinct 32-byte hex values'
sbx_secrets=("$MOCK_STATE"/moca-sandbox__Secret__*.json) # an unmatched glob stays literal: -e catches it
[[ ${#sbx_secrets[@]} == 1 && -e "${sbx_secrets[0]}" ]] || fail 'moca-sandbox must hold exactly one Secret'
[[ "$(jq -c '.data | keys' "$MOCK_STATE/moca-sandbox__Secret__moca-relay-attach.json")" == '["SH_RELAY_TOKEN"]' ]] || fail 'the attach Secret must carry SH_RELAY_TOKEN only'
[[ "$(sv moca-sandbox moca-relay-attach SH_RELAY_TOKEN)" == "$relay" ]] || fail 'the attach token differs from the relay token'
pw="$(sv moca moca-redis REDIS_PASSWORD)"
[[ "$(sv moca moca-redis REDIS_URL)" == "redis://:$pw@redis.moca.svc:6379" ]] || fail 'REDIS_URL does not carry the password'
sv moca moca-redis redis.conf | grep -qx "requirepass $pw" || fail 'redis.conf does not require the password'
[[ "$(sv moca moca-mu1 SH_EXCHANGE_TOKEN)" =~ ^[0-9a-f]{64}$ ]] || fail 'no exchange token'
[[ "$(sv moca moca-mu1 SH_SESSION_TOKEN_PUBLIC_KEYS)" =~ ^[0-9a-f]{16}: ]] || fail 'no public keyset'
[[ -n "$(sv moca moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY)" && -n "$(sv moca moca-mu1 SH_CREDENTIAL_KEK)" ]] || fail 'missing MU1 key'
pass 'a first run creates the four Secrets with the spec §4.2 keys'
assert_no_secret_in_argv
pass 'no generated secret value reached any process argv'
grep 'run moca-genkeys' "$MOCK_LOG" | grep -q '"runAsUser":65532' || fail 'the kind genkeys pod has no explicit UID'
if grep -E '^kubectl .* apply .*-f -$' "$MOCK_LOG" | grep -v -- '--server-side' | grep -q .; then fail 'a stdin apply without --server-side (it would copy values into an annotation)'; fi
del_line="$(grep -n 'delete pod moca-genkeys -n moca --ignore-not-found --wait=true' "$MOCK_LOG" | head -1 | cut -d: -f1)"
run_line="$(grep -n 'run moca-genkeys' "$MOCK_LOG" | head -1 | cut -d: -f1)"
[[ -n "$del_line" && "$del_line" -lt "$run_line" ]] || fail 'a leftover moca-genkeys pod is not deleted before the run'
grep 'run moca-genkeys' "$MOCK_LOG" | grep -q '"stdin":true,"stdinOnce":true' || fail 'the genkeys override drops the container stdin that -i attaches to'
pass 'genkeys runs as 65532 on kind; every stdin apply is server-side'
pass 'a leftover genkeys pod is deleted first; the override keeps stdin for the attach'

snapshot() { for f in "$MOCK_STATE"/*__Secret__*.json; do jq -cS .data "$f"; done; }
before="$(snapshot)"
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
[[ "$(snapshot)" == "$before" ]] || fail 'a re-run changed a secret'
! grep -q 'run moca-genkeys' "$MOCK_LOG" || fail 'a re-run regenerated keys it already had'
pass 'a re-run rotates nothing'

# An API error on GET (timeout, 5xx, RBAC, expired token) is not "missing": treating it as missing
# would silently rotate every value -- for SH_CREDENTIAL_KEK, every stored credential lost.
if (export MOCK_GET_FAIL=1 SH_GITHUB_CLIENT_ID=Iv1.test; run_setup --target kind --skip-build); then get_fail_rc=0; else get_fail_rc=1; fi
[[ "$(snapshot)" == "$before" ]] || fail 'a failed GET rotated a secret'
[[ "$get_fail_rc" == 1 ]] || fail 'setup.sh succeeded although every Secret GET failed'
expect_out 'etcd timeout'
pass 'a failed GET aborts the run and rotates nothing'

mu1="$MOCK_STATE/moca__Secret__moca-mu1.json"
priv="$(sv moca moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY)"
xchg="$(sv moca moca-mu1 SH_EXCHANGE_TOKEN)"
jq 'del(.data.SH_CREDENTIAL_KEK)' "$mu1" >"$mu1.tmp" && mv "$mu1.tmp" "$mu1"
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind --skip-build)
[[ -n "$(sv moca moca-mu1 SH_CREDENTIAL_KEK)" ]] || fail 'a missing KEK was not filled'
[[ "$(sv moca moca-mu1 SH_SESSION_TOKEN_PRIVATE_KEY)" == "$priv" && "$(sv moca moca-mu1 SH_EXCHANGE_TOKEN)" == "$xchg" ]] || fail 'filling one key changed another'
assert_no_secret_in_argv
pass 'a missing key is patched in alone'

jq 'del(.data.SH_SESSION_TOKEN_PUBLIC_KEYS)' "$mu1" >"$mu1.tmp" && mv "$mu1.tmp" "$mu1"
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_fail --target kind --skip-build)
expect_out 'half a signing keypair'
pass 'half a keypair is refused, naming the fix'

reset_state
(export MOCK_GENKEYS_BAD=1 SH_GITHUB_CLIENT_ID=Iv1.test; expect_fail --target kind --skip-build)
expect_out 'produced no usable SH_CREDENTIAL_KEK'
[[ ! -f "$MOCK_STATE/moca__Secret__moca-mu1.json" ]] || fail 'a garbled generator left a partial moca-mu1'
pass 'a garbled key generator writes nothing'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target ocp)
! grep 'run moca-genkeys' "$MOCK_LOG" | grep -q runAsUser || fail 'the OCP genkeys pod pins a UID (the SCC assigns one)'
assert_no_secret_in_argv
pass 'on OCP the genkeys pod takes its UID from the SCC, and no secret reaches argv'
