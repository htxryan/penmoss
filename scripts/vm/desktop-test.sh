#!/bin/sh
# Runs the Mac app's tests (`task desktop:test`) in a macOS VM on this Mac, so Electron's windows
# open there and never on Ryan's screen (W-series agreement, `docs/decisions.md`; `docs/ci.md`).
#
#   task desktop:test:vm                      # the whole suite
#   task desktop:test:vm -- -g "T82"          # Playwright arguments, as `task desktop:test`
#
# The VM (Tart, Apple's Virtualization framework) is `penmoss-test`, cloned once from Cirrus Labs'
# macOS base image and kept: its Homebrew tools, Node and pnpm store survive between runs. Each run
# boots it with no window, shares this checkout read-only, copies it into the VM (no node_modules,
# no build output), installs, runs the tests, copies the log and Playwright's report back to
# `test-results/vm/`, and stops the VM. Nothing in the VM can write to this checkout.
set -eu

VM="${PENMOSS_VM:-penmoss-test}"
IMAGE="${PENMOSS_VM_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-base:latest}"
CPUS="${PENMOSS_VM_CPUS:-8}"
MEMORY_MB="${PENMOSS_VM_MEMORY_MB:-16384}"
# The suite's windows are up to 1300 x 900 (as on xvfb's screen and a Mac's): the base image's
# 1024 x 768 is too small, and macOS shrinks a window to fit its screen. WIDTHxHEIGHT, in points.
DISPLAY_SIZE="${PENMOSS_VM_DISPLAY:-1920x1200}"
SCREEN_W="${DISPLAY_SIZE%%x*}"
SCREEN_H="${DISPLAY_SIZE#*x}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Only ever 1 or empty: it goes into the VM's shell command below.
PROOF=''
[ "${PENMOSS_PROOF:-}" = 1 ] && PROOF=1
OUT="$ROOT/test-results/vm"
SHARED='/Volumes/My Shared Files'
# The port block (scripts/ports.mjs) the suite runs on in the VM, passed through. Digits only, as
# it goes into the command the VM runs.
PORT_BLOCK="${PENMOSS_PORT_BLOCK:-0}"
case "$PORT_BLOCK" in
  '' | *[!0-9]*)
    echo "PENMOSS_PORT_BLOCK must be a whole number, not \"$PORT_BLOCK\"" >&2
    exit 2
    ;;
esac

command -v tart >/dev/null || {
  echo "tart is not installed: see docs/ci.md (Tests in a macOS VM)." >&2
  exit 1
}

# One run at a time: every agent and worktree shares the one VM, and a run starts by stopping it.
# Others wait here for the lock (lockf, held until this run ends) instead of stopping a run.
LOCK="/tmp/penmoss-vm-$VM.lock"
if [ -z "${PENMOSS_VM_LOCKED:-}" ]; then
  if ! lockf -s -t 0 "$LOCK" true 2>/dev/null; then
    echo "[vm] $VM is busy with another run; waiting for it to finish"
  fi
  PENMOSS_VM_LOCKED=1 exec lockf -k "$LOCK" sh "$0" "$@"
fi

if ! tart list --quiet 2>/dev/null | grep -qx "$VM"; then
  echo "[vm] making $VM from $IMAGE (once)"
  tart clone "$IMAGE" "$VM"
  tart set "$VM" --cpu "$CPUS" --memory "$MEMORY_MB"
fi

mkdir -p "$OUT"
rm -rf "$OUT"/*

# A VM left running by an interrupted run is stopped first.
tart stop "$VM" >/dev/null 2>&1 || true
# Every run, so a VM made before this setting gets it too.
tart set "$VM" --display "$DISPLAY_SIZE"
tart run "$VM" --no-graphics --dir="src:$ROOT:ro" --dir="out:$OUT" >"$OUT/tart-run.log" 2>&1 &
RUN_PID=$!
cleanup() {
  tart stop "$VM" >/dev/null 2>&1 || true
  wait "$RUN_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[vm] booting $VM"
tries=0
until tart exec "$VM" true >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 90 ]; then
    echo "[vm] $VM did not answer in 3 minutes; see $OUT/tart-run.log" >&2
    exit 1
  fi
  sleep 2
done

# Inside the VM, as its logged-in user (so Electron has a window server).
tart exec "$VM" /bin/zsh -lc "
  set -eu
  export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
  eval \"\$(/opt/homebrew/bin/brew shellenv)\"
  xcode-select -p >/dev/null 2>&1 || { echo 'The VM has no Xcode command-line tools.' >&2; exit 1; }
  command -v task >/dev/null || brew install go-task
  brew list node@24 >/dev/null 2>&1 || brew install node@24
  export PATH=\"\$(brew --prefix node@24)/bin:\$PATH\"
  corepack enable >/dev/null 2>&1 || true
  mkdir -p \"\$HOME/penmoss\"
  rsync -a --delete \
    --exclude node_modules --exclude dist --exclude release --exclude test-results \
    --exclude playwright-report --exclude .git --exclude .claude \
    '$SHARED/src/' \"\$HOME/penmoss/\"
  cd \"\$HOME/penmoss\"
  # The display has the size now (tart set); macOS in the VM still has to switch to it.
  swift scripts/vm/screen-size.swift $SCREEN_W $SCREEN_H
  export CI=1 PENMOSS_PORT_BLOCK=$PORT_BLOCK
  # Proof mode (the software factory's F7): every window recorded, and a JSON report.
  export PENMOSS_PROOF='$PROOF'
  pnpm install --frozen-lockfile >'$SHARED/out/install.log' 2>&1
  code=0
  task desktop:test -- $* >'$SHARED/out/desktop-test.log' 2>&1 || code=\$?
  [ -d apps/desktop/playwright-report ] && cp -R apps/desktop/playwright-report '$SHARED/out/' || true
  [ -d apps/desktop/test-results ] && cp -R apps/desktop/test-results '$SHARED/out/' || true
  exit \$code
" && status=0 || status=$?

tail -n 15 "$OUT/desktop-test.log" 2>/dev/null || true
echo "[vm] exit $status; log: $OUT/desktop-test.log"
exit "$status"
