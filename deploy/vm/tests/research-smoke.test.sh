#!/usr/bin/env bash
# deploy/vm/tests/research-smoke.test.sh
#
# Root-free, VM-free test for research-smoke.sh (#368). curl and podman are mocked onto PATH; the api
# token is minted FOR REAL, by the checkout's own control-plane code, with a key from genkeys.ts. The
# curl mock stands in for the control plane (readyz, PUT credential, POST session, DELETEs) and the
# supervisor's SSE /v1/turn. It answers each turn with one scripted transcript (MOCK_SCENARIO), and the
# podman mock stands in for the sandbox containers holding what that transcript fetched.
set -uo pipefail

VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$VM_DIR/../.." && pwd)"
SCRIPT="$VM_DIR/research-smoke.sh"
fails=0
check() { if [[ "$2" == "$3" ]]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }
command -v node >/dev/null || { echo "SKIP: node not installed"; exit 0; }
[[ -x "$REPO/packages/control-plane/node_modules/.bin/tsx" ]] ||
  { echo "SKIP: packages/control-plane has no tsx (run pnpm install)"; exit 0; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export STATE="$TMP/state" MOCK_LOG="$TMP/mock.log" ARGV_LOG="$TMP/argv.log"
mkdir -p "$TMP/bin" "$STATE" "$TMP/etc/credentials" "$TMP/tmp"

# The control plane's real signing key, as setup-vm.sh writes it (the base64 value alone).
(cd "$REPO/packages/control-plane" && node --import tsx src/genkeys.ts) |
  sed -n 's/^SH_SESSION_TOKEN_PRIVATE_KEY=//p' >"$TMP/etc/credentials/session-token-private-key"
[[ -s "$TMP/etc/credentials/session-token-private-key" ]] || { echo "FAIL: genkeys.ts produced no key"; exit 1; }
echo 'SH_CONTROL_PLANE_PORT=18090' >"$TMP/etc/control-plane.env"
RAW_KEY='sk-ant-api03-fabricated-for-the-test' # notsecret
GW_KEY='gw-fabricated-token'                   # notsecret
(umask 077 && printf '%s\n' "$RAW_KEY" >"$TMP/raw.key" && printf '%s\n' "$GW_KEY" >"$TMP/gw.key")
HEAD_SHA=0123456789abcdef0123456789abcdef01234567

cat >"$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$ARGV_LOG"
out=/dev/stdout wfmt="" method=GET url="" dumph="" body="" auth=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  -o) out="$2"; shift 2 ;;
  -w) wfmt="$2"; shift 2 ;;
  -X) method="$2"; shift 2 ;;
  -D) dumph="$2"; shift 2 ;;
  -d) body="$2"; [[ "$method" == GET ]] && method=POST; shift 2 ;;
  --data-binary)
    case "$2" in @-) body="$(cat)" ;; @*) body="$(cat "${2#@}")" ;; *) body="$2" ;; esac
    [[ "$method" == GET ]] && method=POST; shift 2 ;;
  -H)
    h="$2"; [[ "$h" == @* ]] && h="$(cat "${h#@}")"
    [[ "$h" == Authorization:* ]] && auth="${h#Authorization: Bearer }"
    shift 2 ;;
  --max-time) shift 2 ;;
  -*) shift ;;
  *) url="$1"; shift ;;
  esac
done
path="/${url#http://*/}"
echo "$method $path" >>"$MOCK_LOG"
reply() { printf '%s' "$2" >"$out"; [[ -n "$wfmt" ]] && printf '%s' "$1"; exit 0; }
# The api token must be the real control plane's: three segments, and its payload names the subject.
api_ok() { node -e 'const [, p] = process.argv[1].split("."); const c = JSON.parse(Buffer.from(p, "base64url"));
  process.exit(c.sub && c.sub.startsWith("research-smoke:") && c.scope.includes("api") ? 0 : 1)' "$auth" 2>/dev/null; }
case "$method $path" in
"GET /readyz") reply "${MOCK_READYZ:-200}" '{}' ;;
"PUT /v1/credentials/research-smoke")
  api_ok || reply 401 '{"error":"token_invalid"}'
  printf '%s' "$body" >"$STATE/put-body.json"; touch "$STATE/stored"; reply 201 '{}' ;;
"POST /v1/sessions")
  api_ok || reply 401 '{"error":"token_invalid"}'
  reply 201 '{"sessionId":"sess-1","token":"tok-sess-1"}' ;;
"POST /v1/turn")
  [[ "$auth" == tok-sess-1 ]] || reply 401 '{"error":"token_invalid"}'
  dir="$(node -e 'const m = JSON.parse(process.argv[1]).prompt.match(/(\/workspace\/research-[0-9]+-[0-9]+)\//); process.stdout.write(m ? m[1] : "")' "$body")"
  printf '%s' "$dir" >"$STATE/workdir"
  [[ -n "$dumph" ]] && printf 'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n' >"$dumph"
  # The audit entry the exchange would write for this turn.
  if [[ -e "$STATE/stored" ]]; then echo credential_issued >"$STATE/decision"; else echo operator_fallback_used >"$STATE/decision"; fi
  frame() { printf 'event: %s\ndata: %s\n\n' "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).type)' "$1")" "$1"; }
  use() { frame "$(node -e 'process.stdout.write(JSON.stringify({type:"tool_use",id:process.argv[1],name:"bash",args:{command:process.argv[2]}}))' "$1" "$2")"; }
  res() { frame "{\"type\":\"tool_result\",\"id\":\"$1\",\"isError\":$2,\"preview\":\"\"}"; }
  text() { frame "$(node -e 'process.stdout.write(JSON.stringify({type:"text",delta:process.argv[1]}))' "$1")"; }
  answer="I cloned the repo and fetched the release index.
**COMMIT=${MOCK_COMMIT:-0123456789ab}**
\`NODE_VERSION=v26.10.0\`
NODE_DATE=2026-09-21"
  {
    case "${MOCK_SCENARIO:-pass}" in
    pass | wrong-commit)
      use t1 "git clone --depth 1 https://github.com/rossoctl/moca $dir/moca"; res t1 false
      use t2 "curl -fsSL -o $dir/node-releases.json https://nodejs.org/dist/index.json"; res t2 false
      use t3 "git -C $dir/moca log -1 --format=%H && head -c 200 $dir/node-releases.json"; res t3 false
      touch "$STATE/fetched" ;;
    no-curl) # fetched the page with python instead: not the command the demo is about
      use t1 "git clone --depth 1 https://github.com/rossoctl/moca $dir/moca"; res t1 false
      use t2 "python3 -c 'import urllib.request' https://nodejs.org/dist/index.json"; res t2 false
      touch "$STATE/fetched" ;;
    curl-error)
      use t1 "git clone --depth 1 https://github.com/rossoctl/moca $dir/moca"; res t1 false
      use t2 "curl -fsSL -o $dir/node-releases.json https://nodejs.org/dist/index.json"; res t2 true
      touch "$STATE/fetched" ;;
    memory) : ;; # answered with no tool call at all
    error-frame)
      frame '{"type":"error","sessionId":"sess-1","stopReason":"error","errorMessage":"401 invalid x-api-key"}'
      exit 0 ;;
    esac
    [[ "${MOCK_SCENARIO:-pass}" == wrong-commit ]] && answer="${answer//0123456789ab/fedcba987654}"
    text "$answer"
    frame '{"type":"done","sessionId":"sess-1","stopReason":"stop"}'
  } >"$out"
  exit 0 ;;
DELETE*) reply 204 '' ;;
esac
reply 404 '{"error":"not_found"}'
MOCK

cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
echo "podman $*" >>"$MOCK_LOG"
case "$1" in
ps) printf '%s\n' ${MOCK_BOXES-sh-sandbox-0 sh-sandbox-1} ;;
exec)
  box="$2"; shift 2
  case "$box $*" in
  "sh-redis redis-cli HKEYS sh:sandbox:records") printf '%s\n' ${MOCK_RECORDS-sh-sandbox-0 sh-sandbox-1} ;;
  "sh-redis redis-cli --raw XRANGE sh:cp:audit - +")
    printf '1-0\nsubject\nresearch-smoke:x\ndecision\nsession_created\nsessionId\nsess-1\n'
    [[ -e "$STATE/decision" ]] && printf '2-0\nts\n1\nsubject\nresearch-smoke:x\ndecision\n%s\nsessionId\nsess-1\ncredential\nresearch-smoke\n' "$(cat "$STATE/decision")"
    ;;
  "sh-sandbox-1 test -d "*) [[ -e "$STATE/fetched" && "$*" == "test -d $(cat "$STATE/workdir")" ]] ;;
  "sh-sandbox-0 test -d "*) exit 1 ;;
  "sh-sandbox-1 git -C "*) echo "$HEAD_SHA" ;;
  "sh-sandbox-1 python3 "*) echo "v26.10.0 2026-09-21" ;;
  *" rm -rf "*) : ;;
  esac ;;
esac
MOCK
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH" HEAD_SHA SH_ENV_DIR="$TMP/etc" SH_INSTALL_DIR="$REPO" TMPDIR="$TMP/tmp"

# run <name> [VAR=value ...]: one smoke run in a fresh mock state; <name>.log and <name>.rc.
run() {
  local name="$1"
  shift
  rm -rf "$STATE" "$TMP"/tmp/research-smoke.* && mkdir -p "$STATE"
  : >"$MOCK_LOG"
  : >"$ARGV_LOG"
  env VM_RESEARCH_SMOKE=1 "$@" bash "$SCRIPT" >"$TMP/$name.log" 2>&1
  echo $? >"$TMP/$name.rc"
}
rc() { cat "$TMP/$1.rc"; }
logged() { grep -qE "$1" "$MOCK_LOG" && echo yes || echo no; }
said() { grep -qF -- "$2" "$TMP/$1.log" && echo yes || echo no; }

echo "== shellcheck"
if command -v shellcheck >/dev/null; then
  shellcheck -S warning "$SCRIPT"
  check "shellcheck clean" "$?" "0"
fi

echo "== gated"
env -u VM_RESEARCH_SMOKE bash "$SCRIPT" >"$TMP/gate.log" 2>&1
check "exits 0 without VM_RESEARCH_SMOKE" "$?" "0"
check "says SKIP" "$(grep -c '^SKIP:' "$TMP/gate.log")" "1"

echo "== pass: a raw Anthropic key, stored as the user's own api-key credential"
run pass RESEARCH_CREDENTIAL_FILE="$TMP/raw.key"
check "exit 0" "$(rc pass)" "0"
[[ "$(rc pass)" == 0 ]] || grep -E 'FAIL|research-smoke:' "$TMP/pass.log"
check "stored as kind api-key" "$(node -e 'process.stdout.write(require(process.argv[1]).kind)' "$STATE/put-body.json")" "api-key"
check "for https://api.anthropic.com" "$(node -e 'process.stdout.write(require(process.argv[1]).endpoint)' "$STATE/put-body.json")" "https://api.anthropic.com"
check "the key is the file's" "$(node -e 'process.stdout.write(require(process.argv[1]).secret.key)' "$STATE/put-body.json")" "$RAW_KEY"
check "the key never reached an argv" "$(grep -cF -- "$RAW_KEY" "$ARGV_LOG")" "0"
check "no token reached an argv either" "$(grep -cE 'tok-sess-1|Bearer ' "$ARGV_LOG")" "0"
check "the credential was deleted afterwards" "$(logged '^DELETE /v1/credentials/research-smoke$')" "yes"
check "the session was deleted afterwards" "$(logged '^DELETE /v1/sessions/sess-1$')" "yes"
check "the fetched files were removed from the sandboxes" "$(logged "rm -rf $(cat "$STATE/workdir")")" "yes"
check "a passing run leaves no work directory (tokens included)" "$(find "$TMP/tmp" -maxdepth 1 -name 'research-smoke.*' | wc -l | tr -d ' ')" "0"
check "reports the audit decision" "$(said pass 'audit: credential_issued')" "yes"

echo "== a gateway token: bearer, for RESEARCH_ENDPOINT, which it requires"
run gw-noep RESEARCH_CREDENTIAL_FILE="$TMP/gw.key"
check "refused without RESEARCH_ENDPOINT" "$(rc gw-noep)" "2"
check "names RESEARCH_ENDPOINT" "$(said gw-noep RESEARCH_ENDPOINT)" "yes"
check "before any request" "$(wc -l <"$MOCK_LOG" | tr -d ' ')" "0"
run gw RESEARCH_CREDENTIAL_FILE="$TMP/gw.key" RESEARCH_ENDPOINT=https://gateway.example
check "exit 0" "$(rc gw)" "0"
check "stored as kind bearer" "$(node -e 'process.stdout.write(require(process.argv[1]).kind)' "$STATE/put-body.json")" "bearer"
check "destination is the gateway's host" "$(node -e 'process.stdout.write(require(process.argv[1]).destination.hosts[0])' "$STATE/put-body.json")" "gateway.example"

echo "== the operator fallback: no credential stored, and the audit must say so"
run fb RESEARCH_USE_OPERATOR_FALLBACK=1
check "exit 0" "$(rc fb)" "0"
check "stored no credential" "$(logged '^PUT ')" "no"
check "deleted no credential" "$(logged '^DELETE /v1/credentials')" "no"
check "audit: operator_fallback_used" "$(said fb 'audit: operator_fallback_used')" "yes"

echo "== no key at all"
run nokey
check "refused" "$(rc nokey)" "2"
check "names both options" "$(said nokey RESEARCH_USE_OPERATOR_FALLBACK)" "yes"

echo "== a microVM worker in the pool (Review Focus 5): refused before any turn"
run p4 RESEARCH_CREDENTIAL_FILE="$TMP/raw.key" MOCK_RECORDS="sh-sandbox-0 moca_microvm_0"
check "fails" "$(rc p4)" "1"
check "names the record and #277" "$( [[ "$(said p4 moca_microvm_0)$(said p4 '#277')" == yesyes ]] && echo yes || echo no)" "yes"
check "ran no turn" "$(logged '^POST /v1/turn')" "no"
run nobox RESEARCH_CREDENTIAL_FILE="$TMP/raw.key" MOCK_BOXES=""
check "no container sandbox: fails" "$(rc nobox)" "1"
check "no container sandbox: ran no turn" "$(logged '^POST /v1/turn')" "no"

echo "== the model did not do what the demo claims"
run memory RESEARCH_CREDENTIAL_FILE="$TMP/raw.key" MOCK_SCENARIO=memory
check "no tool calls: fails" "$(rc memory)" "1"
check "no tool calls: says git clone did not run" "$(said memory 'no bash tool call ran git clone')" "yes"
check "no tool calls: still cleans up the credential" "$(logged '^DELETE /v1/credentials/research-smoke$')" "yes"
run nocurl RESEARCH_CREDENTIAL_FILE="$TMP/raw.key" MOCK_SCENARIO=no-curl
check "fetched without curl: fails" "$(rc nocurl)" "1"
check "fetched without curl: names curl -o" "$(said nocurl 'no bash tool call ran curl -o')" "yes"
run curlerr RESEARCH_CREDENTIAL_FILE="$TMP/raw.key" MOCK_SCENARIO=curl-error
check "curl failed: fails" "$(rc curlerr)" "1"
check "curl failed: says so" "$(said curlerr 'curl -o was run but failed')" "yes"
run wrong RESEARCH_CREDENTIAL_FILE="$TMP/raw.key" MOCK_SCENARIO=wrong-commit
check "an answer not from the clone: fails" "$(rc wrong)" "1"
check "names both commits" "$(said wrong "COMMIT='fedcba987654', but the clone's HEAD is '0123456789ab'")" "yes"
check "a failing run keeps its evidence" "$(find "$TMP/tmp" -name turn.sse | wc -l | tr -d ' ')" "1"
check "but not its token files" "$(find "$TMP/tmp" -name '*.hdr' -o -name session.json | wc -l | tr -d ' ')" "0"
run errframe RESEARCH_CREDENTIAL_FILE="$TMP/raw.key" MOCK_SCENARIO=error-frame
check "an error frame: fails" "$(rc errframe)" "1"
check "an error frame: shows its message" "$(said errframe '401 invalid x-api-key')" "yes"

echo
if [[ "$fails" -eq 0 ]]; then echo "all research-smoke.sh tests passed"; else echo "FAIL: $fails check(s)"; fi
exit "$fails"
