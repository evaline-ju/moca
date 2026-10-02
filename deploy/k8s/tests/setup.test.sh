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
  f="$(store "$ns" "$kind" "$3")"
  [[ -f "$f" ]] || { echo "Error from server (NotFound): $2 \"$3\" not found" >&2; exit 1; }
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
  local f k v
  for f in "$MOCK_STATE"/*__Secret__*.json; do
    [[ -e "$f" ]] || continue
    for k in $(jq -r '.data | keys[]' "$f"); do
      [[ "$k" != redis.conf ]] || continue # multi-line; its password is checked through REDIS_PASSWORD
      v="$(jq -r --arg k "$k" '.data[$k]' "$f" | base64 --decode)"
      [[ ${#v} -ge 16 ]] || continue
      if grep -qF -- "$v" "$MOCK_LOG"; then fail "secret $k of $(basename "$f") reached a process argv"; fi
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
