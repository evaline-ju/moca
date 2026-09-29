#!/usr/bin/env bash
# Run the remote worker on THIS laptop, connected to the harness in ykt1.
#
# It (1) sets the relay token, (2) enables the remote-sandbox path on the harness,
# (3) port-forwards the relay to localhost, then (4) runs the worker dialing the
# tunnel. The worker dials OUT, so no inbound route to the laptop is needed —
# harness->relay execs ride back down the worker's Attach stream.
#
# Prereqs: `oc` logged in to ykt1 (export KUBECONFIG=.kube/config-ykt1), Go 1.25+, jq,
# and the harness + relay already deployed (setup-ocp.sh, which creates the sh-relay-token
# Secret holding MOCA_RELAY_EXEC_TOKEN).
set -euo pipefail

NS="${NS:-default}"
SANDBOX_ID="${SANDBOX_ID:-sbx-laptop-1}"
TOKEN="${SANDBOX_TOKEN:-dev-token}"
PORT="${RELAY_PORT:-8443}"

echo "1) relay token (fail-closed auth)"
oc set env deploy/sandbox-relay "SH_RELAY_TOKEN=${TOKEN}" -n "$NS"

echo "2) enable remote-sandbox path on the harness (rolls a new ksvc revision)"
# `oc set env` does not work on a Knative Service, so upsert the three entries by name and
# replace the env array in one JSON patch, passing every other entry (the ANTHROPIC_*
# secretKeyRefs) through whole. The harness presents MOCA_RELAY_EXEC_TOKEN on every SandboxExec
# (MI1 R5) and reads it by a secretKeyRef to that ONE key: sh-relay-token's SH_RELAY_TOKEN is the
# sandboxes' credential and never reaches the harness.
harness_env="$(oc get ksvc serverless-harness -n "$NS" -o json | jq -c \
  --arg addr "sandbox-relay.${NS}.svc:8443" '
  (.spec.template.spec.containers[0].env // [])
  | map(select(.name | IN("SH_REMOTE_SANDBOX", "SH_RELAY_ADDR", "MOCA_RELAY_EXEC_TOKEN") | not))
  + [{name: "SH_REMOTE_SANDBOX", value: "1"},
     {name: "SH_RELAY_ADDR", value: $addr},
     {name: "MOCA_RELAY_EXEC_TOKEN",
      valueFrom: {secretKeyRef: {name: "sh-relay-token", key: "MOCA_RELAY_EXEC_TOKEN"}}}]')"
oc patch ksvc serverless-harness -n "$NS" --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/env\",\"value\":${harness_env}}]"

echo "3) port-forward relay -> localhost:${PORT}"
oc port-forward "svc/sandbox-relay" "${PORT}:8443" -n "$NS" &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
# wait for the tunnel (bash /dev/tcp probe)
until (exec 3<>"/dev/tcp/localhost/${PORT}") 2>/dev/null; do sleep 0.3; done
exec 3>&- 2>/dev/null || true

echo "4) run worker (sandbox_id=${SANDBOX_ID}); Ctrl+C to stop"
cd "$(dirname "$0")"
RELAY_ADDR="localhost:${PORT}" SANDBOX_ID="${SANDBOX_ID}" SANDBOX_TOKEN="${TOKEN}" \
  go run ./cmd/worker
