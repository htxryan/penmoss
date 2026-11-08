#!/bin/bash
# Every Mach-O file in a Mac app is universal (P7, A1186): the main executable, the helper apps,
# every framework and library, and the owner check (T41, A504). CI's mac job runs it on the app
# it packaged; it fails, naming the files, if any lacks arm64 or x86_64.
#
#   bash .github/scripts/mac-archs.sh apps/desktop/release/mac-universal/Penmoss.app
set -euo pipefail

app="${1:?usage: mac-archs.sh <Penmoss.app>}"
main="$app/Contents/MacOS/Penmoss"
helper="$app/Contents/Resources/auth/Penmoss"

# Both architectures in one file, as lipo lists them ("x86_64 arm64").
universal() {
  local archs
  archs="$(lipo -archs "$1" 2> /dev/null)" || return 1
  [[ " $archs " == *" arm64 "* && " $archs " == *" x86_64 "* ]]
}

for named in "$main" "$helper"; do
  if [ ! -f "$named" ]; then
    echo "::error::Missing: $named"
    exit 1
  fi
  echo "${named#"$app"/}: $(lipo -archs "$named")"
done

checked=0
missing=()
while IFS= read -r -d '' file; do
  # Mach-O only: executables, dylibs, framework binaries, bundles. Not scripts, not data.
  case "$(file -b "$file")" in
    Mach-O*) ;;
    *) continue ;;
  esac
  checked=$((checked + 1))
  if ! universal "$file"; then missing+=("${file#"$app"/} ($(lipo -archs "$file" 2>&1))"); fi
done < <(find "$app" -type f -print0)

if [ "${#missing[@]}" -ne 0 ]; then
  echo "::error::${#missing[@]} of $checked Mach-O files lack arm64 or x86_64:"
  printf '  %s\n' "${missing[@]}"
  exit 1
fi
echo "All $checked Mach-O files in $(basename "$app") have arm64 and x86_64."
