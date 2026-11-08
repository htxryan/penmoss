#!/bin/sh
# Runs a heavy command (`task check`, the E2E suites, the VM run) only when one of this Mac's
# heavy-job slots is free, so several worktrees and agent sessions don't run their suites all at
# once (W12, A1175). Unrelated suites sharing the CPU made `task check` take over 10 minutes and
# made timing tests fail at random; every failure then cost another run.
#
#   sh scripts/heavy.sh <label> <command...>
#
# The slots are folders under PENMOSS_HEAVY_DIR (default ~/.cache/penmoss/heavy), one per running
# job, holding its pid. `mkdir` either makes the folder or fails, so taking a slot is atomic. A slot
# whose process has gone (a killed run) is freed by the next job that finds it.
#
# PENMOSS_HEAVY_SLOTS sets how many run at once (default 2). CI runs without the lock (its runners
# already take one job each), and so does a command started inside a job that holds a slot
# (PENMOSS_HEAVY_HELD), so `task check` calling its own parts never waits on itself.
set -eu

label="$1"
shift

if [ -n "${CI:-}" ] || [ -n "${PENMOSS_HEAVY_HELD:-}" ]; then
  exec "$@"
fi

dir="${PENMOSS_HEAVY_DIR:-$HOME/.cache/penmoss/heavy}"
slots="${PENMOSS_HEAVY_SLOTS:-2}"
mkdir -p "$dir"

held=''
release() {
  for lock in $held; do
    rm -rf "$lock"
  done
  held=''
}
trap release EXIT
trap 'release; exit 130' INT
trap 'release; exit 143' TERM

# Takes the lock folder $1, freeing it first if the process that made it has gone.
take() {
  if mkdir "$1" 2>/dev/null; then
    printf '%s\n%s\n%s\n' "$$" "$label" "$PWD" >"$1/owner"
    held="$held $1"
    return 0
  fi
  owner="$(head -n 1 "$1/owner" 2>/dev/null || true)"
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    rm -rf "$1"
    take "$1"
    return $?
  fi
  return 1
}

# Who holds what, for the waiting message.
holders() {
  for owner in "$dir"/*/owner; do
    [ -f "$owner" ] || continue
    sed -n '2p;3p' "$owner" | paste -sd ' ' -
  done
}

waited=0
while :; do
  got=''
  i=1
  while [ "$i" -le "$slots" ]; do
    if take "$dir/slot-$i"; then
      got=1
      break
    fi
    i=$((i + 1))
  done
  [ -n "$got" ] && break
  if [ "$waited" -eq 0 ]; then
    echo "[heavy] $label waits for a free slot (PENMOSS_HEAVY_SLOTS=$slots). Running now:" >&2
    holders | sort -u | sed 's/^/[heavy]   /' >&2
  fi
  waited=$((waited + 5))
  sleep 5
done
if [ "$waited" -gt 0 ]; then
  echo "[heavy] $label starts after waiting ${waited}s" >&2
fi

status=0
PENMOSS_HEAVY_HELD=1 "$@" || status=$?
exit "$status"
