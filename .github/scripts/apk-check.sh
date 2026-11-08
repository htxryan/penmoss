#!/bin/bash
# The public APK (P8, A1187) is fit to hand out: the release build of app.penmoss, not
# debuggable, signed with APK Signature Scheme v2 or later by the sideload key's certificate and
# nothing else. CI runs it on every APK it publishes; it fails, saying why, otherwise.
#
#   bash .github/scripts/apk-check.sh <app-release.apk> [<certificate SHA-256>]
#
# The certificate defaults to the sideload key's (A400, A594; docs/android.md). PENMOSS_VERSION_CODE,
# when set, must be the APK's versionCode. apksigner and aapt2 come from the newest build tools
# under ANDROID_HOME.
set -euo pipefail

apk="${1:?usage: apk-check.sh <apk> [<certificate SHA-256>]}"
expected="${2:-D8:DF:91:2B:2D:00:26:73:EF:78:33:72:AF:F7:CD:6C:CB:E9:31:6B:BB:5F:24:C4:58:42:72:9F:56:2B:2D:A0}"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/sdk}}"
tools="$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d 2> /dev/null | sort -V | tail -n 1)"
if [ -z "$tools" ] || [ ! -x "$tools/apksigner" ] || [ ! -x "$tools/aapt2" ]; then
  echo "::error::No build tools with apksigner and aapt2 under $sdk/build-tools"
  exit 1
fi
fail() {
  echo "::error::$apk: $1"
  exit 1
}
# Upper case, no colons: how the two tools and docs/android.md print it differ only in that.
normal() { tr -d ':[:space:]' <<< "$1" | tr '[:lower:]' '[:upper:]'; }

signature="$("$tools/apksigner" verify --verbose --print-certs "$apk")" || fail 'apksigner does not verify it'
echo "$signature" | grep -E '^Verified using|certificate SHA-256 digest|^Number of signers'
grep -Eq '^Verified using v(2|3|3\.1|4) scheme .*: true$' <<< "$signature" ||
  fail 'not signed with APK Signature Scheme v2 or later'
grep -qx 'Number of signers: 1' <<< "$signature" || fail 'it must have exactly one signer'
# "Signer #1 certificate SHA-256 digest: …", or "V2 Signer: certificate …" for a v2-only APK:
# every line must name the same certificate.
actual="$(sed -n -E 's/^(Signer #1|V[0-9.]+ Signer):? certificate SHA-256 digest: //p' <<< "$signature" | sort -u)"
if [ -z "$actual" ] || [ "$(wc -l <<< "$actual" | tr -d ' ')" -ne 1 ] ||
  [ "$(normal "$actual")" != "$(normal "$expected")" ]; then
  fail "signed by certificate SHA-256 $actual, not the sideload key's $expected"
fi

badging="$("$tools/aapt2" dump badging "$apk")"
package="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<< "$badging")"
code="$(sed -n "s/^package: .* versionCode='\([^']*\)'.*/\1/p" <<< "$badging")"
name="$(sed -n "s/^package: .* versionName='\([^']*\)'.*/\1/p" <<< "$badging")"
echo "package $package, versionCode $code, versionName $name"
[ "$package" = app.penmoss ] || fail "its application id is $package, not app.penmoss"
if grep -q '^application-debuggable' <<< "$badging"; then fail 'it is debuggable'; fi
if [ -n "${PENMOSS_VERSION_CODE:-}" ] && [ "$code" != "$PENMOSS_VERSION_CODE" ]; then
  fail "its versionCode is $code, not $PENMOSS_VERSION_CODE"
fi
echo "$(basename "$apk"): app.penmoss $name ($code), not debuggable, signed by $expected"
