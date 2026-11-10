#!/bin/sh
# Android proof for the software factory (F8, FD25), inside a slot's sandbox: build, then boot
# the slot's own headless emulator, run the named instrumented tests with screenrecord running,
# keep the screenshot each test took with ProofShot.take() (or take one after it), and shut the
# emulator down. Writes apps/android/build/proof/report.json.
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
# Where a test's ProofShot.take() leaves the screenshot (androidTest app.penmoss.proof, A1255).
PROOF_SHOT=/sdcard/penmoss-proof.png
# Where a validation walkthrough's ProofShot.capture(name) leaves its screenshots (PEN-94).
WALK_SHOTS=/sdcard/penmoss-walk
RUNNER="$APP.test/androidx.test.runner.AndroidJUnitRunner"
# How long a video runs on after the test's ProofShot.take(), before the test closes the app.
HOLD_SECONDS="${PENMOSS_PROOF_HOLD_SECONDS:-0.5}"

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
watcher=''
cleanup() {
  [ -z "$watcher" ] || kill "$watcher" 2>/dev/null || true
  "$ADB" -s "$ANDROID_SERIAL" emu kill >/dev/null 2>&1 || true
  if [ -n "$emulator_pid" ]; then
    sleep 2
    kill "$emulator_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# The window that has the input focus now, as dumpsys names it.
focus_now() {
  "$ADB" -s "$ANDROID_SERIAL" shell dumpsys window displays 2>/dev/null |
    sed -n 's/.*mCurrentFocus=//p' | head -n 1 | tr -d '\r'
}

# An "isn't responding" dialog after a slow boot, the launcher's or System UI's, can stay until
# someone answers it (PEN-90): settling then waited out SETTLE_SECONDS. Answer it with Wait, at
# most every 5 s. Wait leaves the process running; Close app, like hiding error dialogs, would
# restart it, and a restarted System UI recreates the activity under test. $1 says when.
pressed=-10
press_wait() {
  [ $((waited - pressed)) -ge 5 ] || return 0
  pressed=$waited
  "$ADB" -s "$ANDROID_SERIAL" shell uiautomator dump /sdcard/proof-ui.xml >/dev/null 2>&1 || return 0
  # The Wait button's bounds, as "x1 y1 x2 y2", whatever the device's language.
  bounds="$("$ADB" -s "$ANDROID_SERIAL" exec-out cat /sdcard/proof-ui.xml 2>/dev/null | tr '>' '\n' |
    sed -n 's/.*resource-id="android:id\/aerr_wait".*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p' |
    head -n 1)"
  [ -n "$bounds" ] || return 0
  # Still in front: a dialog that closed meanwhile mustn't turn the tap into one on the app.
  case "$(focus_now)" in *'Not Responding'*) ;; *) return 0 ;; esac
  x="$(echo "$bounds" | awk '{ print int(($1 + $3) / 2) }')"
  y="$(echo "$bounds" | awk '{ print int(($2 + $4) / 2) }')"
  "$ADB" -s "$ANDROID_SERIAL" shell input tap "$x" "$y" >/dev/null 2>&1 || return 0
  echo "[proof] $(echo "$focus" | sed 's/.*Not Responding: \([^}]*\).*/\1/') wasn't responding $1: pressed Wait"
}

# On a loaded Mac the launcher can stop responding again while a test runs, and its dialog then
# covers the app and takes the test's keys (PEN-96). While a test runs, look every 3 s.
watch_dialogs() {
  waited=0
  pressed=-10
  while :; do
    focus="$(focus_now)"
    case "$focus" in *'Not Responding'*) press_wait "during $1" ;; esac
    sleep 3
    waited=$((waited + 3))
  done
}

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
# under test (a test's typed keys land in the dialog). So: wait for the broadcasts to drain,
# then for the launcher to hold the focus, with no dialog in front, for QUIET_SECONDS in a row,
# answering any "isn't responding" dialog with Wait (press_wait). Hiding error dialogs instead
# is worse: Android then restarts System UI, whose theme overlays change the configuration and
# recreate the activity under test.
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
  focus="$(focus_now)"
  case "$focus" in
    *'Not Responding'*) quiet=0 && press_wait "after ${waited}s" ;;
    *'Application Error'*) quiet=0 ;;
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
  "$ADB" -s "$ANDROID_SERIAL" shell rm -rf /sdcard/proof.mp4 "$PROOF_SHOT" "$WALK_SHOTS"
  "$ADB" -s "$ANDROID_SERIAL" shell mkdir -p "$WALK_SHOTS"
  # The device's clock as the recording starts, against which ProofShot logs its moment.
  started="$("$ADB" -s "$ANDROID_SERIAL" shell cat /proc/uptime 2>/dev/null | awk '{ print $1 }')"
  "$ADB" -s "$ANDROID_SERIAL" shell screenrecord --time-limit "$TEST_SECONDS" /sdcard/proof.mp4 &
  rec=$!
  sleep 1
  echo "[proof] $spec"
  watch_dialogs "$spec" &
  watcher=$!
  result="$("$ADB" -s "$ANDROID_SERIAL" shell am instrument -w -e class "$spec" "$RUNNER" 2>&1 || true)"
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  watcher=''
  printf '%s\n' "$result" >"$OUT/android-$n.log"
  # The screenshot the test took at its last assertion, with the change on screen (ProofShot).
  # Without one, the screen now, after the test closed the app: likely the launcher.
  if ! "$ADB" -s "$ANDROID_SERIAL" pull "$PROOF_SHOT" "$OUT/$shot" >/dev/null 2>&1; then
    echo "[proof] $spec took no screenshot of its own (ProofShot.take() at its last assertion); this one is from after it closed the app" >&2
    "$ADB" -s "$ANDROID_SERIAL" exec-out screencap -p >"$OUT/$shot" || true
  fi
  # A walkthrough's screenshots, one per criterion, by the names it gave them.
  for name in $("$ADB" -s "$ANDROID_SERIAL" shell ls "$WALK_SHOTS" 2>/dev/null | tr -d '\r'); do
    case "$name" in
      *[!A-Za-z0-9_.-]*) continue ;;
      *.png) mkdir -p "$OUT/walk" && "$ADB" -s "$ANDROID_SERIAL" pull "$WALK_SHOTS/$name" "$OUT/walk/$name" >/dev/null 2>&1 || true ;;
    esac
  done
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
  # A video that ran on after the test closed the app ends on the launcher (PEN-91): cut it
  # HOLD_SECONDS after the test's last ProofShot.take(), which logs its device time.
  shot_at="$(sed -n 's/.*PenmossProof: shot at \([0-9]*\).*/\1/p' "$OUT/android-$n.logcat" | tail -n 1)"
  if [ -n "$shot_at" ] && [ -n "$started" ] && [ -s "$OUT/$video" ]; then
    length="$(awk -v at="$shot_at" -v from="$started" -v hold="$HOLD_SECONDS" \
      'BEGIN { t = at / 1000 - from + hold; if (t > 0) printf "%.3f", t }')"
    if [ -z "$length" ]; then
      :
    elif ! command -v ffmpeg >/dev/null 2>&1; then
      echo "[proof] no ffmpeg to end $video at its screenshot; it runs on after the test" >&2
    elif ffmpeg -nostdin -loglevel error -y -i "$OUT/$video" -t "$length" -c copy "$OUT/cut-$video" &&
      [ -s "$OUT/cut-$video" ]; then
      mv "$OUT/cut-$video" "$OUT/$video"
      echo "[proof] $video ends ${length}s in, at its screenshot"
    else
      rm -f "$OUT/cut-$video"
      echo "[proof] ffmpeg couldn't cut $video; it runs on after the test" >&2
    fi
  fi
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
