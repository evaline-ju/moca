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
# shellcheck disable=SC2034 # interface global; its first readers arrive in Tasks 13-14 (remove then)
NS=moca
# shellcheck disable=SC2034 # interface global; its first readers arrive in Tasks 13-14 (remove then)
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

main() {
  parse_args "$@"
  preflight
  ensure_images
  ensure_namespaces
}

[[ "${SH_SOURCE_ONLY:-}" == 1 ]] || main "$@"
