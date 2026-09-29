#!/usr/bin/env bash
# deploy/knative/tests/demo-remote-worker-tokens.test.sh
#
# demo-remote-worker.sh may bind the relay's port to 0.0.0.0 (native Linux Docker), so both relay
# credentials must be per-run values, never the repo's public dev values: the sandbox token that
# admits an Attach, and the exec token that admits a SandboxExec (MI1 R5). The relay it patches
# must receive the exec token, and the WARN it prints must describe both.
#
# Static checks against the real script (comment lines stripped). No cluster required.
# Run: bash deploy/knative/tests/demo-remote-worker-tokens.test.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/demo-remote-worker.sh"
CODE="$(grep -v '^[[:space:]]*#' "$SCRIPT")"
FAILS=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  FAILS=$((FAILS + 1))
fi; }

echo "== per-run relay credentials"
check "no code line defaults the exec token to the public dev-exec-token" \
  "$(printf '%s\n' "$CODE" | grep -cE '(:-|=)"?dev-exec-token')" "0"
check "an unset exec token is generated for this run" \
  "$(printf '%s\n' "$CODE" | grep -c 'MOCA_RELAY_EXEC_TOKEN="$(gen_relay_token)"')" "1"
check "the relay is patched with the exec token, alongside the sandbox token" \
  "$(printf '%s\n' "$CODE" | grep -F 'kubectl set env deploy/sandbox-relay' | grep -c 'MOCA_RELAY_EXEC_TOKEN=$MOCA_RELAY_EXEC_TOKEN')" "1"
check "the harness is given the same exec token" \
  "$(printf '%s\n' "$CODE" | grep -c 'MOCA_RELAY_EXEC_TOKEN="$MOCA_RELAY_EXEC_TOKEN"')" "1"

echo "== the 0.0.0.0 WARN describes SandboxExec too"
warn="$(printf '%s\n' "$CODE" | grep -A6 'WARN: the relay port is bound to 0.0.0.0')"
check "the WARN names SandboxExec and the exec token" \
  "$(printf '%s\n' "$warn" | grep -c 'SandboxExec')" "1"
check "the WARN no longer claims only an Attach credential guards the port" \
  "$(printf '%s\n' "$warn" | grep -c 'cannot Attach as a sandbox with a credential read from the repo')" "0"

echo
echo "Total failures: $FAILS"
exit "$FAILS"
