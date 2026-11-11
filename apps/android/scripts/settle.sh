# shellcheck shell=sh
# Settling an emulator before instrumented tests, and answering "isn't responding" dialogs while
# they run (PEN-90, PEN-96; PEN-97 for CI). Sourced by the factory's proof (proof.sh) and CI's
# emulator job (.github/scripts/android-emulator.sh), with ADB and ANDROID_SERIAL set. SETTLE_TAG
# is the log's prefix. Every pipeline here ends in `|| true`, so a caller's `set -e -o pipefail`
# never stops on adb failing for a moment.
SETTLE_SECONDS="${PENMOSS_EMULATOR_SETTLE_SECONDS:-240}"
QUIET_SECONDS="${PENMOSS_EMULATOR_QUIET_SECONDS:-10}"
SETTLE_TAG="${SETTLE_TAG:-[emulator]}"
waited=0
pressed=-10
focus=''

# The window that has the input focus now, as dumpsys names it.
focus_now() {
  "$ADB" -s "$ANDROID_SERIAL" shell dumpsys window displays 2>/dev/null |
    sed -n 's/.*mCurrentFocus=//p' | head -n 1 | tr -d '\r' || true
}

# An "isn't responding" dialog after a slow boot, the launcher's or System UI's, can stay until
# someone answers it (PEN-90): settling then waited out SETTLE_SECONDS. Answer it with Wait, at
# most every 5 s. Wait leaves the process running; Close app, like hiding error dialogs, would
# restart it, and a restarted System UI recreates the activity under test. $1 says when.
press_wait() {
  [ $((waited - pressed)) -ge 5 ] || return 0
  pressed=$waited
  "$ADB" -s "$ANDROID_SERIAL" shell uiautomator dump /sdcard/proof-ui.xml >/dev/null 2>&1 || return 0
  # The Wait button's bounds, as "x1 y1 x2 y2", whatever the device's language.
  bounds="$("$ADB" -s "$ANDROID_SERIAL" exec-out cat /sdcard/proof-ui.xml 2>/dev/null | tr '>' '\n' |
    sed -n 's/.*resource-id="android:id\/aerr_wait".*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p' |
    head -n 1 || true)"
  [ -n "$bounds" ] || return 0
  # Still in front: a dialog that closed meanwhile mustn't turn the tap into one on the app.
  case "$(focus_now)" in *'Not Responding'*) ;; *) return 0 ;; esac
  x="$(echo "$bounds" | awk '{ print int(($1 + $3) / 2) }')"
  y="$(echo "$bounds" | awk '{ print int(($2 + $4) / 2) }')"
  "$ADB" -s "$ANDROID_SERIAL" shell input tap "$x" "$y" >/dev/null 2>&1 || return 0
  echo "$SETTLE_TAG $(echo "$focus" | sed 's/.*Not Responding: \([^}]*\).*/\1/') wasn't responding $1: pressed Wait"
}

# Lets the device settle before any test. Booted is not idle: the boot's broadcasts keep a
# software-rendered emulator busy for a minute or more, System UI can stop responding meanwhile,
# and its "isn't responding" dialog takes the input focus from the app under test (a test's typed
# keys land in the dialog, or it times out waiting for window focus, PEN-97). So: wait for the
# broadcasts to drain, then for the launcher to hold the focus, with no dialog in front, for
# QUIET_SECONDS in a row, answering any "isn't responding" dialog with Wait (press_wait). Hiding
# error dialogs instead is worse: Android then restarts System UI, whose theme overlays change
# the configuration and recreate the activity under test.
settle_device() {
  "$ADB" -s "$ANDROID_SERIAL" shell am wait-for-broadcast-idle >/dev/null 2>&1 &
  idle=$!
  waited=0
  pressed=-10
  while kill -0 "$idle" 2>/dev/null && [ "$waited" -lt "$SETTLE_SECONDS" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill "$idle" 2>/dev/null || true
  quiet=0
  focus=''
  while [ "$quiet" -lt "$QUIET_SECONDS" ]; do
    if [ "$waited" -ge "$SETTLE_SECONDS" ]; then
      echo "$SETTLE_TAG the emulator didn't settle in ${SETTLE_SECONDS}s; the focus is on: ${focus:-nothing}" >&2
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
  echo "$SETTLE_TAG settled in ${waited}s"
}

# On a loaded machine the launcher can stop responding again while a test runs, and its dialog
# then covers the app and takes the test's keys (PEN-96). While a test runs, look every 3 s. Run
# it in the background, and kill it when the test ends.
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
