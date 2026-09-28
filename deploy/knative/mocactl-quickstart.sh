#!/usr/bin/env bash
# deploy/knative/mocactl-quickstart.sh
# Wire a kind + Knative cluster for mocactl (packages/mocactl/QUICKSTART.md), then hold the two
# port-forwards open so `mocactl` needs exactly one URL.
#
# What it does, each step safe to re-run:
#   1. the three MU1 Secrets -- an EXISTING signing key is reused, never replaced, so tokens
#      already minted and a harness already trusting it keep working;
#   2. the opt-in control plane (control-plane.yaml), with SH_GITHUB_CLIENT_ID and
#      SH_PUBLIC_HARNESS_URL -- the harness as YOUR MACHINE reaches it, which GET /v1/discovery
#      advertises to mocactl;
#   3. the harness Service: publishes the signing key's public half (without it the harness
#      rejects every mocactl turn, since a present-but-unverifiable token fails in either auth
#      mode) and pins min-scale to 1, so scale-to-zero cannot kill the port-forward;
#   4. port-forwards to both, checked end to end, until you press Ctrl+C.
#
# It leaves SH_REQUIRE_AUTH alone: mocactl does not need it, and flipping it would 401 every other
# smoke in this directory while this runs. --teardown undoes 1-3.
#
# Prereqs: a cluster from setup-kind.sh running an image built from a checkout that has
# GET /v1/discovery; a GitHub OAuth app with DEVICE FLOW ENABLED (off by default), its client id
# exported as SH_GITHUB_CLIENT_ID (no client secret is needed); kubectl, jq, curl, openssl.
#
# Usage:
#   SH_GITHUB_CLIENT_ID=Ov23li... bash deploy/knative/mocactl-quickstart.sh
#   bash deploy/knative/mocactl-quickstart.sh --no-forward   # set up, then exit
#   bash deploy/knative/mocactl-quickstart.sh --teardown
# Ports: MOCACTL_CP_PORT (default 18080), MOCACTL_HARNESS_PORT (default 18081).
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"
source ./lib.sh # NS, KSVC, set_ksvc_env

CP_PORT="${MOCACTL_CP_PORT:-18080}"
HARNESS_PORT="${MOCACTL_HARNESS_PORT:-18081}"
CP_URL="http://localhost:${CP_PORT}"
HARNESS_URL="http://localhost:${HARNESS_PORT}"

TEARDOWN=0
FORWARD=1
for a in "$@"; do
  case "$a" in
    --teardown) TEARDOWN=1 ;;
    --no-forward) FORWARD=0 ;;
    -h | --help)
      sed -n '2,29p' "$SELF"
      exit 0
      ;;
    *)
      echo "unknown flag: $a" >&2
      exit 2
      ;;
  esac
done

die() {
  echo "ERROR: $*" >&2
  exit 1
}

for tool in kubectl jq curl openssl; do
  command -v "$tool" >/dev/null || die "$tool is required"
done

TMP="$(mktemp -d)"
PFS=()
cleanup() {
  for pid in ${PFS[@]+"${PFS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# min_scale <n> [stamp]. With a stamp, deploy.sh/build-ts forces a new Revision even when nothing
# else changed, so an image re-loaded under the same tag is actually served (as setup-kind.sh does).
min_scale() {
  local stamp=""
  [ -n "${2:-}" ] && stamp=",\"deploy.sh/build-ts\":\"$2\""
  kubectl patch ksvc "$KSVC" -n "$NS" --type merge -p \
    "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"autoscaling.knative.dev/min-scale\":\"$1\"$stamp}}}}}" \
    >/dev/null
}

if [ "$TEARDOWN" -eq 1 ]; then
  echo "== tearing down"
  set_ksvc_env SH_SESSION_TOKEN_PUBLIC_KEYS- >/dev/null 2>&1 || true
  min_scale 0 2>/dev/null || true
  # control-plane.yaml owns the sh-credentials namespace, so this also deletes every credential
  # stored through the control plane.
  kubectl delete -f control-plane.yaml --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete secret sh-session-token-key sh-credential-kek sh-exchange-token -n "$NS" \
    --ignore-not-found >/dev/null 2>&1 || true
  echo "  done: control plane, its Secrets and stored credentials removed; harness back to min-scale 0"
  exit 0
fi

if [ -z "${SH_GITHUB_CLIENT_ID:-}" ]; then
  echo "ERROR: SH_GITHUB_CLIENT_ID is unset." >&2
  echo "       Register a GitHub OAuth app, tick 'Enable Device Flow', and export its client id" >&2
  echo "       (packages/mocactl/QUICKSTART.md, step 2). No client secret is needed." >&2
  exit 2
fi

# Older LibreSSL (what some macOS versions ship as /usr/bin/openssl) has no ed25519, and deriving an
# EXISTING key's public half needs it too -- so probe before touching the cluster.
openssl genpkey -algorithm ed25519 -out "$TMP/probe.key" >/dev/null 2>&1 && [ -s "$TMP/probe.key" ] ||
  die "this openssl ($(openssl version 2>/dev/null)) cannot make ed25519 keys -- install OpenSSL 3 (brew install openssl@3) and put it first on PATH"
rm -f "$TMP/probe.key"

kubectl get ksvc "$KSVC" -n "$NS" >/dev/null 2>&1 ||
  die "no ksvc/$KSVC in namespace $NS -- is the cluster up? (bash deploy/knative/setup-kind.sh)"

# --- 1. Secrets -----------------------------------------------------------------------------------
echo "== 1/4 secrets"
KEYFILE="$TMP/session.key"
if kubectl get secret sh-session-token-key -n "$NS" >/dev/null 2>&1; then
  echo "  reusing the existing signing key"
  kubectl get secret sh-session-token-key -n "$NS" \
    -o jsonpath='{.data.SH_SESSION_TOKEN_PRIVATE_KEY}' | openssl base64 -d -A >"$KEYFILE"
else
  echo "  creating a signing key"
  openssl genpkey -algorithm ed25519 -out "$KEYFILE" 2>/dev/null
  kubectl create secret generic sh-session-token-key -n "$NS" \
    --from-file=SH_SESSION_TOKEN_PRIVATE_KEY="$KEYFILE" >/dev/null
fi
# Secret values go through files, never argv, so they are not visible in `ps`.
if ! kubectl get secret sh-credential-kek -n "$NS" >/dev/null 2>&1; then
  printf '%s' "$(openssl rand -base64 32)" >"$TMP/kek"
  kubectl create secret generic sh-credential-kek -n "$NS" \
    --from-file=SH_CREDENTIAL_KEK="$TMP/kek" >/dev/null
fi
if ! kubectl get secret sh-exchange-token -n "$NS" >/dev/null 2>&1; then
  printf '%s' "$(openssl rand -hex 32)" >"$TMP/exchange"
  kubectl create secret generic sh-exchange-token -n "$NS" \
    --from-file=SH_EXCHANGE_TOKEN="$TMP/exchange" >/dev/null
fi
# The harness gets only the public half: `<kid>:<base64 DER SPKI>`, kid = first 16 hex of
# sha256(SPKI DER) -- token.ts keyIdFor.
openssl pkey -in "$KEYFILE" -pubout -outform DER -out "$TMP/session.pub" 2>/dev/null
KID="$(openssl dgst -sha256 -hex "$TMP/session.pub" | awk '{print substr($NF,1,16)}')"
PUBKEYS="${KID}:$(openssl base64 -A -in "$TMP/session.pub")"
rm -f "$KEYFILE"

# --- 2. Control plane -----------------------------------------------------------------------------
echo "== 2/4 control plane"
kubectl apply -f control-plane.yaml >/dev/null
kubectl set env deploy/sh-control-plane -n "$NS" \
  "SH_GITHUB_CLIENT_ID=$SH_GITHUB_CLIENT_ID" "SH_PUBLIC_HARNESS_URL=$HARNESS_URL" >/dev/null
# A restart, not only `set env`: an image re-loaded under the same tag rolls nothing by itself.
kubectl rollout restart deploy/sh-control-plane -n "$NS" >/dev/null
kubectl rollout status deploy/sh-control-plane -n "$NS" --timeout=180s >/dev/null ||
  die "the control plane did not become ready: kubectl logs -n $NS deploy/sh-control-plane"

# --- 3. Harness -----------------------------------------------------------------------------------
echo "== 3/4 harness"
set_ksvc_env "SH_SESSION_TOKEN_PUBLIC_KEYS=$PUBKEYS" >/dev/null
min_scale 1 "$(date +%s)"
kubectl wait "ksvc/$KSVC" -n "$NS" --for=condition=Ready --timeout=180s >/dev/null ||
  die "ksvc/$KSVC did not become ready: kubectl get ksvc $KSVC -n $NS"

if [ "$FORWARD" -eq 0 ]; then
  echo "== done (no port-forwards). Forward ${CP_PORT} -> svc/sh-control-plane and ${HARNESS_PORT} -> the harness pod yourself."
  exit 0
fi

# --- 4. Port-forwards -----------------------------------------------------------------------------
echo "== 4/4 port-forwards"
REV="$(kubectl get ksvc "$KSVC" -n "$NS" -o jsonpath='{.status.latestReadyRevisionName}')"
POD="$(kubectl get pod -n "$NS" -l "serving.knative.dev/revision=$REV" \
  --field-selector=status.phase=Running -o name | head -1)"
[ -n "$POD" ] || die "no running pod for revision $REV"
kubectl port-forward -n "$NS" svc/sh-control-plane "${CP_PORT}:8080" >"$TMP/pf-cp.log" 2>&1 &
PFS+=("$!")
# To the pod, not Kourier: Kourier routes on a Host header that mocactl (Node's fetch) cannot set.
kubectl port-forward -n "$NS" "$POD" "${HARNESS_PORT}:8080" >"$TMP/pf-h.log" 2>&1 &
PFS+=("$!")

# End to end, through the forwards: discovery must advertise the forwarded harness, and it must answer.
discovered=""
for _ in $(seq 1 20); do
  discovered="$(curl -s --max-time 2 "$CP_URL/v1/discovery" 2>/dev/null | jq -r '.harnessUrl // empty' 2>/dev/null || true)"
  [ -n "$discovered" ] && break
  sleep 1
done
if [ -z "$discovered" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$CP_URL/v1/discovery" 2>/dev/null || true)"
  [ "$code" = 404 ] &&
    die "the control plane has no /v1/discovery: its image predates it -- rebuild and kind-load the image (QUICKSTART.md, step 1)"
  die "cannot reach the control plane at $CP_URL (is port ${CP_PORT} free?) -- $(tail -1 "$TMP/pf-cp.log" 2>/dev/null)"
fi
[ "$discovered" = "$HARNESS_URL" ] ||
  die "the control plane advertises $discovered, expected $HARNESS_URL"
curl -sf --max-time 5 "$HARNESS_URL/health" >/dev/null 2>&1 ||
  die "cannot reach the harness at $HARNESS_URL (is port ${HARNESS_PORT} free?) -- $(tail -1 "$TMP/pf-h.log" 2>/dev/null)"

cat <<EOF

Ready. In another terminal:

  export SH_CONTROL_PLANE_URL=$CP_URL
  mocactl login      # approve the code on github.com
  mocactl            # add an inference credential, then chat
  mocactl doctor     # 7 checks, one fix per failure

Keep this running; Ctrl+C stops the port-forwards. Undo everything with --teardown.
EOF
# Until either forward dies (e.g. the pod was replaced). A poll, not `wait -n`: macOS's /bin/bash
# is 3.2, which has no `wait -n`.
while kill -0 "${PFS[0]}" 2>/dev/null && kill -0 "${PFS[1]}" 2>/dev/null; do sleep 2; done
echo "a port-forward stopped; re-run this script to reconnect" >&2
exit 1
