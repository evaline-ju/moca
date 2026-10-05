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

for cmd in awk base64 basename cat chmod cp cut dirname grep head jq mkdir mktemp mv openssl rm sed sha256sum shasum sleep sort tail tr wc; do
  real="$(command -v "$cmd" 2>/dev/null)" || continue
  [[ "$real" == /* ]] || continue
  printf '#!/bin/sh\nprintf "%%s %%s\\n" %s "$*" >>"$MOCK_LOG"\nexec %s "$@"\n' "$cmd" "$real" >"$TMP/bin/$cmd"
  chmod +x "$TMP/bin/$cmd"
done
# macOS mktemp -d ignores TMPDIR, so the key-cleanup test redirects it here instead: with
# MOCK_MKTEMP_DIR set, a bare `mktemp -d` lands in that directory, where the test can look.
real_mktemp="$(command -v mktemp)"
cat >"$TMP/bin/mktemp" <<SHIM
#!/bin/sh
printf "%s %s\\n" mktemp "\$*" >>"\$MOCK_LOG"
if [ -n "\${MOCK_MKTEMP_DIR-}" ] && [ "\$*" = "-d" ]; then exec $real_mktemp -d "\$MOCK_MKTEMP_DIR/tmp.XXXXXX"; fi
exec $real_mktemp "\$@"
SHIM
chmod +x "$TMP/bin/mktemp"

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
  # MOCK_GET_FAIL=1 fails every Secret GET; MOCK_GET_FAIL=NAME fails only Secret NAME's.
  if [[ "$kind" == Secret && -n "${MOCK_GET_FAIL-}" && ("$MOCK_GET_FAIL" == 1 || "$MOCK_GET_FAIL" == "$3") ]]; then
    echo 'Error from server (InternalError): etcd timeout' >&2
    exit 1
  fi
  # MOCK_GET_CM_FAIL=NAME fails ConfigMap NAME's GET.
  if [[ "$kind" == ConfigMap && "${MOCK_GET_CM_FAIL-}" == "$3" ]]; then
    echo 'Error from server (InternalError): etcd timeout' >&2
    exit 1
  fi
  f="$(store "$ns" "$kind" "$3")"
  if [[ ! -f "$f" ]]; then
    [[ " $* " != *" --ignore-not-found "* ]] || exit 0
    echo "Error from server (NotFound): $2 \"$3\" not found" >&2
    exit 1
  fi
  if [[ " $* " == *" -o name "* ]]; then echo "$2/$3"; else cat "$f"; fi ;;
"apply --server-side")
  obj="$(cat)"
  # With MOCK_SSA_PRUNE=1, simulate server-side apply pruning: data becomes exactly the applied stringData keys
  if [[ -n "${MOCK_SSA_PRUNE-}" && "$(jq -r '.kind' <<<"$obj")" == Secret && -n "$(jq -r '.stringData // empty' <<<"$obj")" ]]; then
    obj="$(jq '.data = (.stringData | map_values(@base64)) | del(.stringData)' <<<"$obj")"
  else
    obj="$(jq 'if .stringData then .data = ((.data // {}) + (.stringData | map_values(@base64))) | del(.stringData) else . end' <<<"$obj")"
  fi
  printf '%s\n' "$obj" >"$(store "$(jq -r .metadata.namespace <<<"$obj")" "$(jq -r .kind <<<"$obj")" "$(jq -r .metadata.name <<<"$obj")")" ;;
"apply -f") : ;; # a file path (namespaces.yaml); stdin applies all go through --server-side
"apply -k")
  if [[ -n "${MOCK_APPLY_K_FAIL-}" ]]; then echo 'error: the server was unable to return a response in the time allotted' >&2; exit 1; fi
  cp "$3/kustomization.yaml" "$MOCK_STATE/applied-kustomization.yaml" ;;
"create configmap")
  jq -n --arg n "$3" --arg ns "$ns" '{apiVersion: "v1", kind: "ConfigMap", metadata: {name: $n, namespace: $ns}, data: {"mock-anthropic.mjs": "x"}}' ;;
"create secret")
  if [[ -n "${MOCK_TLS_CREATE_FAIL-}" ]]; then echo 'error: failed to load key pair' >&2; exit 1; fi
  crt=''
  for a in "$@"; do [[ "$a" != --cert=* ]] || crt="$(base64 <"${a#--cert=}" | tr -d '\n')"; done
  jq -n --arg n "$4" --arg ns "$ns" --arg c "${crt:-Y3J0}" '{apiVersion: "v1", kind: "Secret", type: "kubernetes.io/tls", metadata: {name: $n, namespace: $ns}, data: {"tls.crt": $c, "tls.key": "a2V5"}}' ;;
"patch secret")
  f="$(store "$ns" Secret "$3")"
  [[ -f "$f" ]] || { echo "Error from server (NotFound): secrets \"$3\" not found" >&2; exit 1; }
  p=''
  while [[ $# -gt 0 ]]; do [[ "$1" == -p ]] && { p="$2"; break; }; shift; done
  # Reject JSON Patch (array) bodies; only merge patch (object with data) is allowed.
  if jq -e '. | type == "array"' <<<"$p" >/dev/null 2>&1; then
    echo "error: the server does not support JSON Patch on this Secret; use merge patch" >&2
    exit 1
  fi
  jq --argjson p "$p" '.data = ((.data // {}) + ($p.data // {}) | with_entries(select(.value != null)))' "$f" >"$f.new"
  mv "$f.new" "$f" ;;
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
"get namespace")
  # ocp-single's existence check. MOCK_NO_NAMESPACE=NAME fails NAME's GET (NotFound).
  if [[ -n "${MOCK_NO_NAMESPACE-}" && "$MOCK_NO_NAMESPACE" == "$3" ]]; then
    echo "Error from server (NotFound): namespaces \"$3\" not found" >&2
    exit 1
  fi ;;
"get storageclass")
  if [[ -n "${MOCK_GET_SC_FAIL-}" ]]; then echo 'Error from server (Forbidden): storageclasses is forbidden' >&2; exit 1; fi
  if [[ -n "${MOCK_NO_DEFAULT_SC-}" ]]; then echo '{"items":[{"metadata":{"name":"slow"}}]}'
  else echo '{"items":[{"metadata":{"name":"standard","annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}]}'; fi ;;
*) echo "mock kubectl: unhandled: $*" >&2; exit 2 ;;
esac
MOCK

cat >"$TMP/bin/kind" <<'MOCK'
#!/usr/bin/env bash
printf 'kind %s\n' "$*" >>"$MOCK_LOG"
case "$*" in
version) echo "${MOCK_KIND_VERSION_OUT:-kind v${MOCK_KIND_VERSION:-0.27.0} go1.23.4 linux/amd64}" ;;
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
for flag in --target --image --sandbox-image --tls-cert --tls-key; do
  expect_fail --target ocp "$flag"
  expect_out "$flag needs a value"
done
expect_fail --target
expect_out '--target needs a value'
pass 'a value flag given no value is refused, naming the flag'
(export MOCK_KIND_VERSION_OUT='kind: something unexpected'; expect_fail --target kind)
expect_out 'could not read a version from `kind version`'
pass 'unrecognised `kind version` output is refused with a message, not a silent exit'

reset_state
(export MOCK_CURRENT_CONTEXT=prod-cluster SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind)
bad="$(grep '^kubectl ' "$MOCK_LOG" | grep -v '^kubectl --context kind-moca ' || true)"
[[ -z "$bad" ]] || fail "kubectl ran without --context kind-moca: $bad"
grep -q '^kubectl --context kind-moca apply -f ' "$MOCK_LOG" || fail 'no kubectl --context kind-moca apply -f was logged on kind'
reset_state
(export MOCK_CURRENT_CONTEXT=prod-cluster; expect_ok --target kind-ci --skip-build)
bad="$(grep '^kubectl ' "$MOCK_LOG" | grep -v '^kubectl --context kind-moca ' || true)"
[[ -z "$bad" ]] || fail "kubectl ran without --context kind-moca on kind-ci: $bad"
grep -q '^kubectl --context kind-moca apply -f ' "$MOCK_LOG" || fail 'no kubectl --context kind-moca apply -f was logged on kind-ci'
pass 'every kubectl call on kind and kind-ci is pinned to kind-moca, and the applies did run there (Review Focus 1)'
reset_state
(export MOCK_CURRENT_CONTEXT=prod-cluster SH_GITHUB_CLIENT_ID=Iv1.test; expect_ok --target kind)
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
grep 'run moca-genkeys' "$MOCK_LOG" | grep -q '"command":\["sh","-c","timeout 60 cat >/dev/null; exec node --import tsx src/genkeys.ts"\]' ||
  fail 'the generator writes before the attach is up (an attach does not replay earlier output)'
pass 'a leftover genkeys pod is deleted first; the override keeps stdin for the attach'
pass 'the generator writes only once the attach has closed its stdin'

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

echo "== Task 14: settings, overlay, apply, wait"
gen() { cat "$MOCK_STATE/applied-kustomization.yaml"; }
replicas_of() { gen | grep -A2 "name: $1 }" | grep -oE 'value: [0-9]+' | grep -oE '[0-9]+'; }
setting() { jq -r --arg k "$1" '.data[$k]' "$MOCK_STATE/moca__ConfigMap__moca-settings.json"; }

reset_state
expect_ok --target kind --skip-build
[[ "$(replicas_of moca-control-plane)" == 0 ]] || fail 'no client id must render the control plane at 0 replicas'
expect_out 'no SH_GITHUB_CLIENT_ID'
grep -q "^kubectl --context kind-moca apply -k $REPO/deploy/k8s/.generated/kind\$" "$MOCK_LOG" || fail 'not applied from the generated overlay'
grep -q '^  - ../../overlays/kind$' "$MOCK_STATE/applied-kustomization.yaml" || fail 'the generated overlay does not build on overlays/kind'
[[ "$(setting SH_PUBLIC_HARNESS_URL)" == http://127.0.0.1:8080 ]] || fail 'kind advertises the wrong harness URL'
# The control plane's configMapKeyRefs are not optional: a missing key stops the pod opaquely.
[[ "$(jq -c '.data | keys' "$MOCK_STATE/moca__ConfigMap__moca-settings.json")" == '["SH_ADMIN_SUBJECTS","SH_ALLOW_OPERATOR_FALLBACK","SH_GITHUB_CLIENT_ID","SH_PUBLIC_HARNESS_URL"]' ]] ||
  fail 'moca-settings must hold exactly the four keys the control plane references'
expect_out 'port-forward svc/moca-supervisor 8080:8080'
pass 'kind: generated overlay applied; control plane held at 0 without a client id; access printed'

hash_of() { gen | grep -oE 'moca.dev/settings-hash: "[0-9a-f]{64}"' | grep -oE '[0-9a-f]{64}'; }
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(replicas_of moca-control-plane)" == 1 ]] || fail 'a client id must render the control plane at 1 replica'
h1="$(hash_of)"
[[ -n "$h1" ]] || fail 'the generated overlay carries no settings hash on the control plane pod template'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(hash_of)" == "$h1" ]] || fail 'an unchanged re-run changed the settings hash (it would roll the control plane for nothing)'
(export SH_GITHUB_CLIENT_ID=Iv1.b; expect_ok --target kind --skip-build)
h2="$(hash_of)"
[[ -n "$h2" && "$h2" != "$h1" ]] || fail 'a changed client id did not change the settings hash'
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.b ]] || fail 'the new client id was not written'
pass 'the settings hash is stable for unchanged settings and changes with them (Review Focus 2)'

# The retry case: a run that wrote client id B and then failed before the roll. Nothing is
# remembered between runs, so the next run renders B's hash and the apply still rolls the pods.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
[[ "$(hash_of)" == "$h1" ]] || fail 'the settings hash depends on more than the settings'
(export SH_GITHUB_CLIENT_ID=Iv1.b MOCK_APPLY_K_FAIL=1; expect_fail --target kind --skip-build)
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.b ]] || fail 'the failed run did not get as far as writing the new settings'
[[ "$(hash_of)" == "$h1" ]] || fail 'the failed apply still recorded an applied kustomization'
(export SH_GITHUB_CLIENT_ID=Iv1.b; expect_ok --target kind --skip-build)
[[ "$(hash_of)" == "$h2" ]] || fail 'after a failed run, the re-run did not roll the control plane onto the new settings'
! grep -q 'rollout restart' "$MOCK_LOG" || fail 'the control plane is rolled by the hash; nothing may rollout restart it'
pass 'a settings change survives a failed run: the re-run applies the new hash'

if [[ -x "$TMP/bin/sha256sum" && -x "$TMP/bin/shasum" ]]; then
  mv "$TMP/bin/sha256sum" "$TMP/bin/sha256sum.off"
  (export SH_GITHUB_CLIENT_ID=Iv1.b; expect_ok --target kind --skip-build)
  mv "$TMP/bin/sha256sum.off" "$TMP/bin/sha256sum"
  [[ "$(hash_of)" == "$h2" ]] || fail 'shasum and sha256sum disagree on the settings hash'
  grep -q '^shasum -a 256' "$MOCK_LOG" || fail 'without sha256sum, shasum was not used'
  pass 'without sha256sum the hash comes from shasum -a 256, and is the same'
fi

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=3 MOCK_RECORDS=3; expect_ok --target kind --skip-build)
[[ "$(replicas_of moca-sandbox)" == 3 ]] || fail 'SH_SANDBOX_COUNT=3 did not set 3 replicas'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=3 MOCK_RECORDS=2; expect_fail --target kind --skip-build)
expect_out 'only 2 of 3 sandboxes attached'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0; expect_ok --target kind --skip-build)
[[ "$(replicas_of moca-sandbox)" == 0 ]] || fail 'SH_SANDBOX_COUNT=0 did not set 0 replicas'
! grep -q 'exec redis-0' "$MOCK_LOG" || fail 'SH_SANDBOX_COUNT=0 still waited for presence records'
pass 'SH_SANDBOX_COUNT drives replicas and the presence wait; 0 skips it (Review Focus 3)'

reset_state
expect_ok --target kind-ci --skip-build
grep -qF -- "--from-file=mock-anthropic.mjs=$REPO/deploy/microvm/mock-anthropic.mjs" "$MOCK_LOG" || fail 'kind-ci did not load the mock model ConfigMap'
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.k8s-smoke-unused ]] || fail 'kind-ci needs the placeholder client id'
[[ "$(replicas_of moca-control-plane)" == 1 ]] || fail 'kind-ci must run the control plane'
pass 'kind-ci: mock model ConfigMap, placeholder client id, control plane on'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
[[ "$(grep -c '^oc adm policy add-scc-to-user nonroot-v2' "$MOCK_LOG")" == 5 ]] || fail 'expected 5 SCC grants'
last_scc="$(grep -n '^oc adm policy' "$MOCK_LOG" | tail -1 | cut -d: -f1)"
apply_at="$(grep -n 'apply -k' "$MOCK_LOG" | cut -d: -f1)"
[[ "$last_scc" -lt "$apply_at" ]] || fail 'SCC grants must precede the apply'
gen | grep -q 'value: moca-moca.apps.example.test' || fail 'the supervisor Route host was not set'
gen | grep -q 'value: moca-control-plane-moca.apps.example.test' || fail 'the control plane Route host was not set'
[[ "$(setting SH_PUBLIC_HARNESS_URL)" == https://moca-moca.apps.example.test ]] || fail 'OCP advertises the wrong harness URL'
grep -q '^openssl req -x509' "$MOCK_LOG" || fail 'no self-signed certificate without --tls-cert'
[[ -f "$REPO/deploy/k8s/.generated/ocp/moca-supervisor-ca.crt" ]] || fail 'the self-signed CA file is missing'
expect_out 'NODE_EXTRA_CA_CERTS='
pass 'ocp: SCC before apply, Route hosts, https harness URL, self-signed cert with the trust line'

: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
! grep -q 'create secret tls' "$MOCK_LOG" || fail 'an existing TLS Secret was replaced without --tls-cert'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp --tls-cert "$TMP/c.pem" --tls-key "$TMP/k.pem" --image ghcr.io/me/moca:v1 --sandbox-image quay.io/me/rw@sha256:abc)
grep -qF -- "--cert=$TMP/c.pem" "$MOCK_LOG" || fail '--tls-cert was not installed'
gen | grep -q 'newName: ghcr.io/me/moca$' && gen | grep -q 'newTag: v1$' || fail '--image was not rendered'
gen | grep -q 'digest: sha256:abc$' || fail '--sandbox-image digest was not rendered'
assert_no_secret_in_argv
pass 'ocp: an existing cert is kept; --tls-cert replaces it; --image/--sandbox-image render'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_NO_DEFAULT_SC=1; expect_ok --target kind --skip-build)
expect_out 'no default StorageClass'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build)
! grep -q 'no default StorageClass' "$TMP/out" || fail 'warned about a default StorageClass that exists'
pass 'a cluster with no default StorageClass gets a warning before Redis waits on its PVC (spec §10)'

# An API error is never "missing" (same class as Task 13): an unreadable TLS Secret must not be
# replaced by a self-signed one.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
[[ -f "$MOCK_STATE/moca__Secret__moca-supervisor-tls.json" ]] || fail 'the first OCP run wrote no TLS Secret'
: >"$MOCK_LOG"
# MOCK_GET_FAIL=1 only proves the earlier abort in ensure_secrets; the MOCK_GET_FAIL=moca-supervisor-tls case below is the real ensure_tls test.
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_GET_FAIL=1; expect_fail --target ocp)
! grep -q 'create secret tls' "$MOCK_LOG" || fail 'a failed GET replaced the TLS Secret'
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_GET_FAIL=moca-supervisor-tls; expect_fail --target ocp)
expect_out 'etcd timeout'
! grep -q 'create secret tls' "$MOCK_LOG" || fail 'a failed GET of moca-supervisor-tls alone replaced it with a self-signed one'
pass 'ocp: a failed GET of the TLS Secret aborts the run and keeps the operator certificate'

# A failed openssl or apply must not leave the self-signed private key behind.
reset_state
mkdir -p "$TMP/tmpdir"
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_MKTEMP_DIR="$TMP/tmpdir" MOCK_TLS_CREATE_FAIL=1; expect_fail --target ocp)
[[ -z "$(ls -A "$TMP/tmpdir")" ]] || fail "a failed TLS apply left the self-signed key behind: $(ls -A "$TMP/tmpdir")"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_MKTEMP_DIR="$TMP/tmpdir"; expect_ok --target ocp)
[[ -z "$(ls -A "$TMP/tmpdir")" ]] || fail 'a successful run left the self-signed key behind'
pass 'ocp: the self-signed private key is removed whether the TLS install succeeds or fails'

echo "== sticky inputs: a re-run keeps every input it is not given"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_ADMIN_SUBJECTS=github:alice SH_ALLOW_OPERATOR_FALLBACK=true; expect_ok --target kind --skip-build)
h1="$(hash_of)"
(unset SH_GITHUB_CLIENT_ID SH_ADMIN_SUBJECTS SH_ALLOW_OPERATOR_FALLBACK; expect_ok --target kind --skip-build)
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.a ]] || fail 'a re-run without SH_GITHUB_CLIENT_ID dropped the client id'
[[ "$(setting SH_ADMIN_SUBJECTS)" == github:alice ]] || fail 'a re-run without SH_ADMIN_SUBJECTS dropped the admins'
[[ "$(setting SH_ALLOW_OPERATOR_FALLBACK)" == true ]] || fail 'a re-run without SH_ALLOW_OPERATOR_FALLBACK reset it'
[[ "$(replicas_of moca-control-plane)" == 1 ]] || fail 'a re-run without SH_GITHUB_CLIENT_ID scaled the control plane to 0'
! grep -q 'no SH_GITHUB_CLIENT_ID' "$TMP/out" || fail 'a re-run with a stored client id still warned that there is none'
[[ "$(hash_of)" == "$h1" ]] || fail 'a re-run with no inputs changed the settings hash (it would roll the control plane)'
grep -q 'rollout status deployment/moca-control-plane' "$MOCK_LOG" || fail 'the re-run did not wait for the control plane it keeps running'
pass 'settings are sticky: a re-run without them keeps the client id, admins, fallback, replicas and hash'
(export SH_ADMIN_SUBJECTS=; expect_ok --target kind --skip-build)
[[ -z "$(setting SH_ADMIN_SUBJECTS)" ]] || fail 'SH_ADMIN_SUBJECTS= (explicitly empty) did not clear the admins'
[[ "$(setting SH_GITHUB_CLIENT_ID)" == Iv1.a ]] || fail 'clearing the admins touched the client id'
(export SH_GITHUB_CLIENT_ID=; expect_ok --target kind --skip-build)
[[ -z "$(setting SH_GITHUB_CLIENT_ID)" && "$(replicas_of moca-control-plane)" == 0 ]] || fail 'SH_GITHUB_CLIENT_ID= did not clear the client id'
pass 'an explicitly empty variable clears its setting'
(export MOCK_GET_CM_FAIL=moca-settings SH_ADMIN_SUBJECTS=github:bob; expect_fail --target kind --skip-build)
expect_out 'etcd timeout'
[[ -z "$(setting SH_ADMIN_SUBJECTS)" ]] || fail 'a failed moca-settings read still wrote the settings'
(export MOCK_GET_CM_FAIL=moca-setup; expect_fail --target kind --skip-build)
expect_out 'etcd timeout'
pass 'a failed read of moca-settings or moca-setup aborts the run instead of resetting the inputs'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=3 MOCK_RECORDS=3; expect_ok --target kind --skip-build)
(export MOCK_RECORDS=3; expect_ok --target kind --skip-build)
[[ "$(replicas_of moca-sandbox)" == 3 ]] || fail 'a re-run without SH_SANDBOX_COUNT reset the sandbox count'
[[ "$(jq -r '.data.SH_SANDBOX_COUNT' "$MOCK_STATE/moca__ConfigMap__moca-setup.json")" == 3 ]] || fail 'moca-setup does not hold the sandbox count'
(export SH_SANDBOX_COUNT=1 MOCK_RECORDS=1; expect_ok --target kind --skip-build)
[[ "$(replicas_of moca-sandbox)" == 1 ]] || fail 'a given SH_SANDBOX_COUNT did not replace the stored one'
pass 'SH_SANDBOX_COUNT is sticky, and a given value replaces it'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp --image ghcr.io/me/moca:v1 --sandbox-image quay.io/me/rw@sha256:abc)
: >"$MOCK_LOG"
(unset SH_GITHUB_CLIENT_ID; expect_ok --target ocp)
gen | grep -q 'newName: ghcr.io/me/moca$' && gen | grep -q 'newTag: v1$' || fail 'an OCP re-run without --image rolled the harness image back'
gen | grep -q 'digest: sha256:abc$' || fail 'an OCP re-run without --sandbox-image rolled the sandbox image back'
[[ "$(replicas_of moca-control-plane)" == 1 ]] || fail 'an OCP re-run without SH_GITHUB_CLIENT_ID scaled the control plane to 0'
(expect_ok --target ocp --image ghcr.io/me/moca:v2)
gen | grep -q 'newTag: v2$' || fail 'a given --image did not replace the stored one'
gen | grep -q 'digest: sha256:abc$' || fail 'a given --image dropped the stored --sandbox-image'
pass 'ocp: --image and --sandbox-image are sticky; a given one replaces only itself'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target kind --skip-build --image ghcr.io/me/moca:v1)
! gen | grep -q 'images:' || fail 'kind rendered an images: override (it runs the locally loaded images)'
pass 'kind: images are for the local load only, never the overlay'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_GET_SC_FAIL=1; expect_ok --target kind --skip-build)
expect_out 'could not list StorageClasses'
! grep -q 'no default StorageClass' "$TMP/out" || fail 'an unreadable StorageClass list was reported as no default'
pass 'an unreadable StorageClass list is reported as such, and the advisory check does not abort'

echo "== P6.2 Task 5: P4 inputs"
p4_stored() { jq -r '.data.SH_P4_SANDBOX_IDS // empty' "$MOCK_STATE/moca__ConfigMap__moca-setup.json"; }

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=' moca_microvm_0 , moca_microvm_1,'; expect_ok --target ocp)
[[ "$(p4_stored)" == moca_microvm_0,moca_microvm_1 ]] || fail "spaces and a trailing comma were not normalised: '$(p4_stored)'"
pass 'SH_P4_SANDBOX_IDS: spaces trimmed, empty entries dropped, stored comma-joined (Review Focus 1)'

(unset SH_P4_SANDBOX_IDS; export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
[[ "$(p4_stored)" == moca_microvm_0,moca_microvm_1 ]] || fail 'a re-run without SH_P4_SANDBOX_IDS dropped the stored IDs'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=; expect_ok --target ocp)
[[ -z "$(p4_stored)" ]] || fail 'SH_P4_SANDBOX_IDS= (explicitly empty) did not clear the IDs'
pass 'SH_P4_SANDBOX_IDS is sticky, and an explicitly empty value clears it'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca-microvm-0; expect_fail --target ocp)
expect_out "'moca-microvm-0' must match"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=a,b,a; expect_fail --target ocp)
expect_out "lists 'a' twice"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS='*'; expect_fail --target ocp)
expect_out "'*' must match"
# The relay refuses the ID DIR before any lookup (spec §2.1): such a host could never attach.
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca_microvm_0,DIR; expect_fail --target ocp)
expect_out "'DIR' is reserved"
expect_out 'SH_RELAY_TOKEN_DIR'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=a; expect_fail --target kind --skip-build)
expect_out 'needs --target ocp'
! grep -q '^kubectl' "$MOCK_LOG" || fail 'a refused ID list still reached the cluster'
pass 'refused: an ID with a dash, a duplicate, glob char, the reserved DIR, P4 IDs on kind -- before anything touches a cluster'

# The live switch from a slice-1 stack: moca-setup already holds SH_SANDBOX_COUNT=2.
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=moca_microvm_0; expect_fail --target ocp)
expect_out 'SH_SANDBOX_COUNT=2'
expect_out 'Re-run with SH_SANDBOX_COUNT=0'
[[ -z "$(p4_stored)" ]] || fail 'a refused run still stored the P4 IDs'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca_microvm_0; expect_ok --target ocp)
[[ "$(p4_stored)" == moca_microvm_0 ]] || fail 'the switch with SH_SANDBOX_COUNT=0 did not store the ID'
pass 'one tier per stack: the stored count of 2 refuses P4 IDs, names the fix, and stores nothing (Review Focus 2)'

reset_state
expect_fail --target kind --relay-tls-cert "$TMP/c.pem" --relay-tls-key "$TMP/k.pem"
expect_out 'apply to --target ocp only'
expect_fail --target ocp --relay-tls-cert "$TMP/c.pem"
expect_out 'go together'
expect_fail --target ocp --relay-tls-cert
expect_out '--relay-tls-cert needs a value'
expect_ok --help
expect_out 'SH_P4_SANDBOX_IDS'
expect_out '--relay-tls-cert FILE --relay-tls-key FILE'
pass '--relay-tls-cert/--relay-tls-key: ocp only, a pair, a value each; --help lists them'

# Bash 3.2 compatibility: normalize_p4_ids must work on bash < 4.4 with set -u
# The bug: unset empty array with "set -u" causes "parts[@]: unbound variable".
# Tests the exact call paths: empty input, all-comma input, mixed spaces/commas, and real parse_args path.
if [[ -x /bin/bash ]]; then
  bash3_version="$(/bin/bash --version 2>&1 | head -1)"
  if [[ "$bash3_version" == *"version 3."* ]]; then
    test_output=$(/bin/bash -euo pipefail -c "
      SH_SOURCE_ONLY=1
      . '$SETUP'
      # Test each problematic input path under bash 3.2 with set -u
      normalize_p4_ids '' || exit 1
      normalize_p4_ids ',' || exit 1
      normalize_p4_ids ' , ' || exit 1
      result=\$(normalize_p4_ids 'a,b')
      [[ \"\$result\" == 'a b' ]] || exit 1
      unset SH_P4_SANDBOX_IDS
      parse_args --target kind || exit 1
      echo 'all tests passed'
    " 2>&1)
    [[ "$test_output" == *"all tests passed"* ]] || fail "normalize_p4_ids failed on bash 3.2 with set -u: $test_output"
    pass "normalize_p4_ids works on bash 3.2 with set -u (empty arrays safe); all edge cases tested"
  else
    echo "skip - bash 3.2 not available (version is: $bash3_version)"
  fi
else
  echo "skip - bash 3.2 not available at /bin/bash"
fi

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=$'a,b\nc,d'; expect_fail --target ocp)
expect_out 'must be one line'
pass 'multiline SH_P4_SANDBOX_IDS is refused'

echo "== P6.2 Task 6: P4 tokens, relay certificate, bundles"
P4B="$REPO/deploy/k8s/.generated/ocp/p4"
RCA="$REPO/deploy/k8s/.generated/ocp/moca-relay-ca.crt"
p4_ok() { (export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS="$1"; shift; expect_ok --target ocp "$@"); }
tok() { sv moca moca-relay-sandbox-tokens "$1"; }
tok_keys() { jq -r '.data // {} | keys | join(",")' "$MOCK_STATE/moca__Secret__moca-relay-sandbox-tokens.json"; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

reset_state
p4_ok moca_microvm_0,moca_microvm_1
[[ "$(tok_keys)" == moca_microvm_0,moca_microvm_1 ]] || fail "expected one token key per ID, got '$(tok_keys)'"
[[ "$(tok moca_microvm_0)" =~ ^[0-9a-f]{64}$ && "$(tok moca_microvm_1)" =~ ^[0-9a-f]{64}$ ]] || fail 'a P4 token is not 64 hex'
[[ "$(tok moca_microvm_0)" != "$(tok moca_microvm_1)" ]] || fail 'two P4 IDs share a token'
[[ "$(tok moca_microvm_0)" != "$(sv moca moca-relay MOCA_RELAY_EXEC_TOKEN)" ]] || fail 'a P4 token equals the exec token'
[[ ! -e "$MOCK_STATE/moca-sandbox__Secret__moca-relay-sandbox-tokens.json" ]] || fail 'P4 tokens reached moca-sandbox'
assert_no_secret_in_argv
pass 'one 64-hex token per P4 ID in moca-relay-sandbox-tokens, distinct, never the exec token, never in moca-sandbox'

t0="$(tok moca_microvm_0)"
p4_ok moca_microvm_0,moca_microvm_1
[[ "$(tok moca_microvm_0)" == "$t0" ]] || fail 'a re-run rotated a P4 token'
: >"$MOCK_LOG"
p4_ok moca_microvm_0
[[ "$(tok_keys)" == moca_microvm_0 ]] || fail "the dropped ID's token was not revoked: '$(tok_keys)'"
[[ "$(tok moca_microvm_0)" == "$t0" ]] || fail 'revoking one ID rotated another'
grep -q '^kubectl patch secret moca-relay-sandbox-tokens' "$MOCK_LOG" || fail 'revocation did not patch the Secret'
[[ ! -e "$P4B/moca_microvm_1" ]] || fail "the dropped ID's bundle was kept"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=; expect_ok --target ocp)
[[ -z "$(tok_keys)" ]] || fail "clearing the IDs left tokens: '$(tok_keys)'"
[[ ! -e "$P4B/moca_microvm_0" ]] || fail 'clearing the IDs left a bundle'
pass 'tokens are kept on a re-run; a dropped ID loses its token and bundle; clearing the list empties the Secret'

# Revocation uses an idempotent merge patch: the patch succeeds even when the stale key is already
# absent (e.g., the API server pruned it during server-side apply). When MOCK_SSA_PRUNE=1, the
# mock simulates server-side apply pruning keys it no longer applies, so the stale key is gone
# before the patch runs.
p4_ok moca_microvm_0,moca_microvm_1
t_mv0="$(tok moca_microvm_0)"
# Now run with only moca_microvm_0, with API server pruning enabled. The apply will remove
# moca_microvm_1 from the Secret, making it truly absent before revocation tries to patch it.
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca_microvm_0 MOCK_SSA_PRUNE=1; expect_ok --target ocp)
# Revocation should have tried to patch and succeeded despite moca_microvm_1 already being absent.
grep -q '^kubectl patch secret moca-relay-sandbox-tokens' "$MOCK_LOG" || fail 'revocation patch was not called'
[[ "$(tok moca_microvm_0)" == "$t_mv0" ]] || fail 'moca_microvm_0 token was rotated'
[[ "$(tok_keys)" == moca_microvm_0 ]] || fail 'moca_microvm_1 token was not revoked or another key remained'
[[ ! -e "$P4B/moca_microvm_1" ]] || fail "moca_microvm_1 bundle was not deleted"
pass 'revocation is idempotent: the merge patch succeeds when the stale key is absent (server-side apply pruned it)'

# A stored token equal to the exec token (the relay would refuse it, spec §2.2) is regenerated.
reset_state
p4_ok moca_microvm_0
exec_b64="$(jq -r '.data.MOCA_RELAY_EXEC_TOKEN' "$MOCK_STATE/moca__Secret__moca-relay.json")"
jq --arg v "$exec_b64" '.data.moca_microvm_0 = $v' "$MOCK_STATE/moca__Secret__moca-relay-sandbox-tokens.json" >"$TMP/t.json"
mv "$TMP/t.json" "$MOCK_STATE/moca__Secret__moca-relay-sandbox-tokens.json"
p4_ok moca_microvm_0
[[ "$(tok moca_microvm_0)" != "$(sv moca moca-relay MOCA_RELAY_EXEC_TOKEN)" ]] || fail 'a P4 token equal to the exec token was kept'
pass 'a P4 token equal to the exec token is regenerated'

t0="$(tok moca_microvm_0)"
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=moca_microvm_0 MOCK_GET_FAIL=moca-relay-sandbox-tokens; expect_fail --target ocp)
expect_out 'etcd timeout'
[[ "$(tok moca_microvm_0)" == "$t0" ]] || fail 'a failed GET of the token Secret rotated a token'
pass 'a failed GET of moca-relay-sandbox-tokens aborts the run and rotates nothing'

reset_state
p4_ok moca_microvm_0
grep -q '^openssl req -x509 .*CN=moca-relay-moca.apps.example.test' "$MOCK_LOG" || fail 'no self-signed relay certificate for the relay Route host'
[[ -f "$MOCK_STATE/moca__Secret__moca-relay-tls.json" ]] || fail 'no moca-relay-tls Secret'
[[ -s "$RCA" ]] || fail 'the relay CA file is missing'
: >"$MOCK_LOG"
p4_ok moca_microvm_0
! grep -q 'create secret tls moca-relay-tls' "$MOCK_LOG" || fail 'an existing relay certificate was replaced'
[[ -s "$RCA" ]] || fail 'a re-run lost the relay CA file'
: >"$MOCK_LOG"
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=moca_microvm_0 MOCK_GET_FAIL=moca-relay-tls; expect_fail --target ocp)
expect_out 'etcd timeout'
! grep -q 'create secret tls moca-relay-tls' "$MOCK_LOG" || fail 'a failed GET of moca-relay-tls replaced it with a self-signed one'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
[[ ! -e "$MOCK_STATE/moca__Secret__moca-relay-tls.json" ]] || fail 'a stack with no P4 IDs got a relay certificate'
pass 'relay certificate: self-signed for the Route host once, kept, fail-closed on GET, absent with no P4 IDs'

# The bundle (spec §4.5) is what setup-microvm.sh --remote installs (Task 8).
reset_state
p4_ok moca_microvm_0
b="$P4B/moca_microvm_0"
printf 'RELAY_ADDR=moca-relay-moca.apps.example.test:443\nRELAY_TLS=true\nSANDBOX_ID=moca_microvm_0\nSANDBOX_TOKEN=%s\n' "$(tok moca_microvm_0)" >"$TMP/want.env"
cmp -s "$b/worker.env" "$TMP/want.env" || fail "worker.env is wrong: $(cat "$b/worker.env")"
cmp -s "$b/relay-ca.crt" "$RCA" || fail 'the bundle does not carry the self-signed relay CA'
[[ "$(mode_of "$P4B")" == 700 && "$(mode_of "$b")" == 700 ]] || fail 'bundle directories are not 0700'
[[ "$(mode_of "$b/worker.env")" == 600 && "$(mode_of "$b/relay-ca.crt")" == 600 ]] || fail 'bundle files are not 0600'
assert_no_secret_in_argv
pass 'bundle: worker.env with the Route host, TLS, ID and token; the relay CA; 0700/0600; the token never on argv'

# An operator certificate: a leaf signed by a CA (so not self-issued). The bundle carries no CA.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=test-ca -keyout "$TMP/ca.key" -out "$TMP/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=moca-relay-moca.apps.example.test -keyout "$TMP/leaf.key" -out "$TMP/leaf.csr" 2>/dev/null
openssl x509 -req -in "$TMP/leaf.csr" -CA "$TMP/ca.crt" -CAkey "$TMP/ca.key" -CAcreateserial -days 2 -out "$TMP/leaf.crt" 2>/dev/null
reset_state
p4_ok moca_microvm_0 --relay-tls-cert "$TMP/leaf.crt" --relay-tls-key "$TMP/leaf.key"
grep -qF -- "--cert=$TMP/leaf.crt" "$MOCK_LOG" || fail '--relay-tls-cert was not installed'
[[ ! -e "$RCA" && ! -e "$P4B/moca_microvm_0/relay-ca.crt" ]] || fail 'an operator certificate still produced a relay CA file'
pass 'an operator relay certificate is installed, and the bundle carries no CA (the host trusts its issuer)'

echo "== P6.2 Task 7: rendering and printing"
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp)
! gen | grep -q 'p4-relay\|moca-relay' || fail 'a stack with no P4 IDs rendered the p4-relay component'
reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SANDBOX_COUNT=0 SH_P4_SANDBOX_IDS=moca_microvm_0; expect_ok --target ocp)
gen | grep -qx '  - ../../overlays/ocp/p4-relay' || fail 'the p4-relay component is not listed'
gen | grep -q 'name: moca-relay }' || fail 'the relay Route is not patched'
gen | grep -q 'value: moca-relay-moca.apps.example.test' || fail 'the relay Route host is wrong'
expect_out "$REPO/deploy/k8s/.generated/ocp/p4/moca_microvm_0"
# scp -r into an existing target nests the copy, so an earlier copy is removed first, then copied.
expect_out 'ssh <kvm-host> rm -r moca-p4-moca_microvm_0   (an earlier copy, if any: scp -r would nest into it)'
expect_out "scp -r $REPO/deploy/k8s/.generated/ocp/p4/moca_microvm_0 <kvm-host>:moca-p4-moca_microvm_0"
[[ "$(grep -n 'rm -r moca-p4-moca_microvm_0' "$TMP/out" | cut -d: -f1)" -lt "$(grep -n '^ *scp -r ' "$TMP/out" | cut -d: -f1)" ]] ||
  fail 'the earlier copy is not removed before the scp'
expect_out 'sudo deploy/microvm/setup-microvm.sh --remote ~/moca-p4-moca_microvm_0'
pass 'P4 IDs render the p4-relay component and the relay Route host, and print each host command; none render nothing'

echo "== ocp-single: single-namespace, no-SCC target"
reset_state
expect_fail --target prod-single
expect_out 'kind, kind-ci, ocp or ocp-single'
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_fail --target ocp-single --tls-cert "$TMP/c.pem" --tls-key "$TMP/k.pem")
expect_out 'apply to --target ocp only'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_P4_SANDBOX_IDS=moca_microvm_0; expect_fail --target ocp-single)
expect_out 'needs --target ocp'
pass 'ocp-single: unknown targets, TLS flags and P4 IDs are refused, naming the fix'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp-single)
# No oc was needed (oc would be mocked, but preflight must not even require it: the PATH holds the
# mocks, so assert on the absence of oc's whoami in the argv log instead).
grep -q '^oc whoami' "$MOCK_LOG" && fail 'ocp-single ran oc, which the target must not need'
# No SCC grant: the whole run never calls oc adm.
grep -q 'oc adm' "$MOCK_LOG" && fail 'ocp-single granted an SCC, which the target must not do'
# The namespace existence check ran, against the default moca-single.
grep -q 'kubectl get namespace moca-single' "$MOCK_LOG" || fail 'the namespace existence check did not run'
# The generated overlay sets the namespace transformer and rewrites the env strings off the
# placeholder only when the namespace is custom; the default keeps the overlay's own strings.
gen | grep -qx 'namespace: moca-single' || fail 'the generated overlay does not set the namespace transformer'
! grep -q 'SH_RELAY_ADDR' "$MOCK_STATE/applied-kustomization.yaml" ||
  fail 'the default namespace rewrote env strings that the overlay already carries'
pass 'ocp-single: needs no oc and no SCC, checks the namespace exists, sets the namespace transformer'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SINGLE_NAMESPACE=moca-tenant-1; expect_ok --target ocp-single)
gen | grep -qx 'namespace: moca-tenant-1' || fail 'a custom SH_SINGLE_NAMESPACE did not reach the generated overlay'
gen | grep -q 'sandbox-relay-exec.moca-tenant-1.svc:9444' || fail 'the supervisor env string was not rewritten'
gen | grep -q 'moca-control-plane.moca-tenant-1.svc:8080' || fail 'the control plane URL was not rewritten'
gen | grep -q 'sandbox-relay-attach.moca-tenant-1.svc:9443' || fail 'the sandbox env string was not rewritten'
jq -e -r '.data.SH_SINGLE_NAMESPACE' "$MOCK_STATE/moca-tenant-1__ConfigMap__moca-setup.json" >/dev/null 2>&1 ||
  fail 'moca-setup does not record SH_SINGLE_NAMESPACE for the smoke to read'
grep -q 'kubectl get namespace moca-tenant-1' "$MOCK_LOG" || fail 'the custom namespace existence check did not run'
expect_out 'namespace moca-tenant-1'
pass 'ocp-single: SH_SINGLE_NAMESPACE drives the transformer, the env strings and moca-setup'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SINGLE_NAMESPACE=Bad_NS; expect_fail --target ocp-single)
expect_out 'is not a namespace name'
(export SH_GITHUB_CLIENT_ID=Iv1.a SH_SINGLE_NAMESPACE=moca; expect_fail --target ocp-single)
expect_out 'collides with the base'
(export SH_GITHUB_CLIENT_ID=Iv1.a MOCK_NO_NAMESPACE=moca-single; expect_fail --target ocp-single)
expect_out 'cannot create it'
pass 'ocp-single: an invalid, a colliding and a missing namespace are refused, naming the fix'

reset_state
(export SH_GITHUB_CLIENT_ID=Iv1.a; expect_ok --target ocp-single)
expect_out 'kubectl -n moca-single port-forward svc/moca-supervisor'
! grep -q 'ocp-single.*https' "$TMP/out" || fail 'ocp-single printed an https URL; it has no Routes'
pass 'ocp-single: access is printed as port-forward commands, never a Route URL'

echo "setup.test.sh: all passed"
