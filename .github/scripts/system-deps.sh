#!/bin/sh
# Chromium's system libraries, and any tools a job names, from apt only when the runner's image
# lacks them (A1308). GitHub's Ubuntu image ships Google Chrome, so Chromium's libraries are
# normally there already; apt has stalled for minutes (A620, A623) and on 11 Nov 2026 couldn't
# resolve its mirror for hours, failing every job that asked it for packages it didn't need.
#
#   sh .github/scripts/system-deps.sh <pnpm filter> [command:package ...]
#
# The filter names the package whose Playwright installs the libraries when some are missing
# (`playwright install-deps chromium`). Each `command:package` is a tool the job runs: its
# package is installed only when the command isn't on PATH. The check is `ldd` on Playwright's
# Chromium and on Electron, when they're installed: a library it can't find means apt runs.
set -eu

filter=$1
shift

browsers=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}
binaries=$(
  {
    find "$browsers" -type f \( -name chrome -o -name chrome-headless-shell \) 2>/dev/null
    find node_modules/.pnpm -path '*/electron/dist/electron' -type f 2>/dev/null
  } || true
)

missing=""
for binary in $binaries; do
  missing="$missing$(ldd "$binary" 2>/dev/null | awk '/not found/ { print $1 }')
"
done
missing=$(printf '%s' "$missing" | sort -u | sed '/^$/d')

packages=""
for pair in "$@"; do
  command -v "${pair%%:*}" >/dev/null 2>&1 || packages="$packages ${pair#*:}"
done

if [ -z "$binaries" ]; then
  echo "No Chromium or Electron to check: installing Chromium's libraries from apt."
  pnpm --filter "$filter" exec playwright install-deps chromium
elif [ -n "$missing" ]; then
  echo "The image lacks: $(echo "$missing" | tr '\n' ' ')- installing Chromium's libraries from apt."
  pnpm --filter "$filter" exec playwright install-deps chromium
else
  echo "The image has every library Chromium and Electron load: no apt for them."
fi

if [ -n "$packages" ]; then
  echo "Installing$packages from apt."
  sudo apt-get update
  # shellcheck disable=SC2086 # one word per package
  sudo apt-get install -y --no-install-recommends $packages
fi
