#!/usr/bin/env bash
# Build the T2 spike: web bundle → app assets → debug APK + androidTest APK.
#   ./build.sh            web bundle + assembleDebug + assembleDebugAndroidTest
#   ./build.sh --web-only only rebuild and copy the web bundle
# Needs Node 24 + corepack (pnpm), JDK 21+ and an Android SDK (ANDROID_HOME, default ~/Android/sdk).
set -euo pipefail
cd "$(dirname "$0")"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/sdk}"
# Gradle needs a full JDK (javac). On the agent worker the system Java 25 is a JRE,
# so fall back to the Temurin 21 JDK in ~/opt/jdk-21 when JAVA_HOME is unset.
if [[ -z "${JAVA_HOME:-}" && -x "$HOME/opt/jdk-21/bin/javac" ]]; then
  export JAVA_HOME="$HOME/opt/jdk-21"
fi

(cd web && pnpm install --frozen-lockfile && pnpm build)
rm -rf app/src/main/assets/editor
mkdir -p app/src/main/assets/editor
cp web/dist/index.html web/dist/editor.js web/dist/editor.css app/src/main/assets/editor/
echo "Copied editor bundle to app/src/main/assets/editor/"

[[ "${1:-}" == "--web-only" ]] && exit 0

# --no-daemon keeps memory free on the shared worker; never run two builds at once.
./gradlew --no-daemon assembleDebug assembleDebugAndroidTest
ls -l app/build/outputs/apk/debug/app-debug.apk app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
