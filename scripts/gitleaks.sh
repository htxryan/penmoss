#!/usr/bin/env bash
# gitleaks, pinned and checksummed (T80.1, A1185): runs the gitleaks this repository expects,
# downloading it from its GitHub release into a cache the first time. Arguments go to gitleaks.
# `task audit:secrets` scans the tree; `task audit:secrets -- --history` every commit.
set -euo pipefail

VERSION=8.30.1
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=darwin_arm64 sum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  Darwin-x86_64) asset=darwin_x64 sum=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  # CI's Check job runs on a hosted Ubuntu runner (A1235).
  Linux-x86_64) asset=linux_x64 sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  *) echo "gitleaks.sh: no pinned gitleaks for $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac

if command -v gitleaks >/dev/null && [ "$(gitleaks version 2>/dev/null)" = "$VERSION" ]; then
  exec gitleaks "$@"
fi

cache="${PENMOSS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/penmoss}/gitleaks-$VERSION"
bin="$cache/gitleaks"
if [ ! -x "$bin" ]; then
  if [ -z "$sum" ]; then echo "gitleaks.sh: no checksum for $asset; install gitleaks $VERSION" >&2; exit 2; fi
  mkdir -p "$cache"
  tarball="$cache/gitleaks_${VERSION}_${asset}.tar.gz"
  curl -fsSL --retry 3 -o "$tarball" \
    "https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/gitleaks_${VERSION}_${asset}.tar.gz"
  echo "$sum  $tarball" | shasum -a 256 -c - >/dev/null
  tar -xzf "$tarball" -C "$cache" gitleaks
  rm -f "$tarball"
fi
exec "$bin" "$@"
