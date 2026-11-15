#!/usr/bin/env bash
# A tool this repository pins, checksummed (A1185, A1235): runs the version below, from the PATH
# when that is the one, or else downloaded from its GitHub release into a cache the first time.
#
#   scripts/pinned-tool.sh actionlint [args]   `task ci:lint` runs it over .github/workflows
#   scripts/pinned-tool.sh gitleaks [args]     `task audit:secrets` scans the tree with it
#
# Arguments after the name go to the tool. One table per tool: its version, how it says its
# version, where its release lives, and each platform's archive and SHA-256.
set -euo pipefail

name="${1:-}"
shift || true
platform="$(uname -s)-$(uname -m)"
case "$name" in
  actionlint)
    VERSION=1.7.12
    version_cmd=(--version)
    url="https://github.com/rhysd/actionlint/releases/download/v$VERSION/actionlint_${VERSION}"
    case "$platform" in
      Darwin-arm64) asset=darwin_arm64 sum=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
      Darwin-x86_64) asset=darwin_amd64 sum=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
      Linux-x86_64) asset=linux_amd64 sum=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
      *) asset='' ;;
    esac ;;
  gitleaks)
    VERSION=8.30.1
    version_cmd=(version)
    url="https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/gitleaks_${VERSION}"
    case "$platform" in
      Darwin-arm64) asset=darwin_arm64 sum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
      Darwin-x86_64) asset=darwin_x64 sum=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
      # CI's Check job runs on a hosted Ubuntu runner (A1235).
      Linux-x86_64) asset=linux_x64 sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
      *) asset='' ;;
    esac ;;
  *)
    echo "pinned-tool.sh: no pinned tool \"$name\" (actionlint, gitleaks)" >&2
    exit 2 ;;
esac
if [ -z "$asset" ]; then
  echo "pinned-tool.sh: no pinned $name for $platform; install $name $VERSION" >&2
  exit 2
fi

if command -v "$name" >/dev/null && [ "$("$name" "${version_cmd[@]}" 2>/dev/null | head -n 1)" = "$VERSION" ]; then
  exec "$name" "$@"
fi

cache="${PENMOSS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/penmoss}/$name-$VERSION"
bin="$cache/$name"
if [ ! -x "$bin" ]; then
  mkdir -p "$cache"
  tarball="$cache/${name}_${VERSION}_${asset}.tar.gz"
  curl -fsSL --retry 3 -o "$tarball" "${url}_${asset}.tar.gz"
  echo "$sum  $tarball" | shasum -a 256 -c - >/dev/null
  tar -xzf "$tarball" -C "$cache" "$name"
  rm -f "$tarball"
fi
exec "$bin" "$@"
