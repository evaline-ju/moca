#!/usr/bin/env bash
# deploy/k8s/setup.sh -- bring up P6 on Kubernetes (docs/specs/2026-10-02-p6-on-kubernetes-slice1-design.md §4).
#
#   deploy/k8s/setup.sh --target kind|kind-ci|ocp [--image IMG] [--sandbox-image IMG]
#                       [--build|--skip-build] [--tls-cert FILE --tls-key FILE]
#
# Environment: SH_GITHUB_CLIENT_ID, SH_ADMIN_SUBJECTS, SH_ALLOW_OPERATOR_FALLBACK (default false),
# SH_SANDBOX_COUNT (default 2; 0 runs no container sandboxes), SH_WAIT_SECONDS (default 120),
# SH_SOURCE_ONLY=1 (define the functions and stop, for tests).
#
# Idempotent: a re-run converges and never rotates a secret. No secret value is ever put on a
# command line -- values travel through pipes and through the environment of the one jq that
# writes each Secret.
set -euo pipefail

K8S_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$K8S_DIR/../.." && pwd)"
KIND_CLUSTER=moca
KIND_CONTEXT=kind-moca
MIN_KIND_VERSION=0.24.0
NS=moca
SBX_NS=moca-sandbox
LOCAL_HARNESS=dev.local/moca:local
LOCAL_SANDBOX=dev.local/moca-remote-worker:local

TARGET=''
IMAGE=''
SANDBOX_IMAGE=''
BUILD=auto
TLS_CERT=''
TLS_KEY=''

log() { printf '==> %s\n' "$*" >&2; }
die() {
  printf 'setup.sh: %s\n' "$*" >&2
  exit 1
}
usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --target) TARGET="${2-}"; shift 2 ;;
    --image) IMAGE="${2-}"; shift 2 ;;
    --sandbox-image) SANDBOX_IMAGE="${2-}"; shift 2 ;;
    --build) BUILD=always; shift ;;
    --skip-build) BUILD=never; shift ;;
    --tls-cert) TLS_CERT="${2-}"; shift 2 ;;
    --tls-key) TLS_KEY="${2-}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
    esac
  done
  case "$TARGET" in
  kind | kind-ci | ocp) ;;
  '') die '--target is required: kind, kind-ci or ocp' ;;
  *) die "unknown --target '$TARGET': kind, kind-ci or ocp" ;;
  esac
  if [[ -n "$TLS_CERT$TLS_KEY" ]]; then
    [[ "$TARGET" == ocp ]] || die '--tls-cert/--tls-key apply to --target ocp only'
    [[ -n "$TLS_CERT" && -n "$TLS_KEY" ]] || die '--tls-cert and --tls-key go together'
    [[ -r "$TLS_CERT" && -r "$TLS_KEY" ]] || die "cannot read $TLS_CERT or $TLS_KEY"
  fi
  SH_SANDBOX_COUNT="${SH_SANDBOX_COUNT:-2}"
  [[ "$SH_SANDBOX_COUNT" =~ ^[0-9]+$ ]] ||
    die "SH_SANDBOX_COUNT='$SH_SANDBOX_COUNT' must be a whole number (0 runs no container sandboxes)"
  SH_WAIT_SECONDS="${SH_WAIT_SECONDS:-120}"
}

is_kind() { [[ "$TARGET" == kind || "$TARGET" == kind-ci ]]; }

# Every cluster call goes through here. On Kind it is pinned to the kind-moca context, never the
# ambient one: a Kind run must not apply a stack to whatever cluster the shell happens to point at.
kc() {
  if is_kind; then kubectl --context "$KIND_CONTEXT" "$@"; else kubectl "$@"; fi
}

# version_ge A B: A >= B, dotted numeric.
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

preflight() {
  local need='kubectl openssl jq' missing='' c v
  if is_kind; then need="$need kind docker"; else need="$need oc"; fi
  for c in $need; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
  [[ -z "$missing" ]] || die "missing required commands:$missing"
  if is_kind; then
    v="$(kind version | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    v="${v#v}"
    version_ge "$v" "$MIN_KIND_VERSION" ||
      die "kind v$MIN_KIND_VERSION or newer is required (found v$v): it is the first whose default CNI enforces NetworkPolicy, and this deployment's isolation IS NetworkPolicy"
  else
    oc whoami >/dev/null 2>&1 || die 'not logged in to OpenShift: run `oc login` first'
    log "target cluster: $(kubectl config current-context)"
  fi
}

ensure_kind_cluster() {
  if ! kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
    log "creating kind cluster $KIND_CLUSTER"
    kind create cluster --name "$KIND_CLUSTER"
  fi
}

# local_image SOURCE_REF LOCAL_TAG DOCKERFILE: pull-else-build (setup-kind.sh's pattern), then load.
local_image() {
  local src="$1" tag="$2" dockerfile="$3"
  case "$BUILD" in
  never)
    log "--skip-build: assuming $tag is already loaded"
    return 0
    ;;
  always) docker build --load -t "$tag" -f "$dockerfile" "$REPO_ROOT" ;;
  auto)
    if docker pull "$src"; then
      docker tag "$src" "$tag"
    else
      log "could not pull $src; building $tag from this checkout"
      docker build --load -t "$tag" -f "$dockerfile" "$REPO_ROOT"
    fi
    ;;
  esac
  kind load docker-image "$tag" --name "$KIND_CLUSTER"
}

ensure_images() {
  is_kind || return 0
  ensure_kind_cluster
  local_image "${IMAGE:-ghcr.io/rossoctl/moca:latest}" "$LOCAL_HARNESS" "$REPO_ROOT/Dockerfile"
  local_image "${SANDBOX_IMAGE:-ghcr.io/rossoctl/moca-remote-worker:latest}" "$LOCAL_SANDBOX" "$REPO_ROOT/remote-worker/Dockerfile"
}

# The harness image as the cluster runs it (for the one-shot key generator pod).
harness_ref() { if is_kind; then echo "$LOCAL_HARNESS"; else echo "${IMAGE:-ghcr.io/rossoctl/moca:latest}"; fi; }

# Namespaces alone first, so Secrets can land before any workload that mounts them.
ensure_namespaces() { kc apply -f "$K8S_DIR/base/namespaces.yaml" >/dev/null; }

# --- Secrets (spec §4.2) -----------------------------------------------------------------------
# Generated once and never rotated: an existing value is always kept; only a missing key is filled.

# secret_json NAME NS: the Secret as JSON, or nothing when it does not exist (the normal first-run
# case). Any other API error -- timeout, 5xx, RBAC denial, expired token -- fails, and the caller's
# assignment aborts the run: an unreadable Secret must never look like a missing one, or the next
# apply would rotate it (for SH_CREDENTIAL_KEK, losing every stored credential).
secret_json() { kc get secret "$1" -n "$2" --ignore-not-found -o json; }

# json_value JSON KEY: KEY's decoded value from secret_json's output, or nothing. The JSON reaches
# jq on stdin (printf is a builtin), never on argv.
json_value() { printf '%s' "$1" | jq -r --arg k "$2" '.data[$k] // empty' | base64 --decode; }

# secret_value NAME NS KEY: one key, fetched on its own. Callers needing several keys of one Secret
# fetch it once with secret_json, so every key comes from the same read.
secret_value() {
  local json
  json="$(secret_json "$1" "$2")" || return 1 # $(...) clears set -e: fail explicitly
  json_value "$json" "$3"
}

rand_hex() { openssl rand -hex 32; }

# apply_secret NAME NS KEY...: the values are $S_0, $S_1, ... in this call's environment (callers
# export them in a subshell). jq reads them from its environment, so no value reaches argv.
# Server-side apply writes no last-applied-configuration annotation, which would copy every value.
apply_secret() {
  local name="$1" ns="$2"
  shift 2
  jq -n --arg name "$name" --arg ns "$ns" \
    '{apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: {name: $name, namespace: $ns},
      stringData: ([$ARGS.positional | to_entries[] | {key: .value, value: env["S_\(.key)"]}] | from_entries)}' \
    --args "$@" | kc apply --server-side --force-conflicts --field-manager=moca-setup -f - >/dev/null
}

ensure_relay_secrets() {
  local json relay exec_token
  json="$(secret_json moca-relay "$NS")"
  relay="$(json_value "$json" SH_RELAY_TOKEN)"
  exec_token="$(json_value "$json" MOCA_RELAY_EXEC_TOKEN)"
  [[ -n "$relay" ]] || { log 'generating SH_RELAY_TOKEN'; relay="$(rand_hex)"; }
  [[ -n "$exec_token" ]] || { log 'generating MOCA_RELAY_EXEC_TOKEN'; exec_token="$(rand_hex)"; }
  # The relay refuses to boot on equal tokens (MI1 §5 R5); say why here, before it crash-loops.
  [[ "$relay" != "$exec_token" ]] ||
    die 'moca-relay holds the same value for SH_RELAY_TOKEN and MOCA_RELAY_EXEC_TOKEN: delete the Secret and re-run'
  (
    export S_0="$relay" S_1="$exec_token"
    apply_secret moca-relay "$NS" SH_RELAY_TOKEN MOCA_RELAY_EXEC_TOKEN
  )
  # The sandbox namespace's ONLY Secret: the attach token, and nothing else.
  (
    export S_0="$relay"
    apply_secret moca-relay-attach "$SBX_NS" SH_RELAY_TOKEN
  )
}

ensure_redis_secret() {
  local json pw
  json="$(secret_json moca-redis "$NS")"
  pw="$(json_value "$json" REDIS_PASSWORD)"
  [[ -n "$pw" ]] || { log 'generating the Redis password'; pw="$(rand_hex)"; }
  # URL and config are re-derived from the password on every run, so the three can never disagree.
  (
    export S_0="$pw" S_1="redis://:$pw@redis.$NS.svc:6379"
    S_2="$(printf 'requirepass %s\nappendonly yes\ndir /data\n' "$pw")"
    export S_2
    apply_secret moca-redis "$NS" REDIS_PASSWORD REDIS_URL redis.conf
  )
}

# The control plane's key generator, run once in the harness image as a pod (no local Docker or
# Node needed). Pod Security in moca is restricted; on Kind the image (no USER) needs an explicit
# UID, while OpenShift's SCC assigns one.
genkeys() {
  local ref sc
  ref="$(harness_ref)"
  if is_kind; then
    sc='{"runAsNonRoot":true,"runAsUser":65532,"seccompProfile":{"type":"RuntimeDefault"}}'
  else
    sc='{"runAsNonRoot":true,"seccompProfile":{"type":"RuntimeDefault"}}'
  fi
  # A pod left behind by a crashed run would make `kc run` fail with AlreadyExists.
  kc delete pod moca-genkeys -n "$NS" --ignore-not-found --wait=true >/dev/null
  kc run moca-genkeys -n "$NS" --rm -i --quiet --restart=Never --image="$ref" \
    --overrides="$(jq -nc --arg ref "$ref" --argjson sc "$sc" '{spec: {automountServiceAccountToken: false,
      securityContext: $sc, containers: [{name: "moca-genkeys", image: $ref, imagePullPolicy: "IfNotPresent",
      stdin: true, stdinOnce: true,
      workingDir: "/app/packages/control-plane", command: ["node", "--import", "tsx", "src/genkeys.ts"],
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}}}]}}')"
}

GENKEYS_OUT=''
# generated_value KEY REGEX: KEY's value from GENKEYS_OUT if all of it matches REGEX (the regexes are
# deploy/compose/install.sh's); dies otherwise.
generated_value() {
  local v
  v="$(printf '%s\n' "$GENKEYS_OUT" | sed -n "s/^$1=//p" | tail -1)"
  printf '%s\n' "$v" | grep -Eq "^$2\$" || die "the key generator produced no usable $1 (image: $(harness_ref))"
  printf '%s' "$v"
}

ensure_mu1_secret() {
  local json priv pub kek xchg
  json="$(secret_json moca-mu1 "$NS")"
  priv="$(json_value "$json" SH_SESSION_TOKEN_PRIVATE_KEY)"
  pub="$(json_value "$json" SH_SESSION_TOKEN_PUBLIC_KEYS)"
  kek="$(json_value "$json" SH_CREDENTIAL_KEK)"
  xchg="$(json_value "$json" SH_EXCHANGE_TOKEN)"
  json=''
  if { [[ -n "$priv" ]] && [[ -z "$pub" ]]; } || { [[ -z "$priv" ]] && [[ -n "$pub" ]]; }; then
    die 'moca-mu1 holds half a signing keypair (SH_SESSION_TOKEN_PRIVATE_KEY without SH_SESSION_TOKEN_PUBLIC_KEYS, or the reverse): delete both keys and re-run to generate a matching pair'
  fi
  [[ -z "$priv" || -z "$kek" || -z "$xchg" ]] || return 0
  log 'generating the missing MU1 secrets (in the harness image)'
  GENKEYS_OUT="$(genkeys)" || die "could not run the key generator in $(harness_ref)"
  # Every value is extracted and checked BEFORE anything is written, so a garbled generator can
  # never leave half a set (deploy/compose/install.sh's rule).
  if [[ -z "$priv" ]]; then
    priv="$(generated_value SH_SESSION_TOKEN_PRIVATE_KEY '[A-Za-z0-9+/]+=*')"
    pub="$(generated_value SH_SESSION_TOKEN_PUBLIC_KEYS '[0-9a-f]{16}:[A-Za-z0-9+/]+=*')"
  fi
  [[ -n "$kek" ]] || kek="$(generated_value SH_CREDENTIAL_KEK '[A-Za-z0-9+/]{43}=')"
  [[ -n "$xchg" ]] || xchg="$(generated_value SH_EXCHANGE_TOKEN '[0-9a-f]{64}')"
  GENKEYS_OUT=''
  (
    export S_0="$priv" S_1="$pub" S_2="$kek" S_3="$xchg"
    apply_secret moca-mu1 "$NS" SH_SESSION_TOKEN_PRIVATE_KEY SH_SESSION_TOKEN_PUBLIC_KEYS SH_CREDENTIAL_KEK SH_EXCHANGE_TOKEN
  )
}

ensure_secrets() {
  ensure_relay_secrets
  ensure_redis_secret
  ensure_mu1_secret
}

main() {
  parse_args "$@"
  preflight
  ensure_images
  ensure_namespaces
  ensure_secrets
}

[[ "${SH_SOURCE_ONLY:-}" == 1 ]] || main "$@"
