/**
 * `apps/android/scripts/proof.sh` (F8), the Android proof a slot's sandbox runs, against a stub
 * `adb`, emulator and Gradle that log their arguments: which emulator it boots and how, that
 * every adb call names the slot's own serial, and the report it writes.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '../../../apps/android/scripts/proof.sh');

const ADB = `#!/bin/sh
echo "adb $*" >>"$STUB_LOG"
echo "env ANDROID_SERIAL=$ANDROID_SERIAL ANDROID_TMP=$ANDROID_TMP" >>"$STUB_LOG"
[ "$1" = -s ] && shift 2
case "$1 $2" in
  'shell getprop') if [ -n "\${STUB_NEVER_BOOTS:-}" ]; then echo 0; else echo 1; fi ;;
  'shell am')
    case "$3" in
      wait-for-broadcast-idle) ;;
      instrument)
        # The emulator crashing as the test ends (its GL backend, on a loaded Mac).
        [ -n "\${STUB_CRASH_IN_TEST:-}" ] && kill "$(cat "$STUB_LOG.emulator")"
        case "$*" in *Passing*) echo 'OK (1 test)' ;; *) echo 'FAILURES!!!' ;; esac ;;
    esac ;;
  'shell dumpsys')
    # System UI's ANR dialog in front for the first STUB_DIALOG_POLLS looks, then the launcher.
    n=$(( $(cat "$STUB_LOG.polls" 2>/dev/null || echo 0) + 1 ))
    echo "$n" >"$STUB_LOG.polls"
    if [ "$n" -le "\${STUB_DIALOG_POLLS:-0}" ]; then
      echo '  mCurrentFocus=Window{9f u0 Application Not Responding: com.android.systemui}'
    else
      echo '  mCurrentFocus=Window{7a u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}'
    fi ;;
  'exec-out screencap') printf 'png' ;;
  pull*) echo mp4 >"$3" ;;
  'exec-out logcat') echo 'I ActivityManager: logcat' ;;
  logcat*) echo 'adb logcat waits for a device forever' >&2; exec sleep 60 ;;
esac
exit 0
`;
const EMULATOR = `#!/bin/sh
echo "emulator $*" >>"$STUB_LOG"
echo $$ >"$STUB_LOG.emulator"
[ -n "\${STUB_EMULATOR_DIES:-}" ] && exit 1
exec sleep 30
`;
const GRADLEW = `#!/bin/sh
echo "gradlew $*" >>"$STUB_LOG"
`;

/** apps/android with proof.sh copied in, a stub gradlew beside it, and a stub SDK. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'android-proof-'));
  const root = join(dir, 'android');
  const sdk = join(dir, 'sdk');
  const tmp = join(dir, 'tmp');
  for (const d of [join(root, 'scripts'), join(sdk, 'platform-tools'), join(sdk, 'emulator'), tmp])
    mkdirSync(d, { recursive: true });
  copyFileSync(SCRIPT, join(root, 'scripts', 'proof.sh'));
  const stub = (path: string, text: string) => {
    writeFileSync(path, text);
    chmodSync(path, 0o755);
  };
  stub(join(root, 'gradlew'), GRADLEW);
  stub(join(sdk, 'platform-tools', 'adb'), ADB);
  stub(join(sdk, 'emulator', 'emulator'), EMULATOR);
  const log = join(dir, 'calls.log');
  // Async, so the tests run side by side: the script's own waits add up to seconds.
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string; calls: string[] }>(
      (resolve, reject) => {
        const child = spawn('sh', [join(root, 'scripts', 'proof.sh'), ...args], {
          timeout: 30_000,
          env: {
            PATH: '/usr/bin:/bin',
            TMPDIR: tmp,
            STUB_LOG: log,
            ANDROID_HOME: sdk,
            PENMOSS_AVD: 'penmoss37-slot1',
            PENMOSS_EMULATOR_PORT: '5560',
            PENMOSS_EMULATOR_QUIET_SECONDS: '2',
            ...env,
          },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', reject);
        child.on('close', (status) => {
          const calls = existsSync(log)
            ? readFileSync(log, 'utf8').split('\n').filter(Boolean)
            : [];
          resolve({ status, stdout, stderr, calls });
        });
      },
    );
  return { root, tmp, run };
}

describe.concurrent("proof.sh's arguments (F8)", { timeout: 30_000 }, () => {
  it('needs at least one test class', async () => {
    const r = await fixture().run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('name at least one instrumented test class');
    expect(r.calls).toEqual([]);
  });

  it('refuses a name that is not a class or class#method, before anything runs', async () => {
    for (const bad of ['a;touch x', 'a b', '$(id)', '../x']) {
      const r = await fixture().run(['app.penmoss.PassingTest', bad]);
      expect(r.status, bad).toBe(2);
      expect(r.stderr).toContain(`not a test class: ${bad}`);
      expect(r.calls).toEqual([]);
    }
  });

  it("needs the slot's AVD and emulator port from the sandbox", async () => {
    const r = await fixture().run(['app.penmoss.PassingTest'], { PENMOSS_AVD: '' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('the AVD of this slot');
    expect(r.calls).toEqual([]);
  });
});

describe.concurrent(
  "proof.sh on the slot's emulator (F8, adb stubbed)",
  { timeout: 30_000 },
  () => {
    it('builds, boots headless on the slot port, records each test and shuts down', async () => {
      const f = fixture();
      const r = await f.run(['app.penmoss.PassingTest', 'app.penmoss.OtherTest#fails']);
      expect(r.status, r.stderr).toBe(0);

      // The build comes before the boot: a Gradle build beside software rendering stalls System UI.
      expect(r.calls[0]).toBe(
        'gradlew --console=plain -q :app:assembleDebug :app:assembleDebugAndroidTest',
      );
      const boot = r.calls.find((c) => c.startsWith('emulator '));
      expect(boot).toBeDefined();
      for (const flag of [
        '-avd penmoss37-slot1',
        '-port 5560',
        '-no-window',
        '-no-snapshot',
        '-gpu swiftshader_indirect',
        '-feature -Vulkan',
        '-crash-report-mode disabled',
      ])
        expect(boot).toContain(flag);
      // After the build. Not "second": proof.sh starts the emulator in the background and polls
      // adb at once, so on a loaded Mac the stub's line can land after the first polls (A1253).
      expect(r.calls.indexOf(boot ?? '')).toBeGreaterThan(0);

      // Every adb call names this slot's emulator, never another slot's or CI's.
      const adb = r.calls.filter((c) => c.startsWith('adb '));
      expect(adb.length).toBeGreaterThan(0);
      for (const call of adb) expect(call.startsWith('adb -s emulator-5560 ')).toBe(true);
      const env = r.calls.filter((c) => c.startsWith('env '));
      for (const line of env)
        expect(line).toBe(`env ANDROID_SERIAL=emulator-5560 ANDROID_TMP=${f.tmp}`);

      // The last run's app is removed before this one installs (another sandbox's debug key).
      const at = (text: string) => adb.findIndex((c) => c.includes(text));
      expect(at('uninstall app.penmoss.debug.test')).toBeGreaterThan(
        at('getprop sys.boot_completed'),
      );
      expect(at('uninstall app.penmoss.debug')).toBeLessThan(at('install -r -t'));
      expect(at('screenrecord')).toBeLessThan(at('-e class app.penmoss.PassingTest'));
      // The device settles before any test: the boot's broadcasts drain, then the launcher has
      // the focus for a while.
      expect(at('am wait-for-broadcast-idle')).toBeGreaterThan(at('getprop sys.boot_completed'));
      expect(at('dumpsys window displays')).toBeGreaterThan(at('am wait-for-broadcast-idle'));
      expect(at('dumpsys window displays')).toBeLessThan(at('am instrument'));
      expect(adb.filter((c) => c.includes('dumpsys window')).length).toBe(2);
      expect(r.stdout).toContain('[proof] settled in');
      // Error dialogs stay on: hiding them restarts a stalled System UI, which recreates the app.
      expect(adb.some((c) => c.includes('hide_error_dialogs'))).toBe(false);
      expect(adb.at(-1)).toBe('adb -s emulator-5560 emu kill');

      const out = join(f.root, 'build', 'proof');
      expect(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))).toEqual([
        {
          title: 'app.penmoss.PassingTest',
          status: 'passed',
          video: 'android-1.mp4',
          screenshot: 'android-1.png',
        },
        {
          title: 'app.penmoss.OtherTest#fails',
          status: 'failed',
          video: 'android-2.mp4',
          screenshot: 'android-2.png',
        },
      ]);
      expect(readFileSync(join(out, 'android-1.mp4'), 'utf8')).toBe('mp4\n');
      expect(readFileSync(join(out, 'android-1.png'), 'utf8')).toBe('png');
      // Each test's device log is kept beside its video, and cleared before the next test.
      expect(readFileSync(join(out, 'android-1.logcat'), 'utf8')).toContain('ActivityManager');
      expect(existsSync(join(out, 'android-2.logcat'))).toBe(true);
      expect(at('exec-out logcat -d')).toBeGreaterThan(at('-e class app.penmoss.PassingTest'));
      expect(at('shell logcat -c')).toBeLessThan(at('-e class app.penmoss.OtherTest#fails'));
      // A failure's own words are in the log.
      expect(r.stdout).toContain('FAILURES!!!');
    }, 30_000);

    it("waits while System UI's ANR dialog has the focus, then runs the tests", async () => {
      const r = await fixture().run(['app.penmoss.PassingTest'], { STUB_DIALOG_POLLS: '3' });
      expect(r.status, r.stderr).toBe(0);
      const adb = r.calls.filter((c) => c.startsWith('adb '));
      const polls = adb.filter((c) => c.includes('dumpsys window'));
      // Three looks at the dialog, then two quiet ones with the launcher in front.
      expect(polls.length).toBe(5);
      const lastPoll = adb.lastIndexOf(polls.at(-1) ?? '');
      expect(adb.findIndex((c) => c.includes('am instrument'))).toBeGreaterThan(lastPoll);
      expect(r.stderr).not.toContain("didn't settle");
    }, 30_000);

    it("runs the tests anyway, and says so, when the device doesn't settle in time", async () => {
      const r = await fixture().run(['app.penmoss.PassingTest'], {
        STUB_DIALOG_POLLS: '1000',
        PENMOSS_EMULATOR_SETTLE_SECONDS: '3',
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain(
        "the emulator didn't settle in 3s; the focus is on: Window{9f u0 Application Not Responding: com.android.systemui}",
      );
      expect(r.calls.some((c) => c.includes('am instrument'))).toBe(true);
    }, 30_000);

    it('finishes, and says so, when the emulator crashes during a test', async () => {
      const f = fixture();
      const r = await f.run(['app.penmoss.PassingTest'], { STUB_CRASH_IN_TEST: '1' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain('the emulator exited during app.penmoss.PassingTest');
      // Never `adb logcat`, which would wait for the crashed emulator forever.
      expect(r.calls.some((c) => /^adb -s \S+ logcat/.test(c))).toBe(false);
      const report = readFileSync(join(f.root, 'build', 'proof', 'report.json'), 'utf8');
      expect(JSON.parse(report)).toHaveLength(1);
    }, 30_000);

    it('stops when the emulator exits, and still tells it to shut down', async () => {
      const r = await fixture().run(['app.penmoss.PassingTest'], {
        STUB_EMULATOR_DIES: '1',
        STUB_NEVER_BOOTS: '1',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('the emulator exited');
      expect(r.calls.some((c) => c.includes('am instrument'))).toBe(false);
      expect(r.calls.at(-2)).toBe('adb -s emulator-5560 emu kill');
    }, 30_000);

    it('gives up on an emulator that never boots, and shuts it down', async () => {
      const r = await fixture().run(['app.penmoss.PassingTest'], {
        STUB_NEVER_BOOTS: '1',
        PENMOSS_EMULATOR_BOOT_SECONDS: '1',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("the emulator didn't boot in 1s");
      expect(r.calls.some((c) => c.includes('am instrument'))).toBe(false);
      expect(r.calls.at(-2)).toBe('adb -s emulator-5560 emu kill');
    }, 30_000);
  },
);
