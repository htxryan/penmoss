#!/bin/sh
# Android proof for the software factory (F8, FD25), inside a slot's sandbox: build, then boot
# the slot's own headless emulator, run the named instrumented tests with screenrecord running,
# take a screenshot, and shut the emulator down. Writes apps/android/build/proof/report.json.
#
#   task proof:android -- app.penmoss.editor.TypingInstrumentedTest[#method] …
#
# The sandbox sets the slot's PENMOSS_AVD, PENMOSS_EMULATOR_PORT, ANDROID_SERIAL,
# ANDROID_ADB_SERVER_PORT, ANDROID_AVD_HOME and ANDROID_HOME. Settings from F0.4: software
# rendering through ANGLE (-gpu swiftshader_indirect -feature -Vulkan), the emulator's temp
# files in the sandbox's own temp folder, and the build before the boot, since a Gradle build
# beside a software-rendered emulator stops System UI responding.
set -eu
: "${PENMOSS_AVD:?the AVD of this slot, set by the factory sandbox}"
: "${PENMOSS_EMULATOR_PORT:?the emulator port of this slot}"
: "${ANDROID_HOME:?the Android SDK}"
export ANDROID_SERIAL="emulator-$PENMOSS_EMULATOR_PORT"
export ANDROID_TMP="${TMPDIR:-/tmp}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/proof"
ADB="$ANDROID_HOME/platform-tools/adb"
BOOT_SECONDS="${PENMOSS_EMULATOR_BOOT_SECONDS:-240}"
TEST_SECONDS="${PENMOSS_PROOF_TEST_SECONDS:-170}"
SETTLE_SECONDS="${PENMOSS_EMULATOR_SETTLE_SECONDS:-240}"
QUIET_SECONDS="${PENMOSS_EMULATOR_QUIET_SECONDS:-10}"
APP=app.penmoss.debug
RUNNER="$APP.test/androidx.test.runner.AndroidJUnitRunner"

[ "$#" -gt 0 ] || { echo 'proof.sh: name at least one instrumented test class' >&2; exit 2; }
for spec in "$@"; do
  case "$spec" in
    *[!A-Za-z0-9_.#]*) echo "proof.sh: not a test class: $spec" >&2; exit 2 ;;
  esac
done
rm -rf "$OUT"
mkdir -p "$OUT"

echo "[proof] building the debug and test APKs"
(cd "$ROOT" && ./gradlew --console=plain -q :app:assembleDebug :app:assembleDebugAndroidTest)

emulator_pid=''
cleanup() {
  "$ADB" -s "$ANDROID_SERIAL" emu kill >/dev/null 2>&1 || true
  if [ -n "$emulator_pid" ]; then
    sleep 2
    kill "$emulator_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[proof] booting $PENMOSS_AVD on $ANDROID_SERIAL"
"$ANDROID_HOME/emulator/emulator" -avd "$PENMOSS_AVD" -port "$PENMOSS_EMULATOR_PORT" \
  -no-window -no-audio -no-boot-anim -no-snapshot -no-metrics \
  -gpu swiftshader_indirect -feature -Vulkan -crash-report-mode disabled \
  >"$OUT/emulator.log" 2>&1 &
emulator_pid=$!

waited=0
until [ "$("$ADB" -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do
  if ! kill -0 "$emulator_pid" 2>/dev/null; then
    echo "[proof] the emulator exited; see $OUT/emulator.log" >&2
    exit 1
  fi
  if [ "$waited" -ge "$BOOT_SECONDS" ]; then
    echo "[proof] the emulator didn't boot in ${BOOT_SECONDS}s; see $OUT/emulator.log" >&2
    exit 1
  fi
  sleep 3
  waited=$((waited + 3))
done
echo "[proof] booted in ${waited}s"
"$ADB" -s "$ANDROID_SERIAL" shell settings put global window_animation_scale 0
"$ADB" -s "$ANDROID_SERIAL" shell settings put global transition_animation_scale 0
"$ADB" -s "$ANDROID_SERIAL" shell settings put global animator_duration_scale 0

# Let the device settle before any test. Booted is not idle: the boot's broadcasts keep a
# software-rendered emulator on a loaded Mac busy for a minute or more, System UI can stop
# responding meanwhile, and its "isn't responding" dialog takes the input focus from the app
# under test (a test's typed keys land in the dialog). Android closes that dialog itself once
# System UI responds again. So: wait for the broadcasts to drain, then for the launcher to
# hold the focus, with no dialog in front, for QUIET_SECONDS in a row. Hiding error dialogs
# instead is worse: Android then restarts System UI, whose theme overlays change the
# configuration and recreate the activity under test.
"$ADB" -s "$ANDROID_SERIAL" shell am wait-for-broadcast-idle >/dev/null 2>&1 &
idle=$!
waited=0
while kill -0 "$idle" 2>/dev/null && [ "$waited" -lt "$SETTLE_SECONDS" ]; do
  sleep 1
  waited=$((waited + 1))
done
kill "$idle" 2>/dev/null || true
quiet=0
focus=''
while [ "$quiet" -lt "$QUIET_SECONDS" ]; do
  if [ "$waited" -ge "$SETTLE_SECONDS" ]; then
    echo "[proof] the emulator didn't settle in ${SETTLE_SECONDS}s; the focus is on: ${focus:-nothing}" >&2
    break
  fi
  focus="$("$ADB" -s "$ANDROID_SERIAL" shell dumpsys window displays 2>/dev/null |
    sed -n 's/.*mCurrentFocus=//p' | head -n 1 | tr -d '\r')"
  case "$focus" in
    *'Not Responding'* | *'Application Error'*) quiet=0 ;;
    *Launcher*) quiet=$((quiet + 1)) ;;
    *) quiet=0 ;;
  esac
  sleep 1
  waited=$((waited + 1))
done
echo "[proof] settled in ${waited}s"

# The AVD keeps the last run's app, signed with that sandbox's own debug key: remove it first.
"$ADB" -s "$ANDROID_SERIAL" uninstall "$APP.test" >/dev/null 2>&1 || true
"$ADB" -s "$ANDROID_SERIAL" uninstall "$APP" >/dev/null 2>&1 || true
"$ADB" -s "$ANDROID_SERIAL" install -r -t "$ROOT/app/build/outputs/apk/debug/app-debug.apk" >/dev/null
"$ADB" -s "$ANDROID_SERIAL" install -r -t "$ROOT/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk" >/dev/null

printf '[' >"$OUT/report.json"
n=0
for spec in "$@"; do
  n=$((n + 1))
  video="android-$n.mp4"
  shot="android-$n.png"
  "$ADB" -s "$ANDROID_SERIAL" shell rm -f /sdcard/proof.mp4
  "$ADB" -s "$ANDROID_SERIAL" shell screenrecord --time-limit "$TEST_SECONDS" /sdcard/proof.mp4 &
  rec=$!
  sleep 1
  echo "[proof] $spec"
  result="$("$ADB" -s "$ANDROID_SERIAL" shell am instrument -w -e class "$spec" "$RUNNER" 2>&1 || true)"
  printf '%s\n' "$result" >"$OUT/android-$n.log"
  "$ADB" -s "$ANDROID_SERIAL" exec-out screencap -p >"$OUT/$shot" || true
  # The device's log since the last test (since the boot, for the first), to diagnose a failure.
  # Through exec-out and shell, which fail at once without the device: `adb logcat` would wait
  # for an emulator that crashed forever.
  "$ADB" -s "$ANDROID_SERIAL" exec-out logcat -d -v threadtime >"$OUT/android-$n.logcat" 2>&1 || true
  "$ADB" -s "$ANDROID_SERIAL" shell logcat -c >/dev/null 2>&1 || true
  kill -0 "$emulator_pid" 2>/dev/null ||
    echo "[proof] the emulator exited during $spec; see $OUT/emulator.log" >&2
  # screenrecord finishes its file on SIGINT.
  "$ADB" -s "$ANDROID_SERIAL" shell pkill -INT screenrecord >/dev/null 2>&1 || true
  wait "$rec" 2>/dev/null || true
  sleep 2
  "$ADB" -s "$ANDROID_SERIAL" pull /sdcard/proof.mp4 "$OUT/$video" >/dev/null 2>&1 || true
  status=failed
  case "$result" in *"OK ("*) status=passed ;; esac
  [ "$n" -gt 1 ] && printf ',' >>"$OUT/report.json"
  printf '{"title":"%s","status":"%s","video":"%s","screenshot":"%s"}' \
    "$spec" "$status" "$video" "$shot" >>"$OUT/report.json"
  echo "[proof] $spec: $status"
  # A failure's own words, so a log of this run says why without the build folder.
  [ "$status" = passed ] || tail -n 40 "$OUT/android-$n.log"
done
printf ']\n' >>"$OUT/report.json"
