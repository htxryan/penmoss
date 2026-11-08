#!/bin/bash
# Checks the Mac app CI packaged (A403, A1015, A1112, P7): the signature, Gatekeeper's verdict,
# the owner check, both architectures in every binary, the update feed and the dmg. Run by the
# mac job after `task desktop:package`, from the repository root:
#
#   RUN=<build> VERSION=<app version> HAS_CERTIFICATE=true|false [NOTARISED=true] \
#     bash .github/scripts/mac-check.sh
#
# NOTARISED=true (release.yml, a stable release; A1189) fails unless Gatekeeper calls the app,
# and the copy in the dmg, "Notarized Developer ID" and the ticket is stapled to it.
# VERSION (P5) defaults to 0.1.<build>. An alpha version (a main build) has `alpha-mac.yml`
# naming penmoss-mac-<build>.zip; any other has `latest-mac.yml` naming penmoss-mac-<version>.zip
# (P2, P6). The dmg is renamed to penmoss-mac-<build>.dmg if electron-builder named it otherwise.
set -euo pipefail

: "${RUN:?set RUN to the build number}"
HAS_CERTIFICATE="${HAS_CERTIFICATE:-false}"
NOTARISED="${NOTARISED:-false}"
VERSION="${VERSION:-0.1.$RUN}"
if [[ "$VERSION" == *-alpha.* ]]; then
  feed_name=alpha-mac.yml
  zip_name="penmoss-mac-$RUN.zip"
  feed_url='https://github.com/htxryan/penmoss/releases/download/alpha'
elif [ "$VERSION" = "0.1.$RUN" ]; then
  feed_name=latest-mac.yml
  zip_name="penmoss-mac-$RUN.zip"
  feed_url='https://github.com/htxryan/penmoss/releases/latest/download'
else
  feed_name=latest-mac.yml
  zip_name="penmoss-mac-$VERSION.zip"
  feed_url='https://github.com/htxryan/penmoss/releases/latest/download'
fi
release=apps/desktop/release
scripts="$(cd "$(dirname "$0")" && pwd)"
temp="${RUNNER_TEMP:-$(mktemp -d)}"

shopt -s nullglob
apps=("$release"/mac*/Penmoss.app)
dmgs=("$release"/*.dmg)
if [ "${#apps[@]}" -ne 1 ] || [ "${#dmgs[@]}" -ne 1 ]; then
  echo "::error::Expected one app and one dmg, found: ${apps[*]} ${dmgs[*]}"
  exit 1
fi
app="${apps[0]}"
dmg="$release/penmoss-mac-$RUN.dmg"
if [ "${dmgs[0]}" != "$dmg" ]; then mv "${dmgs[0]}" "$dmg"; fi

codesign --verify --deep --strict --verbose=2 "$app"
codesign --display --verbose=2 "$app" 2>&1 | tee "$temp/codesign.txt"
if [ "$HAS_CERTIFICATE" != true ] && ! grep -qx 'Signature=adhoc' "$temp/codesign.txt"; then
  echo "::error::Without a certificate secret the app must be signed ad hoc."
  exit 1
fi
codesign --display --entitlements - "$app"
test "$(plutil -extract CFBundleVersion raw "$app/Contents/Info.plist")" = "$RUN"

# Universal (P7): the main executable, the owner check and every other binary have both
# architectures.
bash "$scripts/mac-archs.sh" "$app"

# The owner check (T41, A504): shipped, signed with the app, and it runs. Without a reason it
# exits 64 and shows nothing.
helper="$app/Contents/Resources/auth/Penmoss"
test -x "$helper"
codesign --verify --strict --verbose=2 "$helper"
codesign --display --verbose=2 "$helper"
set +e
"$helper"
status=$?
set -e
if [ "$status" -ne 64 ]; then
  echo "::error::The owner check should exit 64 without a reason; it exited $status."
  exit 1
fi
# Gatekeeper's verdict. A stable release must be notarised: the job fails rather than publish a
# dmg spctl does not accept as notarised (A1189).
notarised() {
  local verdict
  verdict="$(spctl --assess --type execute -vv "$1" 2>&1)" || {
    echo "$verdict"
    echo "::error::Gatekeeper rejects $1."
    return 1
  }
  echo "$verdict"
  grep -q 'source=Notarized Developer ID' <<< "$verdict" || {
    echo "::error::$1 is not notarised (spctl: ${verdict//$'\n'/ })."
    return 1
  }
  xcrun stapler validate "$1"
}
if [ "$NOTARISED" = true ]; then
  notarised "$app"
else
  spctl -a -vv "$app" || echo "Gatekeeper rejects it, as expected for an app Apple has not notarised."
fi

# The version (P5): About Penmoss shows it, and updates compare it.
test "$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")" = "$VERSION"

# The update feed (P6, A1188): a signed build has the zip electron-updater downloads and the
# channel's feed naming it, for GitHub Releases; an unsigned one has no feed.
feed="$release/$feed_name"
if [ "$HAS_CERTIFICATE" = true ]; then
  test -f "$release/$zip_name"
  grep -Eq "^version: '?${VERSION//./\\.}'?$" "$feed"
  grep -Eq "^ *-? *url: ${zip_name//./\\.}$" "$feed"
  grep -qx 'provider: generic' "$app/Contents/Resources/app-update.yml"
  grep -Eq "^url: '?${feed_url//./\\.}/?'?$" "$app/Contents/Resources/app-update.yml"
else
  test ! -e "$app/Contents/Resources/app-update.yml"
  rm -f "$release/latest-mac.yml" "$release/alpha-mac.yml"
fi

hdiutil verify "$dmg"
mount="$(mktemp -d)"
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$dmg"
trap 'hdiutil detach "$mount" -quiet || hdiutil detach "$mount" -force -quiet; rmdir "$mount"' EXIT
ls -la "$mount"
test -L "$mount/Applications"
codesign --verify --deep --strict --verbose=2 "$mount/Penmoss.app"
test -x "$mount/Penmoss.app/Contents/Resources/auth/Penmoss"
bash "$scripts/mac-archs.sh" "$mount/Penmoss.app"
if [ "$NOTARISED" = true ]; then notarised "$mount/Penmoss.app"; fi
ls -l "$dmg"
