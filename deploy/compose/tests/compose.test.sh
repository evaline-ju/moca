#!/usr/bin/env bash
# Static test for docker-compose.yml (#342). Renders the file through Compose's own resolver
# (`config --format json`, which needs no daemon) against controlled .env files, and asserts on
# what Compose will actually run -- not on the YAML text, which interpolation and defaults make a
# poor proxy for it.
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$COMPOSE_DIR/../.." && pwd)"
VM_ENV="$REPO_ROOT/deploy/vm/env"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok - $*"; }

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
elif [[ -n "${CI:-}" ]]; then
  fail "CI has no Docker Compose, so docker-compose.yml would go unchecked"
else
  echo "SKIP: no 'docker compose' or 'docker-compose' on this machine; docker-compose.yml UNCHECKED"
  exit 0
fi
command -v jq >/dev/null || fail "jq is required"

# render NAME ENV_LINES... -> path to Compose's resolved JSON for that .env (or fails).
# `env -i`: the caller's own shell (ANTHROPIC_*, SH_*) must not leak into interpolation.
render() {
  local name="$1"
  shift
  mkdir -p "$TMP/$name"
  cp "$COMPOSE_DIR/docker-compose.yml" "$TMP/$name/"
  printf '%s\n' "$@" >"$TMP/$name/.env"
  (cd "$TMP/$name" && env -i PATH="$PATH" HOME="$HOME" "${COMPOSE[@]}" config --format json) \
    >"$TMP/$name/out.json" 2>"$TMP/$name/err" || return 1
  echo "$TMP/$name/out.json"
}

BASE_ENV=('SH_RELAY_TOKEN=tok-under-test' 'MOCA_RELAY_EXEC_TOKEN=exec-under-test' 'SH_TURNS_PER_WORKER=3')
OUT="$(render base "${BASE_ENV[@]}")" || fail "compose config failed: $(cat "$TMP/base/err")"

svc_env() { jq -r --arg s "$1" --arg k "$2" '.services[$s].environment[$k] // "<absent>"' "$OUT"; }

# --- 1. exactly one supervisor, and nothing that could multiply its worker pool -----------------
# The supervisor forks its W workers with child_process.fork() (packages/supervisor/src/main.ts):
# the pool lives in ONE process tree, so it can only ever live in one container. A second service
# running the supervisor or a worker entrypoint, or a replica count on the one that does, is a
# topology the fork()-based pool cannot manage.
runs_supervisor="$(jq -r '.services | to_entries[]
  | select((.value.working_dir // "") | test("packages/supervisor$")) | .key' "$OUT")"
[[ "$runs_supervisor" == supervisor ]] ||
  fail "exactly one service, named 'supervisor', must run packages/supervisor; got: '${runs_supervisor//$'\n'/, }'"
runs_worker="$(jq -r '.services | to_entries[]
  | select(((.value.command // []) + (.value.entrypoint // []) | join(" ")) | test("worker\\.ts|--role=turn"))
  | .key' "$OUT")"
[[ -z "$runs_worker" ]] ||
  fail "a service runs a turn worker directly ($runs_worker): workers are the supervisor's fork() children"
replicas="$(jq -r '.services.supervisor.deploy.replicas // .services.supervisor.scale // 1' "$OUT")"
[[ "$replicas" == 1 ]] ||
  fail "the supervisor service has $replicas replicas: scale W with SH_WORKERS inside the container"
pass "one supervisor service owns the worker pool; no second worker-bearing service, no replicas"

# --- 2. env mirrors deploy/vm/env/*.env.example var-for-var, only addressing changed ----------
# The addressing keys are the only ones allowed to differ: on a compose network the peers are
# service names, not 127.0.0.1.
declare -A ADDRESSING=(
  [supervisor.REDIS_URL]='redis://redis:6379'
  [supervisor.SH_RELAY_ADDR]='sandbox-relay:9443'
  [sandbox-relay.REDIS_URL]='redis://redis:6379'
)
# Keys an example leaves empty or commented are operator inputs, so compose takes them from .env.
declare -A FROM_DOTENV=(
  [supervisor.SH_TURNS_PER_WORKER]='3'
  [sandbox-relay.SH_RELAY_TOKEN]='tok-under-test'
  [sandbox-relay.MOCA_RELAY_EXEC_TOKEN]='exec-under-test'
  [supervisor.MOCA_RELAY_EXEC_TOKEN]='exec-under-test'
)
check_mirror() {
  local svc="$1" example="$2" key val want got
  while IFS='=' read -r key val; do
    want="${ADDRESSING[$svc.$key]:-${FROM_DOTENV[$svc.$key]:-$val}}"
    got="$(svc_env "$svc" "$key")"
    [[ "$got" == "$want" ]] ||
      fail "$svc: $key is '$got', expected '$want' (mirroring ${example#"$REPO_ROOT/"})"
  done < <(grep -E '^[A-Z_]+=' "$example"; grep -E '^#(SH_RELAY_TOKEN|MOCA_RELAY_EXEC_TOKEN)=' "$example" | sed 's/^#//')
}
check_mirror supervisor "$VM_ENV/supervisor.env.example"
check_mirror sandbox-relay "$VM_ENV/relay.env.example"
pass "supervisor and sandbox-relay env mirror deploy/vm/env/*.env.example, addressing aside"

# SH_WORKERS is commented out in the VM template (the default is availableParallelism(), which
# respects the container's CPU limit since #341). Unset must mean unset, not SH_WORKERS=''.
[[ "$(svc_env supervisor SH_WORKERS)" == '<absent>' ]] ||
  fail "SH_WORKERS reaches the supervisor as '$(svc_env supervisor SH_WORKERS)' when .env does not set it"
OUT_W="$(render workers "${BASE_ENV[@]}" 'SH_WORKERS=2')" || fail "compose config failed with SH_WORKERS"
[[ "$(jq -r '.services.supervisor.environment.SH_WORKERS' "$OUT_W")" == 2 ]] ||
  fail "SH_WORKERS=2 in .env does not reach the supervisor"
pass "SH_WORKERS is absent unless .env sets it, and passes through when it does"

# --- 3. the relay's bind port and the supervisor's dial port cannot disagree ------------------
# relay.env.example warns these MUST agree and nothing checks them; here both derive from one
# .env value, so moving the port moves both ends and the sandbox's dial address with them.
OUT_P="$(render port "${BASE_ENV[@]}" 'SH_RELAY_PORT=7777')" || fail "compose config failed with a port"
[[ "$(jq -r '.services["sandbox-relay"].environment.SH_RELAY_PORT' "$OUT_P")" == 7777 ]] ||
  fail "SH_RELAY_PORT in .env does not move the relay's bind port"
[[ "$(jq -r '.services.supervisor.environment.SH_RELAY_ADDR' "$OUT_P")" == sandbox-relay:7777 ]] ||
  fail "SH_RELAY_PORT moved the relay but not the supervisor's SH_RELAY_ADDR"
[[ "$(jq -r '.services.sandbox.environment.RELAY_ADDR' "$OUT_P")" == sandbox-relay:7777 ]] ||
  fail "SH_RELAY_PORT moved the relay but not the sandbox's RELAY_ADDR"
pass "one SH_RELAY_PORT drives the relay bind, the supervisor dial and the sandbox dial"

# --- 4. the sandbox authenticates with the relay's own token, under its own id ------------------
[[ "$(svc_env sandbox SANDBOX_TOKEN)" == tok-under-test ]] ||
  fail "the sandbox's SANDBOX_TOKEN is not the relay's SH_RELAY_TOKEN; every attach fails closed"
[[ "$(svc_env sandbox SANDBOX_ID)" != '<absent>' ]] ||
  fail "SANDBOX_ID unset: remote-worker defaults to sbx-laptop-1 and collides with any other"
pass "the sandbox dials the relay with the relay's token and an explicit SANDBOX_ID"

# --- 4b. the exec token reaches the relay and the supervisor, and never a sandbox (MI1 R5) -------
[[ "$(svc_env sandbox-relay MOCA_RELAY_EXEC_TOKEN)" == exec-under-test ]] ||
  fail "the relay does not receive MOCA_RELAY_EXEC_TOKEN; it refuses to boot without it"
[[ "$(svc_env supervisor MOCA_RELAY_EXEC_TOKEN)" == exec-under-test ]] ||
  fail "the supervisor does not receive MOCA_RELAY_EXEC_TOKEN; every exec would be refused"
[[ "$(svc_env sandbox MOCA_RELAY_EXEC_TOKEN)" == '<absent>' ]] ||
  fail "a sandbox received MOCA_RELAY_EXEC_TOKEN: it could then run commands in other sandboxes"
render no-exec 'SH_RELAY_TOKEN=tok' 'SH_TURNS_PER_WORKER=3' >/dev/null &&
  fail "compose accepted an .env with no MOCA_RELAY_EXEC_TOKEN"
grep -q MOCA_RELAY_EXEC_TOKEN "$TMP/no-exec/err" || fail "the refusal must name MOCA_RELAY_EXEC_TOKEN"
pass "the exec token reaches the relay and the supervisor only, and is required"

# --- 5. required inputs fail at `compose config`, before any container starts --------------------
render no-token 'SH_TURNS_PER_WORKER=3' 'MOCA_RELAY_EXEC_TOKEN=x' >/dev/null &&
  fail "compose accepted an .env with no SH_RELAY_TOKEN (the relay fails closed on every attach)"
grep -q SH_RELAY_TOKEN "$TMP/no-token/err" || fail "the refusal must name SH_RELAY_TOKEN: $(cat "$TMP/no-token/err")"
render no-s 'SH_RELAY_TOKEN=tok' 'MOCA_RELAY_EXEC_TOKEN=x' >/dev/null &&
  fail "compose accepted an .env with no SH_TURNS_PER_WORKER (readConfig refuses to start without it)"
grep -q SH_TURNS_PER_WORKER "$TMP/no-s/err" || fail "the refusal must name SH_TURNS_PER_WORKER"
pass "a missing SH_RELAY_TOKEN or SH_TURNS_PER_WORKER stops compose with the variable named"

# --- 6. only the supervisor's data port is reachable from the host, and only on loopback ------
# Redis runs with no auth and holds sh:sandbox:records -- whoever writes there picks the executor
# for every turn (see deploy/vm/setup-vm.sh's start_redis). The relay and sandbox talk over the
# compose network. The admin listener is unauthenticated and must stay unpublished.
published="$(jq -r '.services | to_entries[] | select(.value.ports) | .key' "$OUT")"
[[ "$published" == supervisor ]] || fail "only the supervisor may publish ports; got: ${published//$'\n'/, }"
jq -e '.services.supervisor.ports | length == 1 and .[0].host_ip == "127.0.0.1" and .[0].target == 8080' \
  "$OUT" >/dev/null || fail "supervisor must publish exactly 8080, on 127.0.0.1: $(jq -c .services.supervisor.ports "$OUT")"
[[ "$(jq -r '.services.redis.image' "$OUT")" == docker.io/redis:7-alpine ]] ||
  fail "redis image must match deploy/vm/setup-vm.sh's start_redis (docker.io/redis:7-alpine)"
pass "only the supervisor's 8080 is published, on loopback; redis is the VM path's image"

# --- 7. model settings pass through when set and stay absent when not --------------------------
# An empty SH_MODEL reaches run-turn.ts as '' and `env.SH_MODEL ?? default` keeps it.
[[ "$(svc_env supervisor SH_MODEL)" == '<absent>' && "$(svc_env supervisor ANTHROPIC_API_KEY)" == '<absent>' ]] ||
  fail "unset model variables reach the supervisor as empty strings"
OUT_M="$(render model "${BASE_ENV[@]}" 'ANTHROPIC_API_KEY=sk-fabricated' 'SH_MODEL=m-1')" || # notsecret
  fail "compose config failed with model settings"
[[ "$(jq -r '.services.supervisor.environment.ANTHROPIC_API_KEY' "$OUT_M")" == sk-fabricated ]] || # notsecret
  fail "ANTHROPIC_API_KEY in .env does not reach the supervisor"
[[ "$(jq -r '.services.supervisor.environment.SH_MODEL' "$OUT_M")" == m-1 ]] ||
  fail "SH_MODEL in .env does not reach the supervisor"
pass "model settings in .env reach the supervisor; unset ones stay unset"
