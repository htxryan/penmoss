#!/usr/bin/env bash
# CI's Android emulator (F9, A1227): the `android-emulator` job runs the app's instrumented tests
# (apps/android/app/src/androidTest) on a headless API 37 emulator on one of the Mac runners.
#
#   bash .github/scripts/android-emulator.sh avd    make this runner's AVD, once, in its tool cache
#   bash .github/scripts/android-emulator.sh test   boot it on emulator-5580, run the tests, kill it
#   bash .github/scripts/android-emulator.sh stop   kill this runner's emulator and adb, if left
#
# Always console port 5580 (emulator-5580) and adb server port 5050: never the factory's slots
# (emulators 5560 and 5562, adb servers 5040 and 5041, docs/android.md) or the default 5037 that
# Ryan's own adb uses. The ports are fixed, so the runners on this Mac take turns: `test` waits
# for a lock (PENMOSS_EMULATOR_LOCK_SECONDS, 1500) before it starts anything. Every adb and
# Gradle call names emulator-5580 (ANDROID_SERIAL), so a slot's emulator, which this adb server
# can also see, is never touched. Settings from F0.4, as the factory's proof (proof.sh): software
# rendering through ANGLE, and the build before the boot, since a Gradle build beside a
# software-rendered emulator stops System UI responding.
set -euo pipefail

PORT=5580
ADB_PORT=5050
SERIAL="emulator-$PORT"
AVD=penmoss37-ci
IMAGE='system-images;android-37.0;google_apis;arm64-v8a'
APP=app.penmoss.debug
# NoteListJankTest measures 60 fps on the Pixel (A285). Software rendering on a shared Mac says
# nothing about that, as the web e2e job leaves the @perf frame-rate budgets to local runs.
NOT_ON_CI=app.penmoss.NoteListJankTest
BOOT_SECONDS="${PENMOSS_EMULATOR_BOOT_SECONDS:-300}"
REGISTER_SECONDS="${PENMOSS_EMULATOR_REGISTER_SECONDS:-60}"
LOCK="${PENMOSS_EMULATOR_LOCK:-/tmp/penmoss-ci-emulator-$PORT.lock}"
LOCK_SECONDS="${PENMOSS_EMULATOR_LOCK_SECONDS:-1500}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${PENMOSS_EMULATOR_LOG:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/emulator.log}"

say() { echo "[emulator] $*"; }
fail() {
  echo "::error::$*"
  exit 1
}

# The AVD folder is in this runner's tool cache (.github/actions/setup), so each runner keeps
# its own, made once.
sdk_env() {
  : "${ANDROID_HOME:?the Android SDK (.github/actions/android-sdk)}"
  export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-${PENMOSS_CACHE:?the runner tool cache (.github/actions/setup)}/android-avd}"
  export ANDROID_SERIAL="$SERIAL" ANDROID_ADB_SERVER_PORT="$ADB_PORT"
  export ANDROID_TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  ADB="$ANDROID_HOME/platform-tools/adb"
}

avd() {
  sdk_env
  if [ -f "$ANDROID_AVD_HOME/$AVD.ini" ] && [ -f "$ANDROID_AVD_HOME/$AVD.avd/config.ini" ]; then
    say "keeping $AVD in $ANDROID_AVD_HOME"
    return 0
  fi
  local avdmanager=''
  for candidate in "$ANDROID_HOME"/cmdline-tools/*/bin/avdmanager; do
    if [ -x "$candidate" ]; then avdmanager="$candidate"; fi
  done
  [ -n "$avdmanager" ] || fail "no avdmanager under $ANDROID_HOME/cmdline-tools"
  mkdir -p "$ANDROID_AVD_HOME"
  say "making $AVD from $IMAGE in $ANDROID_AVD_HOME"
  echo no | "$avdmanager" create avd --name "$AVD" --package "$IMAGE" --device pixel_7 --force
  # The phone the factory's slots use (tools/factory/src/avd.ts): Pixel-sized, enough RAM for
  # software rendering.
  printf '%s\n' hw.lcd.width=1080 hw.lcd.height=2400 hw.lcd.density=420 hw.ramSize=3072 \
    hw.keyboard=yes disk.dataPartition.size=6G hw.audioInput=no hw.gps=no \
    >> "$ANDROID_AVD_HOME/$AVD.avd/config.ini"
}

emulator_pid=''

# Stops what `test` started: the emulator through its console, then by pid, then adb's server.
stop_started() {
  if [ -n "$emulator_pid" ]; then
    "$ADB" -s "$SERIAL" emu kill > /dev/null 2>&1 || true
    local waited=0
    while kill -0 "$emulator_pid" 2> /dev/null && [ "$waited" -lt 20 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    kill -KILL "$emulator_pid" 2> /dev/null || true
    say "stopped $SERIAL"
  fi
  "$ADB" kill-server > /dev/null 2>&1 || true
}

registered() {
  "$ADB" devices 2> /dev/null | grep -q "^${SERIAL}[[:space:]]"
}

booted() {
  [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" = 1 ]
}

run_tests() {
  sdk_env
  [ -f "$ANDROID_AVD_HOME/$AVD.ini" ] || fail "no AVD $AVD in $ANDROID_AVD_HOME: run \`$0 avd\` first"
  if command -v lsof > /dev/null; then
    local holder
    holder="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2> /dev/null | head -n 1 || true)"
    [ -z "$holder" ] || fail "port $PORT is held by pid $holder, which this job did not start: leaving it"
  fi
  trap stop_started EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Whatever holds the adb port now is a CI leftover: this job holds the lock for both ports.
  "$ADB" kill-server > /dev/null 2>&1 || true
  # ADB_EMU=0: this server doesn't scan 5555-5585 for emulators, so it never connects to a
  # slot's. The emulator tells it about itself as it starts (ANDROID_ADB_SERVER_PORT).
  ADB_EMU=0 "$ADB" start-server

  say "booting $AVD on $SERIAL (adb server :$ADB_PORT); its log is $LOG"
  "$ANDROID_HOME/emulator/emulator" -avd "$AVD" -port "$PORT" \
    -no-window -no-audio -no-boot-anim -no-snapshot -no-metrics \
    -gpu swiftshader_indirect -feature -Vulkan -crash-report-mode disabled \
    > "$LOG" 2>&1 &
  emulator_pid=$!

  local waited=0
  until registered; do
    if [ "$waited" -ge "$REGISTER_SECONDS" ]; then
      # This emulator or adb doesn't announce itself: fall back to a server that scans, which
      # also sees any slot's emulator; ANDROID_SERIAL still keeps every call on this one.
      echo "::warning::$SERIAL didn't announce itself to adb in ${REGISTER_SECONDS}s; restarting adb's server with emulator scanning"
      "$ADB" kill-server > /dev/null 2>&1 || true
      "$ADB" start-server
      break
    fi
    kill -0 "$emulator_pid" 2> /dev/null || fail "the emulator exited; see $LOG"
    sleep 1
    waited=$((waited + 1))
  done

  waited=0
  until booted; do
    kill -0 "$emulator_pid" 2> /dev/null || fail "the emulator exited; see $LOG"
    [ "$waited" -lt "$BOOT_SECONDS" ] || fail "$SERIAL didn't boot in ${BOOT_SECONDS}s; see $LOG"
    sleep 3
    waited=$((waited + 3))
  done
  say "booted in ${waited}s"
  for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
    "$ADB" -s "$SERIAL" shell settings put global "$setting" 0
  done
  "$ADB" -s "$SERIAL" shell svc power stayon true || true
  "$ADB" -s "$SERIAL" shell wm dismiss-keyguard || true
  # The AVD keeps the last run's app. This runner's debug key signed it, but a removed app
  # can't fail the install.
  "$ADB" -s "$SERIAL" uninstall "$APP.test" > /dev/null 2>&1 || true
  "$ADB" -s "$SERIAL" uninstall "$APP" > /dev/null 2>&1 || true

  say "instrumented tests on $SERIAL (all but $NOT_ON_CI)"
  (cd "$ROOT/apps/android" && ./gradlew --console=plain :app:connectedDebugAndroidTest \
    "-Pandroid.testInstrumentationRunnerArguments.notClass=$NOT_ON_CI")
}

# The lock: one CI emulator on this Mac at a time, since every runner uses the same two ports.
locked() {
  if [ "${PENMOSS_EMULATOR_LOCKED:-}" = 1 ]; then
    run_tests
  elif command -v lockf > /dev/null; then
    say "waiting for $LOCK (one CI emulator on this Mac at a time, up to ${LOCK_SECONDS}s)"
    PENMOSS_EMULATOR_LOCKED=1 exec lockf -k -t "$LOCK_SECONDS" "$LOCK" bash "$0" test
  elif command -v flock > /dev/null; then
    say "waiting for $LOCK (one CI emulator on this machine at a time, up to ${LOCK_SECONDS}s)"
    PENMOSS_EMULATOR_LOCKED=1 exec flock -w "$LOCK_SECONDS" "$LOCK" bash "$0" test
  else
    fail 'neither lockf nor flock is installed'
  fi
}

# For the job's last step, which runs even when the job is cancelled: this runner's emulator and
# adb only. Another runner's SDK is in its own tool cache, so its emulator never matches.
stop() {
  [ -n "${ANDROID_HOME:-}" ] || return 0
  # Only an SDK in a runner's tool cache: never someone's own SDK and the emulators it runs.
  case "$ANDROID_HOME" in
    "${RUNNER_TOOL_CACHE:-/nonexistent}"/*) ;;
    *)
      say "$ANDROID_HOME isn't in this runner's tool cache: stopping nothing"
      return 0
      ;;
  esac
  local pattern
  for pattern in "$ANDROID_HOME/emulator/" "$ANDROID_HOME/platform-tools/adb"; do
    if pkill -TERM -f "$pattern" 2> /dev/null; then
      say "stopped what was left of $pattern"
      sleep 2
      pkill -KILL -f "$pattern" 2> /dev/null || true
    fi
  done
  return 0
}

case "${1:-}" in
  avd) avd ;;
  test) locked ;;
  stop) stop ;;
  *)
    echo "usage: $0 avd | test | stop" >&2
    exit 2
    ;;
esac
