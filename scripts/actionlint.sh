#!/usr/bin/env bash
# actionlint, pinned and checksummed (A1235): runs the actionlint this repository expects,
# downloading it from its GitHub release into a cache the first time, as scripts/gitleaks.sh does.
# Arguments go to actionlint. `task ci:lint` runs it over .github/workflows.
set -euo pipefail

VERSION=1.7.12
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=darwin_arm64 sum=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
  Darwin-x86_64) asset=darwin_amd64 sum=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
  Linux-x86_64) asset=linux_amd64 sum=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
  *) echo "actionlint.sh: no pinned actionlint for $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac

if command -v actionlint >/dev/null && [ "$(actionlint --version 2>/dev/null | head -n 1)" = "$VERSION" ]; then
  exec actionlint "$@"
fi

cache="${PENMOSS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/penmoss}/actionlint-$VERSION"
bin="$cache/actionlint"
if [ ! -x "$bin" ]; then
  mkdir -p "$cache"
  tarball="$cache/actionlint_${VERSION}_${asset}.tar.gz"
  curl -fsSL --retry 3 -o "$tarball" \
    "https://github.com/rhysd/actionlint/releases/download/v$VERSION/actionlint_${VERSION}_${asset}.tar.gz"
  echo "$sum  $tarball" | shasum -a 256 -c - >/dev/null
  tar -xzf "$tarball" -C "$cache" actionlint
  rm -f "$tarball"
fi
exec "$bin" "$@"
