#!/usr/bin/env bash
# deploy/microvm/tests/p4-turn-smoke.test.sh
#
# KVM-free test for p4-turn-smoke.sh. curl, podman, journalctl, systemctl, pgrep and kill are mocked
# onto PATH. The curl mock stands in for the supervisor's /turn with its REAL contract, which the
# driver first got wrong:
#   - a sessionId the backend has never seen is a 404 session_not_found (runTurn's
#     createIfAbsent:false); a new session is created by OMITTING sessionId, and the response names it;
#   - the non-streaming response is {sessionId, response, ...} where `response` is only the final
#     assistant text -- which the scripted model (mock-anthropic.mjs) fills with the tool results.
# It also answers Firecracker's GET / on each jail's API socket, so the driver's "kill the VM that
# is running the Exec" can be checked against a Paused standby.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/p4-turn-smoke.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }
command -v node >/dev/null || { echo "SKIP: node not installed"; exit 0; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export STATE="$TMP/state" MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"

cat >"$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
# Minimal curl: -o FILE, -w '%{http_code}', -d BODY, --unix-socket SOCK, and a URL.
out=/dev/stdout body="" sock="" url="" wfmt=""
while [ $# -gt 0 ]; do
  case "$1" in
  -o) out="$2"; shift 2 ;;
  -w) wfmt="$2"; shift 2 ;;
  -d) body="$2"; shift 2 ;;
  -H | --max-time | -X) shift 2 ;;
  --unix-socket) sock="$2"; shift 2 ;;
  -*) shift ;;
  *) url="$1"; shift ;;
  esac
done
if [ -n "$sock" ]; then # Firecracker GET /: only vm-7 is running; the rest are paused standbys
  case "$sock" in */vm-7/*) echo '{"state":"Running"}' ;; *) echo '{"state":"Paused"}' ;; esac
  exit 0
fi
if [ "$url" != "${url%/v1/credentials/*}" ]; then # PUT /v1/credentials/<name>, as a minted subject
  echo "credential-put $url" >>"$MOCK_LOG"; code=204; : >"$out" # putCredential's real code
elif [ "$url" != "${url%/v1/sessions/*}" ]; then # GET /v1/sessions/<id>: every caller here is a foreigner
  code=404; printf '{"error":"session_not_found"}' >"$out"
elif [ "$url" != "${url%/healthz}" ]; then
  code=200; printf 'ok' >"$out"
else
  sid="$(node -e 'const b=JSON.parse(process.argv[1]); process.stdout.write(b.sessionId ?? "")' "$body")"
  prompt="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).prompt)' "$body")"
  code=200
  if resp="$(fake-turn "$sid" "$prompt")"; then
    printf '{"sessionId":"%s","response":"%s","stopReason":"end_turn"}' "$(cat "$STATE/last-sid")" "$resp" >"$out"
  else
    code=404; printf '{"error":"session_not_found"}' >"$out"
  fi
fi
[ -n "$wfmt" ] && printf '%s' "$code"
exit 0
MOCK
cat >"$TMP/bin/fake-turn" <<'MOCK'
#!/usr/bin/env bash
# fake-turn <session id, or "" for new> <prompt>: the supervisor's turn, shared by the curl mock
# (/turn) and the mocactl mock (/v1/turn). Prints the response text with \n escapes and writes the
# session id to $STATE/last-sid. Exit 4 = session_not_found.
sid="$1" prompt="$2"
mkdir -p "$STATE/ws"
if [ -n "$sid" ] && [ ! -d "$STATE/ws/$sid" ]; then exit 4; fi
if [ -z "$sid" ]; then sid="sess-$(ls "$STATE/ws" | wc -l | tr -d ' ')"; mkdir -p "$STATE/ws/$sid"; fi
ws="$STATE/ws/$sid"
logexec() { n=$(( $(cat "$STATE/vmseq" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$STATE/vmseq"
  echo "vmpool: exec req=$n workspace_key=\"$sid\" vm=vm-$n cold=\"\" exit=0 err=<nil>" >>"$STATE/journal"; }
case "$prompt" in
P4-SMOKE-WRITE) logexec; logexec; touch "$ws/proof" "$ws/repo"
  resp="done-write\n6.1.0-guest\nimage=ghcr.io/x\n/workspace\n## No commits yet on main\n42\nripgrep 15.2.0" ;;
P4-SMOKE-READ) logexec
  if [ -e "$ws/proof" ]; then resp="done-read\np4-proof\ncontinuity-ok"
  else resp="done-read\ncat: proof.txt: No such file or directory\ncontinuity-missing"; fi ;;
P4-SMOKE-SLEEP) # ends when the worker restarts or the running VM is killed
  for _ in $(seq 50); do [ -e "$STATE/interrupted" ] && break; sleep 0.1; done
  why="$(cat "$STATE/interrupted" 2>/dev/null)"; rm -f "$STATE/interrupted"
  resp="done-sleep\n${why:-slept}" ;;
esac
[ -n "${MOCK_EMPTY_RESPONSE:-}" ] && resp=""
echo "$sid" >"$STATE/last-sid"
printf '%s' "$resp"
MOCK
cat >"$TMP/bin/mocactl" <<'MOCK'
#!/usr/bin/env bash
# mocactl run PROMPT --control-plane-url U --harness-url H [--session ID | --option K=V]. Logged in only
# if $XDG_CONFIG_HOME/mocactl/auth.json holds a token minted for a p4smoke subject; the subject is
# read from the token itself, so a driver that wrote a wrong or unsigned-looking file fails here.
echo "mocactl $*" >>"$MOCK_LOG"
[ "$1" = run ] || exit 2
prompt="$2"; shift 2
sid="" opt=""
while [ $# -gt 0 ]; do
  case "$1" in
  --session) sid="$2"; shift 2 ;;
  --option) opt="$2"; shift 2 ;;
  *) shift 2 ;;
  esac
done
sub="$(node -e 'const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const c = JSON.parse(Buffer.from(a.apiToken.split(".")[1], "base64url"));
  process.stdout.write(c.sub === a.subject && c.scope.includes("api") ? c.sub : "")' \
  "$XDG_CONFIG_HOME/mocactl/auth.json" 2>/dev/null)"
case "$sub" in p4smoke:a | p4smoke:b) ;; *) echo "not logged in — run \`mocactl login\` first" >&2; exit 2 ;; esac
if [ -z "$sid" ] && [ "$opt" != "inferenceCredential=p4-smoke-mock" ]; then
  echo "choose the inference credential with --option inferenceCredential=<value>" >&2; exit 2
fi
resp="$(fake-turn "$sid" "$prompt")" || { echo "session not found" >&2; exit 1; }
echo "session $(cat "$STATE/last-sid")" >&2
printf '%b\n' "$resp"
MOCK
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
case "$1" in exec) echo 1 ;; ps) : ;; esac
MOCK
cat >"$TMP/bin/journalctl" <<'MOCK'
#!/usr/bin/env bash
cat "$STATE/journal" 2>/dev/null
MOCK
cat >"$TMP/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
echo "systemctl $*" >>"$MOCK_LOG"
[ "$1" = restart ] && echo "worker disconnected" >"$STATE/interrupted"
exit 0
MOCK
cat >"$TMP/bin/pgrep" <<'MOCK'
#!/usr/bin/env bash
# firecracker pid = 99999000 + vm number, found by its --id argument. Above any real pid_max, so
# even a kill that bypassed the mock could not reach a live process.
for a in "$@"; do case "$a" in *vm-[0-9]*) n="${a##*vm-}"; n="${n%%[!0-9]*}"; echo $((99999000 + n)); exit 0 ;; esac; done
exit 1
MOCK
cat >"$TMP/bin/kill" <<'MOCK'
#!/usr/bin/env bash
echo "kill $*" >>"$MOCK_LOG"
echo "vsock: guest connection closed" >"$STATE/interrupted"
MOCK
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"
export SH_WORKSPACE_ROOT="$STATE/ws" SH_JAIL_BASE="$TMP/jail" SMOKE_FAIL_DELAY=1
for v in vm-6 vm-7 vm-8; do mkdir -p "$SH_JAIL_BASE/firecracker/$v/root/run"; : >"$SH_JAIL_BASE/firecracker/$v/root/run/firecracker.socket"; done

echo "== shellcheck"
if command -v shellcheck >/dev/null; then
  shellcheck -S warning "$SCRIPT"; check "shellcheck clean" "$?" "0"
fi

echo "== happy path, with failure paths, against the real /turn contract"
bash "$SCRIPT" --failure-paths --out "$TMP/out1" >"$TMP/run1.log" 2>&1
rc=$?
check "exit 0" "$rc" "0"
[ "$rc" = 0 ] || sed -n '/FAIL/p' "$TMP/run1.log"
check "the two sessions got different server-assigned ids" \
  "$([ "$(cat "$TMP/out1/session-a")" != "$(cat "$TMP/out1/session-b")" ] && echo yes || echo no)" "yes"
check "the VM killed was the RUNNING one (vm-7), not the newest standby (I2)" \
  "$(grep -c '^kill -KILL 99999007$' "$MOCK_LOG")" "1"
check "which VM was killed is recorded" "$(grep -c 'killed vm-7' "$TMP/out1/SUMMARY")" "1"

echo "== an empty response fails the run, and the isolation checks fail rather than pass (C2)"
rm -rf "$STATE"
MOCK_EMPTY_RESPONSE=1 bash "$SCRIPT" --out "$TMP/out2" >"$TMP/run2.log" 2>&1
check "exit non-zero" "$([ $? -ne 0 ] && echo yes || echo no)" "yes"
check "b1's 'did not see A's file' is a FAIL, not a vacuous ok" \
  "$(grep -c "FAIL: b1 did not see A's file" "$TMP/out2/SUMMARY")" "1"
check "a1's 'guest kernel is not the host's' is a FAIL, not a vacuous ok" \
  "$(grep -c "FAIL: a1 guest kernel is not the host's" "$TMP/out2/SUMMARY")" "1"

echo "== --auth: two minted subjects drive mocactl run"
rm -rf "$STATE"; : >"$MOCK_LOG"
mkdir -p "$TMP/cred"
(cd "$DIR/../../packages/control-plane" && node --import tsx src/genkeys.ts) |
  sed -n 's/^SH_SESSION_TOKEN_PRIVATE_KEY=//p' >"$TMP/cred/session-token-private-key"
check "a signing key was generated for the test" \
  "$([ -s "$TMP/cred/session-token-private-key" ] && echo yes || echo no)" "yes"
MOCA_CRED_DIR="$TMP/cred" MOCACTL=mocactl bash "$SCRIPT" --auth --failure-paths --out "$TMP/out3" \
  >"$TMP/run3.log" 2>&1
rc=$?
check "exit 0" "$rc" "0"
[ "$rc" = 0 ] || sed -n '/FAIL/p' "$TMP/run3.log"
check "session B was subject b's" "$(grep -c 'ok: subject b cannot read subject a' "$TMP/out3/SUMMARY")" "1"
check "each subject stored the mock credential" "$(grep -c '^credential-put .*/v1/credentials/p4-smoke-mock$' "$MOCK_LOG")" "2"
check "every turn went through mocactl" "$(grep -c '^mocactl run ' "$MOCK_LOG")" "5"
check "no api token on any argv" "$(grep -c 'eyJ' "$MOCK_LOG")" "0"
check "auth.json is 0600" "$(node -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$TMP/out3/xdg-a/mocactl/auth.json")" "600"

echo "== --auth without a readable signing key fails at the mint, by name"
rm -rf "$STATE"
MOCA_CRED_DIR="$TMP/nowhere" MOCACTL=mocactl bash "$SCRIPT" --auth --out "$TMP/out4" >"$TMP/run4.log" 2>&1
check "exit non-zero" "$([ $? -ne 0 ] && echo yes || echo no)" "yes"
check "the mint failure is named" "$(grep -c "FAIL: minted subject a's api token" "$TMP/out4/SUMMARY")" "1"

if [ "$fails" -eq 0 ]; then echo "PASS"; else echo "FAIL ($fails)"; fi
exit "$fails"
