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
#
# The tools' packages are kept in PENMOSS_DEB_CACHE (~/.cache/penmoss-ci/debs, which ci.yml
# caches) and installed from there with dpkg, so a job whose image lacks a tool needs apt's
# mirror only when the cache is empty or no longer installs (PEN-114: the Electron job's
# xdotool failed every run while the mirror was down).
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

[ -n "$packages" ] || exit 0

debs=${PENMOSS_DEB_CACHE:-$HOME/.cache/penmoss-ci/debs}
cached=$(find "$debs" -maxdepth 1 -name '*.deb' 2>/dev/null | sort | tr '\n' ' ')
# shellcheck disable=SC2086 # one word per file
if [ -n "$cached" ] && sudo dpkg -i $cached; then
  echo "Installed$packages from the cache of their packages: no apt."
  exit 0
fi
if [ -n "$cached" ]; then
  echo "The cached packages don't install on this image: from apt instead."
  rm -f "$debs"/*.deb
  fix=-f
else
  fix=
fi
echo "Installing$packages from apt, and keeping their packages in $debs."
mkdir -p "$debs/partial"
sudo apt-get update
# shellcheck disable=SC2086 # one word per package; $fix is empty or -f
sudo apt-get install -y --no-install-recommends $fix -o Dir::Cache::Archives="$debs" $packages
