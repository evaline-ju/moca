#!/usr/bin/env bash
# deploy/knative/demo-remote-worker.sh
# Laptop showcase: a sandbox OUTSIDE the cluster, with zero inbound rules, executing a
# leaf's tool calls.
#
#   laptop
#   |- kind cluster:  Knative + Redis + harness (ksvc) + sandbox-relay
#   \- docker run:    remote-worker  --dials out-->  relay
#
# The worker runs as a plain `docker run` on the host, NOT as a pod. That is the whole
# point: it is outside the cluster, it publishes no ports, and it reaches the relay by
# dialing *out* through a port-forward. A worker deployed as a pod (worker-example.yaml,
# and the relay-leaf-smoke.sh gate) demonstrates the plumbing but not the driver.
#
# What it proves, and why a single green run would not: the harness's select-sandbox.ts
# builds candidates = [...pods, ...grpcRecs] and leases least-loaded-first, so merely
# enabling SH_REMOTE_SANDBOX=1 does NOT route to the worker -- an idle in-cluster sandbox
# pod can still win, and the demo would "pass" having proven nothing. Two defenses:
#
#   1. Before the remote runs, assert the pool selector matches ZERO Running pods, so the
#      worker is the only candidate there is (structural, not merely detected).
#   2. Fingerprint the OS the exec actually ran on. The in-cluster pool is Alpine, the
#      worker image is RHEL, so a leaf grepping /etc/os-release for "Alpine" flips verdict
#      with the backend -- and the model names the OS it read in its own reason.
#
#        | backend            | pattern "Alpine" | model's stated reason        |
#        |--------------------|------------------|------------------------------|
#        | in-cluster pod     | FLAGGED          | "...running Alpine Linux"    |
#        | remote host worker | CLEAR            | "...Red Hat Enterprise Linux"|
#
# Usage:
#   ./demo-remote-worker.sh                  # no cluster -> passing A/B, one invocation
#   ./demo-remote-worker.sh --reuse-cluster   # skip setup if the cluster is already healthy
#   ./demo-remote-worker.sh --keep            # leave relay + worker running afterwards
#   ./demo-remote-worker.sh --teardown        # remove container, relay, image; ASK about the cluster
#   ./demo-remote-worker.sh --teardown --yes  # ...and delete the cluster without asking
#
# Requires: docker (or podman), kind, kubectl, jq -- and credentials for a model the
# cluster can reach (ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL).
# No local Go toolchain: remote-worker/Dockerfile builds the binary in a builder stage.
set -euo pipefail
# Resolve this script's own path BEFORE the cd below. --help reads the header block out of
# the file, and after the cd a relative "$0" no longer resolves -- which is how the demo is
# actually invoked (`make demo-remote-sandbox` runs `bash deploy/knative/demo-remote-worker.sh`).
# The user-facing hints below keep using "$0": those are copy-pasted from the caller's own
# cwd, which is the one "$0" was relative to.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"
source ./lib.sh   # NS, KSVC, BASE, CURL_OPTS, CURL_HDR, ok/ko, PASS/FAIL, ensure_port_forward
# shellcheck source=./lib-relay.sh
source ./lib-relay.sh  # MODEL, claim/abort, dispatch_prompt, assert_reply_contains/_lacks,
                       # reply_text, validate_discriminator, assert_presence(_gone),
                       # assert_no_pods_match, snapshot/flip/restore_harness_env.
                       # Shared with relay-leaf-smoke.sh (which keeps the verdict pair).

REPO_ROOT="$(cd ../.. && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-sh-knative}"
WORKER_IMAGE="${WORKER_IMAGE:-dev.local/remote-worker:demo}"
WORKER_CTR="${WORKER_CTR:-sh-demo-remote-worker}"
RELAY_PORT="${RELAY_PORT:-8443}"
SANDBOX_ID="${SANDBOX_ID:-sbx-laptop-demo}"
# Must equal the relay's SH_RELAY_TOKEN. Auth is fail-closed: a mismatch rejects the Attach
# before the stream is ever parked. Left EMPTY here on purpose -- a per-run random token is
# generated in step 4 and patched onto the relay, rather than reusing relay-deployment.yaml's
# hardcoded `dev-token`. That value is a repo constant and therefore public, which matters
# because step 5 may bind the relay port to 0.0.0.0 on native Linux Docker: a LAN-reachable
# port plus a well-known credential would let anyone on the network Attach as a sandbox and
# receive the leaf's exec payloads. Set SANDBOX_TOKEN to pin a value instead.
RELAY_TOKEN="${SANDBOX_TOKEN:-}"
# The harness's credential for the relay's SandboxExec (MI1 R5); the relay refuses to boot without
# it. Left EMPTY here for the same reason as RELAY_TOKEN: step 4 generates a per-run value and
# patches it onto the relay, rather than keeping relay-deployment.yaml's public dev value on a port
# step 5 may bind to 0.0.0.0. Set MOCA_RELAY_EXEC_TOKEN to pin a value instead.
MOCA_RELAY_EXEC_TOKEN="${MOCA_RELAY_EXEC_TOKEN:-}"
# The harness reaches the relay by in-cluster DNS; the worker reaches it through the
# tunnel. That asymmetry IS the inverted-connectivity story -- neither address is inbound
# to the laptop.
IN_CLUSTER_RELAY_ADDR="sandbox-relay.${NS}.svc:8443"
# A label no pod carries, so the remote worker is the only lease candidate (defense 1).
REMOTE_ONLY_SELECTOR="sh.kagenti.io/sandbox-pool=demo-remote-only"
# The free-form ask, identical for both backends -- the reply NAMES the OS it read, so which
# filesystem answered is stated by the model rather than inferred from a flag. "read tool" and
# the absolute path are load-bearing: the tools run in the sandbox, and a relative path would be
# resolved against the harness process cwd instead (cf. buildLeafPrompt in harness/src/run-leaf.ts).
OS_PROMPT="Using your read tool, read the file /etc/os-release and tell me in one sentence exactly which OS distribution and version it reports."
PF_LOG="${TMPDIR:-/tmp}/sh-demo-relay-pf.$$.log"

REUSE_CLUSTER=0
KEEP=0
TEARDOWN_ONLY=0
ASSUME_YES=0
# Raised only on the path that actually creates the cluster (step 2). --reuse-cluster exists
# so the demo can run against a long-lived dev cluster, so "the cluster exists" must never be
# read as "this run may delete it".
CREATED_CLUSTER=0
PF_PID=""
KOURIER_PF_PID=""
WORKER_DOCKER_ARGS=()
PF_ADDRESS_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --reuse-cluster) REUSE_CLUSTER=1; shift ;;
    --keep) KEEP=1; shift ;;
    --teardown) TEARDOWN_ONLY=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    # Print the header block only: from line 2 (skipping the shebang) to the first
    # non-comment line. `grep '^#'` would also emit every column-0 comment further down --
    # section headers and function docs -- which is internal commentary, not help.
    -h|--help) sed -n '2,/^[^#]/{/^#/s/^# \{0,1\}//p;}' "$SELF"; exit 0 ;;
    *) echo "unknown arg: $1 (try --help)" >&2; exit 1 ;;
  esac
done

# Demo narration: what the step just established, in prose. Distinct from ok/ko, which
# are the machine-checked assertions.
note() { echo "    -> $1"; }

stop_port_forward() {
  [ -n "$PF_PID" ] || return 0
  kill "$PF_PID" 2>/dev/null || true
  wait "$PF_PID" 2>/dev/null || true
  PF_PID=""
}

# Only stops a kourier tunnel THIS script started -- ensure_port_forward echoes nothing when
# one was already up, and tearing down someone else's would break a concurrent session.
stop_kourier_port_forward() {
  [ -n "$KOURIER_PF_PID" ] || return 0
  kill "$KOURIER_PF_PID" 2>/dev/null || true
  wait "$KOURIER_PF_PID" 2>/dev/null || true
  KOURIER_PF_PID=""
}

# Is the harness itself answering? Distinguished from "the model is unreachable", which is
# what an empty /runs response would otherwise be blamed on -- they look identical at the
# verdict layer and have completely different fixes. Any HTTP response counts (even a 404):
# this is a transport check, not a health check.
wait_harness_reachable() {
  local i
  for ((i = 0; i < 20; i++)); do
    # shellcheck disable=SC2086  # CURL_OPTS is intentionally word-split
    if curl -s $CURL_OPTS -o /dev/null --max-time 5 ${CURL_HDR[@]+"${CURL_HDR[@]}"} "$BASE/" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# A fresh credential per run, so the token in `docker inspect` is scoped to this one demo
# rather than being a constant checked into the repo. `head -c` leads the pipeline so no
# stage is killed by SIGPIPE (which pipefail would surface as a failure).
gen_relay_token() {
  local t
  t="$(openssl rand -hex 16 2>/dev/null || true)"
  [ -n "$t" ] || t="$(head -c 16 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"
  [ -n "$t" ] || abort "could not generate a random relay token (no openssl, and /dev/urandom is not readable). Set SANDBOX_TOKEN to supply one."
  printf '%s' "$t"
}

remove_worker_container() {
  docker rm -f "$WORKER_CTR" >/dev/null 2>&1 || true
}

remove_relay() {
  kubectl delete -f relay-deployment.yaml --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true
}

# --teardown runs as its own process, so it cannot know whether some earlier invocation
# created $CLUSTER_NAME or whether it is the dev cluster --reuse-cluster was pointed at.
# Deleting it unconditionally would make a cleanup command destructive to something the demo
# never owned, so ask. --yes is the non-interactive answer; with no tty and no --yes, keep the
# cluster -- refusing to delete is the recoverable direction.
confirm_cluster_delete() {
  [ "$ASSUME_YES" = 1 ] && return 0
  if [ ! -t 0 ]; then
    echo "    stdin is not a terminal, so cluster '$CLUSTER_NAME' is being KEPT." >&2
    echo "    re-run with --yes to delete it, or: kind delete cluster --name $CLUSTER_NAME" >&2
    return 1
  fi
  local reply=""
  printf "    delete kind cluster '%s'? Irreversible, and the demo may not have created it. [y/N] " "$CLUSTER_NAME"
  read -r reply || true
  case "$reply" in [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# Full teardown: everything this demo can create, in dependency order. Idempotent, so
# `--teardown` is safe to run against a half-finished or already-clean laptop. The cluster is
# the one exception to "remove everything" -- see confirm_cluster_delete.
full_teardown() {
  echo "=== Teardown ==="
  echo "--- stopping the tunnel ---";      stop_port_forward
  echo "--- removing the worker container ---"; remove_worker_container
  if kubectl cluster-info >/dev/null 2>&1; then
    echo "--- restoring harness env ---";  restore_harness_env
    echo "--- removing the relay ---";     remove_relay
  fi
  local cluster_removed=0
  if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    echo "--- kind cluster '$CLUSTER_NAME' ---"
    if confirm_cluster_delete; then
      kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
      cluster_removed=1
      echo "    deleted."
    else
      echo "    kept."
    fi
  fi
  echo "--- removing the built worker image ---"
  docker rmi "$WORKER_IMAGE" >/dev/null 2>&1 || true
  rm -f "$PF_LOG" 2>/dev/null || true
  if [ "$cluster_removed" = 1 ]; then
    echo "teardown complete: no cluster, container, or built image left behind"
  else
    echo "teardown complete: container, relay and built image removed; cluster '$CLUSTER_NAME' left running"
  fi
}

# EXIT trap. Restoring the harness env is the non-negotiable part: leaving it pointed at a
# selector matching nothing would break every later leaf run on this cluster.
cleanup() {
  echo ""
  if [ "$KEEP" = 1 ]; then
    echo "--- Cleanup (--keep): restoring harness env, leaving relay + worker up ---"
    restore_harness_env
    stop_port_forward
    stop_kourier_port_forward
    echo "worker container '$WORKER_CTR' and the relay are still running."
    echo "NOTE: the tunnel is down, so the worker's Attach stream is now closed. Restart it with:"
    echo "  kubectl port-forward -n $NS svc/sandbox-relay ${RELAY_PORT}:8443"
  else
    echo "--- Cleanup: restoring harness env, removing relay + worker ---"
    restore_harness_env
    stop_port_forward
    remove_worker_container
    remove_relay
    stop_kourier_port_forward
    if [ "$CREATED_CLUSTER" = 1 ]; then
      echo "cluster '$CLUSTER_NAME' left running (this run created it). Remove everything with:"
      echo "  $0 --teardown"
    else
      # Never advertise --teardown as "remove everything" for a cluster that predates this
      # run: a reader who reached teardown by following this hint has not re-read the README.
      echo "cluster '$CLUSTER_NAME' predates this run and is untouched. Nothing else to clean up:"
      echo "the relay, worker container and tunnel are already gone."
      echo "('$0 --teardown' would offer to delete the cluster itself; it asks first.)"
    fi
  fi
  rm -f "$PF_LOG" 2>/dev/null || true
}

if [ "$TEARDOWN_ONLY" = 1 ]; then
  full_teardown
  exit 0
fi

# Echo the value of one env var on the harness ksvc (empty when unset).
ksvc_env_value() {
  kubectl get ksvc "$KSVC" -n "$NS" -o json 2>/dev/null \
    | jq -r --arg n "$1" '.spec.template.spec.containers[0].env[]? | select(.name==$n) | .value // empty' 2>/dev/null || true
}

# Start (or restart) the relay tunnel and wait for the local listener.
start_relay_port_forward() {
  stop_port_forward
  kubectl port-forward ${PF_ADDRESS_ARGS[@]+"${PF_ADDRESS_ARGS[@]}"} \
    -n "$NS" svc/sandbox-relay "${RELAY_PORT}:8443" >"$PF_LOG" 2>&1 &
  PF_PID=$!
  local i
  for ((i = 0; i < 40; i++)); do
    if (exec 3<>"/dev/tcp/127.0.0.1/${RELAY_PORT}") 2>/dev/null; then return 0; fi
    sleep 0.25
  done
  return 1
}

# Does a connection actually TRAVERSE the tunnel to a serving relay? A plain TCP connect to
# the forwarded port is not enough: kubectl accepts the local connection first and only then
# tries the pod, so a dead relay still yields a successful connect and a forwarding error
# logged afterwards. Checking the log is what distinguishes "relay is dead" from "the
# container cannot route here" -- two failures with completely different fixes.
relay_reachable_from_host() {
  local before after
  # Only errors logged by THIS probe count. Truncating the log would corrupt it (kubectl
  # holds the fd and keeps writing at its old offset), so window it by line count instead.
  before="$(wc -l < "$PF_LOG" 2>/dev/null || echo 0)"
  (exec 3<>"/dev/tcp/127.0.0.1/${RELAY_PORT}") 2>/dev/null || return 1
  sleep 1
  after="$(tail -n "+$((before + 1))" "$PF_LOG" 2>/dev/null || true)"
  ! grep -qE "error forwarding|connection refused|lost connection" <<<"$after"
}

# Wait for the relay to actually serve. `rollout status` returns as soon as the pod is
# Running, but the entrypoint compiles the relay's TypeScript through tsx first -- measured
# ~4s between Running and the port being bound. Probing immediately is a race, and losing it
# looks exactly like a broken relay. A failed forward also kills kubectl port-forward
# outright ("lost connection to pod"), so restart the tunnel when it has died.
wait_relay_reachable_from_host() {
  local attempts="${1:-30}" i
  for ((i = 0; i < attempts; i++)); do
    if [ -z "$PF_PID" ] || ! kill -0 "$PF_PID" 2>/dev/null; then
      start_relay_port_forward || { sleep 2; continue; }
    fi
    if relay_reachable_from_host; then return 0; fi
    sleep 2
  done
  return 1
}

# Can a container reach the tunnel? Probed with the worker's own image and network config,
# via bash's /dev/tcp -- so this tests exactly what the worker will do, and needs no extra
# image pulled just to hold a netcat.
probe_from_container() {
  docker run --rm --entrypoint bash "$@" "$WORKER_IMAGE" \
    -c "exec 3<>/dev/tcp/host.docker.internal/${RELAY_PORT}" >/dev/null 2>&1
}

echo "=== Remote-sandbox laptop demo (sandbox=$SANDBOX_ID, model=$MODEL) ==="
echo "Proving: a sandbox outside the cluster, with zero inbound rules, runs a leaf's tools."

# --- 1. Preflight ----------------------------------------------------------------------
claim "Preflight: tools present"
for tool in docker kind kubectl jq; do
  command -v "$tool" >/dev/null 2>&1 || abort "$tool not found (needed for this demo)"
done
note "docker, kind, kubectl, jq found. No Go toolchain needed -- the worker's Dockerfile"
note "builds the binary in a golang builder stage."

# --- 2. Cluster ------------------------------------------------------------------------
claim "Cluster: Knative + Redis + harness + Alpine sandbox pool"
cluster_healthy() {
  kubectl cluster-info >/dev/null 2>&1 \
    && kubectl get ksvc "$KSVC" -n "$NS" >/dev/null 2>&1 \
    && kubectl get deploy redis -n "$NS" >/dev/null 2>&1
}
if [ "$REUSE_CLUSTER" = 1 ] && kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$" \
   && kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null 2>&1 && cluster_healthy; then
  note "reusing healthy cluster '$CLUSTER_NAME' (--reuse-cluster)"
else
  # Check for the cluster BEFORE setup-kind.sh runs: it reuses an existing cluster rather than
  # recreating it, so afterwards "the cluster exists" says nothing about who made it.
  if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    note "cluster '$CLUSTER_NAME' already exists; setup-kind.sh will reuse it, and teardown will not offer to delete it as this run's own"
  else
    CREATED_CLUSTER=1
  fi
  note "running setup-kind.sh (creates the cluster if absent; several minutes on a cold start)"
  CLUSTER_NAME="$CLUSTER_NAME" ./setup-kind.sh \
    || abort "setup-kind.sh failed -- see its output above (a missing ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is the usual cause)"
fi
cluster_healthy || abort "cluster '$CLUSTER_NAME' is not serving the harness (ksvc/$KSVC or deploy/redis missing)"

POOL_SELECTOR="$(resolve_pool_selector)"
# `|| true` so a failed query surfaces as the named abort below rather than as a bare
# set -e exit with no explanation of what went wrong.
POOL_POD_COUNT="$(count_pool_pods "$POOL_SELECTOR" || true)"
[ "$POOL_POD_COUNT" = "ERR" ] \
  && abort "could not query Running pods for pool selector '$POOL_SELECTOR' (kubectl failed -- wrong context, API error, or missing RBAC)"
[ "${POOL_POD_COUNT:-0}" -ge 1 ] \
  || abort "no Running sandbox pods match pool selector '$POOL_SELECTOR' -- the pod side of the A/B needs at least one"
SBOX_POD="$(first_pool_pod "$POOL_SELECTOR")"
note "harness ksvc ready; $POOL_POD_COUNT in-cluster sandbox pod(s) match '$POOL_SELECTOR' (sample: $SBOX_POD)"

trap cleanup EXIT

# The leaf requests below reach the harness over a kourier port-forward with a Host header
# (see lib.sh). Verify it answers now: every dispatch would otherwise return an empty body,
# which is indistinguishable from an unreachable model at the verdict layer.
claim "Harness endpoint: reachable"
KOURIER_PF_PID="$(ensure_port_forward || true)"
wait_harness_reachable \
  || abort "the harness is not answering on $BASE. A kourier port-forward is needed: kubectl port-forward -n kourier-system svc/kourier ${PORT}:80"
ok "harness answers on $BASE"

# --- 3. Worker image -------------------------------------------------------------------
claim "Worker image: built locally, for the HOST -- not loaded into kind"
docker build --load -f "$REPO_ROOT/remote-worker/Dockerfile" -t "$WORKER_IMAGE" "$REPO_ROOT" \
  >"${TMPDIR:-/tmp}/sh-demo-worker-build.log" 2>&1 \
  || abort "docker build of $WORKER_IMAGE failed (see ${TMPDIR:-/tmp}/sh-demo-worker-build.log)"
note "built $WORKER_IMAGE at host architecture."
note "No 'kind load' and no arch-matching with the kind node: this image never enters the"
note "cluster. It runs as a host container, which is the point of the whole demo."

# --- 4. Relay --------------------------------------------------------------------------
claim "Relay: the only thing the worker will dial"
kubectl apply -f relay-deployment.yaml >/dev/null || abort "kubectl apply relay-deployment.yaml failed"
if [ -n "$RELAY_TOKEN" ]; then
  note "using the SANDBOX_TOKEN supplied in the environment."
else
  RELAY_TOKEN="$(gen_relay_token)"
  note "generated a random relay token for this run only (not relay-deployment.yaml's public 'dev-token')."
fi
if [ -z "$MOCA_RELAY_EXEC_TOKEN" ]; then
  MOCA_RELAY_EXEC_TOKEN="$(gen_relay_token)"
  note "generated a random exec token for this run only (not relay-deployment.yaml's public 'dev-exec-token')."
fi
# Patch the live Deployment BEFORE waiting on the rollout, so the pod that becomes Ready is
# already the one holding this run's token -- setting it afterwards would restart the relay
# out from under the readiness we just established. A later `kubectl apply -f
# relay-deployment.yaml` (relay-leaf-smoke.sh does exactly that) reverts it to the declared
# dev value, so this leaves nothing behind for other callers.
kubectl set env deploy/sandbox-relay -n "$NS" "SH_RELAY_TOKEN=$RELAY_TOKEN" "MOCA_RELAY_EXEC_TOKEN=$MOCA_RELAY_EXEC_TOKEN" >/dev/null \
  || abort "could not set SH_RELAY_TOKEN and MOCA_RELAY_EXEC_TOKEN on deploy/sandbox-relay"
kubectl -n "$NS" rollout status deploy/sandbox-relay --timeout=90s >/dev/null \
  || abort "sandbox-relay rollout did not become ready"
note "relay up. It is inert until a worker attaches AND the harness is on SH_REMOTE_SANDBOX=1."

# --- 5. Tunnel -------------------------------------------------------------------------
claim "Tunnel: relay -> host, proven reachable from inside a container"
start_relay_port_forward || abort "kubectl port-forward svc/sandbox-relay did not start (see $PF_LOG)"
# Prove the relay is genuinely serving BEFORE testing container networking, so a dead relay
# is never misreported as a networking problem.
wait_relay_reachable_from_host 30 \
  || diagnose_relay_crash "the tunnel is up but nothing answered on the relay's :8443 within 60s"
ok "relay answers through the tunnel from the host"
if probe_from_container; then
  note "host.docker.internal reaches the default 127.0.0.1 port-forward bind (Docker Desktop"
  note "or a podman machine). Nothing is exposed beyond the host."
elif probe_from_container --add-host=host.docker.internal:host-gateway; then
  WORKER_DOCKER_ARGS+=(--add-host=host.docker.internal:host-gateway)
  note "reachable via an explicit --add-host=host.docker.internal:host-gateway mapping."
else
  # Native Linux Docker: host-gateway is the bridge IP, which a loopback-only
  # port-forward does not answer on. Widen the bind, and say so -- for the demo's
  # duration the relay port is reachable from the local network.
  PF_ADDRESS_ARGS=(--address 0.0.0.0)
  note "loopback bind unreachable from a container; retrying with --address 0.0.0.0"
  start_relay_port_forward || abort "kubectl port-forward --address 0.0.0.0 did not start (see $PF_LOG)"
  if probe_from_container --add-host=host.docker.internal:host-gateway; then
    WORKER_DOCKER_ARGS+=(--add-host=host.docker.internal:host-gateway)
    echo "    WARN: the relay port is bound to 0.0.0.0 for the duration of this demo, so it is"
    echo "          reachable from your local network. An Attach needs this run's sandbox token and"
    echo "          a SandboxExec this run's exec token -- both generated per run unless you set"
    echo "          SANDBOX_TOKEN / MOCA_RELAY_EXEC_TOKEN, and neither is relay-deployment.yaml's"
    echo "          public dev value. It is torn down on exit."
  else
    abort "the relay answers from the host, but no container could reach it on port $RELAY_PORT -- this is container-to-host networking, not the relay. Alternative: attach the worker to kind's docker network and dial the node directly (see README-worker.md)."
  fi
fi

# --- 6. Worker -------------------------------------------------------------------------
claim "Worker: a host container with NO published ports"
remove_worker_container
WORKER_RUN=(docker run -d --name "$WORKER_CTR"
  ${WORKER_DOCKER_ARGS[@]+"${WORKER_DOCKER_ARGS[@]}"}
  -e "SANDBOX_ID=$SANDBOX_ID"
  -e "RELAY_ADDR=host.docker.internal:${RELAY_PORT}"
  -e "SANDBOX_TOKEN=$RELAY_TOKEN"
  "$WORKER_IMAGE")
echo "    \$ ${WORKER_RUN[*]}"
"${WORKER_RUN[@]}" >/dev/null || abort "docker run of the worker container failed"
note "Note what is absent: no -p, no --publish, no inbound rule. The worker dials OUT."
note "Its whole credential set is a bearer token, scoped to this run -- no LLM key, no kubeconfig."

# --- 7. Presence -----------------------------------------------------------------------
claim "Presence: the worker's live Attach stream IS its registration"
assert_presence "$SANDBOX_ID" || abort "worker never registered -- check 'docker logs $WORKER_CTR' (a token mismatch with the relay's SH_RELAY_TOKEN is rejected fail-closed)"
note "Redis holds a record only while the stream is open; nothing polls, nothing heartbeats a URL."

# --- 8. Discriminator ------------------------------------------------------------------
claim "Discriminator: verify Alpine vs RHEL BEFORE relying on it"
POD_OS="$(kubectl exec "$SBOX_POD" -n "$NS" -- cat /etc/os-release 2>/dev/null || true)"
WORKER_OS="$(docker exec "$WORKER_CTR" cat /etc/os-release 2>/dev/null || true)"
validate_discriminator "$POD_OS" "$WORKER_OS" "$SBOX_POD" "$WORKER_CTR (host container)"
note "Now a free-form prompt asking what /etc/os-release says identifies which filesystem answered."

# --- 9. Run A: the pod path ------------------------------------------------------------
claim "Run A -- in-cluster Alpine sandbox pod"
[ "$(ksvc_env_value SH_REMOTE_SANDBOX)" = "1" ] \
  && abort "the harness is already on SH_REMOTE_SANDBOX=1, so run A would not be the pod path. Run '$0 --teardown' first, or restore the ksvc env by hand."
snapshot_harness_env
RESP_A="$(dispatch_prompt "demo-pod-$$" "$OS_PROMPT")"
assert_reply_contains "A/pod-path" "$RESP_A" "Alpine" \
  "the in-cluster pool is Alpine, so the reply must name Alpine here; an empty reply usually means the model endpoint is unreachable"
assert_reply_lacks "A/pod-path" "$RESP_A" "Red Hat" \
  "naming Red Hat here means the exec already went remote, so run A is not the pod baseline it claims to be"
TEXT_A="$(reply_text "$RESP_A")"
[ -n "$TEXT_A" ] && note "model's reply: $TEXT_A"

# --- 10. Flip --------------------------------------------------------------------------
claim "Flip to the remote path (and make a pod win IMPOSSIBLE)"
assert_no_pods_match "$REMOTE_ONLY_SELECTOR"
note "This is the trap the issue warns about: SH_REMOTE_SANDBOX=1 alone would leave idle pods"
note "in the candidate set, and a pod could win the lease -- proving nothing while looking green."
flip_harness_env SH_REMOTE_SANDBOX=1 SH_RELAY_ADDR="$IN_CLUSTER_RELAY_ADDR" \
  KAGENTI_SANDBOX_POOL_SELECTOR="$REMOTE_ONLY_SELECTOR" MOCA_RELAY_EXEC_TOKEN="$MOCA_RELAY_EXEC_TOKEN"
wait_latest_ready 150 || abort "harness did not reach a ready latest revision after the flip"
note "harness -> relay via $IN_CLUSTER_RELAY_ADDR (in-cluster DNS);"
note "worker -> relay via host.docker.internal:${RELAY_PORT} (outbound through the tunnel)."

# --- 11. Run B: the remote path --------------------------------------------------------
claim "Run B -- remote host container (both directions asserted)"
RESP_B="$(dispatch_prompt "demo-remote-$$" "$OS_PROMPT")"
assert_reply_contains "B/remote" "$RESP_B" "Red Hat" \
  "the reply must name Red Hat: anything else means the exec landed on an Alpine sandbox pod, not the remote RHEL worker -- the demo would be proving nothing"
assert_reply_lacks "B/remote" "$RESP_B" "Alpine" \
  "naming Alpine means the exec landed on an in-cluster pod despite the remote-only selector"
TEXT_B="$(reply_text "$RESP_B")"
[ -n "$TEXT_B" ] && note "model's reply: $TEXT_B"
note "Asserted both ways: a pod-landed exec fails one check or the other, never neither."

# --- 12. Planted marker: evidence that exists ONLY on this laptop ----------------------
# The strongest assertion in the demo, and the one a free-form reply carries best: /etc/os-release
# can be argued with (image drift, a cached answer, a model that guesses "Red Hat" from context),
# but a random string written seconds ago into a container the cluster cannot reach cannot be.
claim "Planted marker -- the cluster reads a secret created on this laptop"
MARK="tuscan-lentils-$RANDOM-$$"
docker exec "$WORKER_CTR" sh -c "echo 'secret marker: $MARK' > /tmp/proof.txt" \
  || abort "could not write the marker into $WORKER_CTR"
# Fail closed: if the pod DOES have the file, the discriminator is void and the next assertion
# would pass for the wrong reason.
if kubectl exec "$SBOX_POD" -n "$NS" -- cat /tmp/proof.txt >/dev/null 2>&1; then
  abort "/tmp/proof.txt unexpectedly exists on $SBOX_POD -- the marker no longer distinguishes the two filesystems"
fi
ok "marker exists only in $WORKER_CTR on this host; $SBOX_POD has no /tmp/proof.txt"
RESP_C="$(dispatch_prompt "demo-proof-$$" "Using your read tool, read the file /tmp/proof.txt and tell me exactly what marker string it contains.")"
assert_reply_contains "C/remote/marker" "$RESP_C" "$MARK" \
  "the cluster did not read the planted marker -- either the exec did not reach the remote worker, or it read a different filesystem"
TEXT_C="$(reply_text "$RESP_C")"
[ -n "$TEXT_C" ] && note "model's reply: $TEXT_C"

# --- 13. Presence vanishes with the stream ---------------------------------------------
# Skipped under --keep, which promises the worker is still running when the run ends: proving the
# record clears means closing the Attach stream, and there is no way to do both.
if [ "$KEEP" = 1 ]; then
  claim "Presence teardown -- SKIPPED (--keep)"
  note "--keep leaves the worker running, so its Attach stream stays open and the record stays."
  note "Re-run without --keep to assert the record clears, or watch it go by hand:"
  note "  docker stop $WORKER_CTR"
  note "  kubectl exec deploy/redis -n $NS -- redis-cli HGETALL sh:sandbox:records"
else
  claim "Presence: the record clears when the Attach stream closes"
  docker stop "$WORKER_CTR" >/dev/null 2>&1 || true
  assert_presence_gone "$SANDBOX_ID"
  note "Nothing deleted it -- the registration IS the stream, so it went with it."
fi

# --- 14. Summary -----------------------------------------------------------------------
echo ""
echo "=== The A/B ==="
printf '%-34s | %s\n' "backend" "what the model said it read"
printf '%-34s-+-%s\n' "----------------------------------" "---------------------------"
printf '%-34s | %s\n' "in-cluster pod ($SBOX_POD)" "${TEXT_A:-(no reply returned)}"
printf '%-34s | %s\n' "remote host container" "${TEXT_B:-(no reply returned)}"
echo ""
echo "Same prompt, and the model names a different OS each time. The second one ran on a"
echo "container on this host that the cluster cannot reach and never authenticated to -- it"
echo "dialed out, and nothing else. Then it read a marker planted here seconds earlier:"
printf '  %s\n' "${MARK}"

echo ""; echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then echo "DEMO FAIL"; exit 1; else echo "DEMO PASS"; exit 0; fi
