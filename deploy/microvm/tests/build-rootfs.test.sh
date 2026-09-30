#!/usr/bin/env bash
# deploy/microvm/tests/build-rootfs.test.sh
#
# Root-free, podman-free test for build-rootfs.sh. podman and id are mocked onto PATH; the mock
# `podman export` streams a tar of a fixture tree, so the test checks what the script does with an
# image's filesystem without having one.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/build-rootfs.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }

export MOCK_LOG="$TMP/mock.log" FIXTURE="$TMP/fixture"
mkdir -p "$TMP/bin"
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
printf 'podman %s\n' "$*" >>"$MOCK_LOG"
case "$1 ${2:-}" in
  "image exists") exit 0 ;;
  "image inspect") echo "sha256:0123abcd" ;;
  "create "*) echo "cid-42" ;;
  "export "*) tar -C "$FIXTURE" -cf - . ;;
  "rm "*) : ;;
esac
MOCK
cat >"$TMP/bin/id" <<'MOCK'
#!/usr/bin/env bash
[ "$*" = "-u" ] && echo "${MOCK_UID:-0}"
MOCK
chmod +x "$TMP/bin/podman" "$TMP/bin/id"
export PATH="$TMP/bin:$PATH"

make_fixture() { # make_fixture <tool>... : an image tree carrying exactly these tools
  rm -rf "$FIXTURE"
  mkdir -p "$FIXTURE/usr/bin" "$FIXTURE/usr/local/bin" "$FIXTURE/etc" "$FIXTURE/workspace"
  local t
  for t in "$@"; do printf '#!/bin/sh\n' >"$FIXTURE/usr/bin/$t"; chmod +x "$FIXTURE/usr/bin/$t"; done
  printf 'bin\n' >"$FIXTURE/usr/local/bin/remote-worker"; chmod +x "$FIXTURE/usr/local/bin/remote-worker"
}
ALL_TOOLS=(bash git rg python3 base64 file ls cat)

echo "== shellcheck"
if command -v shellcheck >/dev/null; then
  shellcheck "$SCRIPT"; check "shellcheck clean" "$?" "0"
fi

echo "== a complete image becomes a rootfs tree"
make_fixture "${ALL_TOOLS[@]}"
: >"$MOCK_LOG"
bash "$SCRIPT" --out "$TMP/out1" --image example/img:1 >"$TMP/run1.log" 2>&1
check "exit 0" "$?" "0"
check "bash carried over" "$([ -x "$TMP/out1/usr/bin/bash" ] && echo yes || echo no)" "yes"
check "the container worker binary is stripped" \
  "$([ -e "$TMP/out1/usr/local/bin/remote-worker" ] && echo present || echo absent)" "absent"
check "provenance names the image" "$(grep -c '^image=example/img:1$' "$TMP/out1/etc/moca-rootfs-source")" "1"
check "provenance records the digest" "$(grep -c '^digest=sha256:0123abcd$' "$TMP/out1/etc/moca-rootfs-source")" "1"
for d in dev proc sys; do
  check "/$d exists as a mount point" "$([ -d "$TMP/out1/$d" ] && echo yes || echo no)" "yes"
done
check "the temporary container is removed" "$(grep -c '^podman rm -f cid-42$' "$MOCK_LOG")" "1"

echo "== an image missing a required tool is refused, naming it"
make_fixture bash git python3 base64 file ls cat # no rg
: >"$MOCK_LOG"
bash "$SCRIPT" --out "$TMP/out2" --image example/img:1 >"$TMP/run2.log" 2>&1
check "exit 1" "$?" "1"
check "names rg" "$(grep -c "missing required tool.*rg" "$TMP/run2.log")" "1"
check "the temporary container is removed on failure too" "$(grep -c '^podman rm -f cid-42$' "$MOCK_LOG")" "1"

echo "== a non-empty --out is refused and left untouched"
mkdir -p "$TMP/out3"; echo keep >"$TMP/out3/precious"
make_fixture "${ALL_TOOLS[@]}"
bash "$SCRIPT" --out "$TMP/out3" --image example/img:1 >"$TMP/run3.log" 2>&1
check "exit 1" "$?" "1"
check "existing content kept" "$(cat "$TMP/out3/precious")" "keep"

echo "== non-root is refused (ownership inside the image must survive extraction)"
MOCK_UID=1000 bash "$SCRIPT" --out "$TMP/out4" >"$TMP/run4.log" 2>&1
check "exit 1" "$?" "1"
check "names root" "$(grep -c 'must run as root' "$TMP/run4.log")" "1"

if [ "$fails" -eq 0 ]; then echo "PASS"; else echo "FAIL ($fails)"; fi
exit "$fails"
