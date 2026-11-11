// CI's Android emulator (F9, A1227): .github/scripts/android-emulator.sh against a stub adb,
// emulator, avdmanager and Gradle that log their calls, and the `android-emulator` job in ci.yml.
// Part of `task workflows:test`. Nothing here starts a real emulator.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseWorkflow } from './workflow-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'android-emulator.sh');
const CI = path.join(here, '..', 'workflows', 'ci.yml');
const SETTLE = path.join(here, '..', '..', 'apps', 'android', 'scripts', 'settle.sh');

const ADB = `#!/bin/sh
echo "adb $*" >>"$STUB_LOG"
echo "adb-env ANDROID_SERIAL=$ANDROID_SERIAL ANDROID_ADB_SERVER_PORT=$ANDROID_ADB_SERVER_PORT ADB_EMU=\${ADB_EMU:-}" >>"$STUB_LOG"
alive() { [ -f "$STUB_DIR/emulator.pid" ] && kill -0 "$(cat "$STUB_DIR/emulator.pid")" 2>/dev/null; }
case "$1" in
  start-server) [ "\${ADB_EMU:-}" = 0 ] && touch "$STUB_DIR/quiet-server" || rm -f "$STUB_DIR/quiet-server"; exit 0 ;;
  kill-server) exit 0 ;;
  devices)
    echo 'List of devices attached'
    if alive && { [ -z "\${STUB_NEVER_ANNOUNCES:-}" ] || [ ! -f "$STUB_DIR/quiet-server" ]; }; then
      printf 'emulator-5580\\tdevice\\n'
    fi
    exit 0 ;;
esac
[ "$1" = -s ] && shift 2
case "$1 $2" in
  'shell getprop') if alive && [ -z "\${STUB_NEVER_BOOTS:-}" ]; then echo 1; else echo 0; fi ;;
  'shell dumpsys')
    # STUB_ANR_LOOKS: how many looks see System UI's "isn't responding" dialog first.
    n="$(cat "$STUB_DIR/anr" 2>/dev/null || echo "\${STUB_ANR_LOOKS:-0}")"
    if [ "$n" -gt 0 ]; then
      echo $((n - 1)) >"$STUB_DIR/anr"
      echo '  mCurrentFocus=Window{1 u0 Application Not Responding: com.android.systemui}'
    else
      echo 0 >"$STUB_DIR/anr"
      echo '  mCurrentFocus=Window{2 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity}'
    fi ;;
  'exec-out cat') echo '<node resource-id="android:id/aerr_wait" bounds="[100,200][300,400]" />' ;;
  'emu kill') kill "$(cat "$STUB_DIR/emulator.pid")" 2>/dev/null ;;
esac
exit 0
`;
const EMULATOR = `#!/bin/sh
echo "emulator $*" >>"$STUB_LOG"
echo "emulator-env ANDROID_AVD_HOME=$ANDROID_AVD_HOME ANDROID_ADB_SERVER_PORT=$ANDROID_ADB_SERVER_PORT" >>"$STUB_LOG"
[ -n "\${STUB_EMULATOR_DIES:-}" ] && exit 1
echo $$ >"$STUB_DIR/emulator.pid"
exec sleep 60
`;
const AVDMANAGER = `#!/bin/sh
echo "avdmanager $*" >>"$STUB_LOG"
mkdir -p "$ANDROID_AVD_HOME/penmoss37-ci.avd"
echo 'avd.ini.encoding=UTF-8' >"$ANDROID_AVD_HOME/penmoss37-ci.ini"
echo 'image.sysdir.1=system-images/android-37.0/google_apis/arm64-v8a/' >"$ANDROID_AVD_HOME/penmoss37-ci.avd/config.ini"
`;
const GRADLEW = `#!/bin/sh
echo "gradlew $*" >>"$STUB_LOG"
echo "gradle-env ANDROID_SERIAL=$ANDROID_SERIAL ANDROID_ADB_SERVER_PORT=$ANDROID_ADB_SERVER_PORT" >>"$STUB_LOG"
[ -n "\${STUB_TESTS_FAIL:-}" ] && exit 1
exit 0
`;

/** A checkout with the script in .github/scripts, a stub gradlew, and a stub SDK in a tool cache. */
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'android-emulator-'));
  const repo = path.join(dir, 'repo');
  const toolCache = path.join(dir, '_tool');
  const sdk = path.join(toolCache, 'android-sdk');
  const avdHome = path.join(toolCache, 'penmoss', 'android-avd');
  const stubs = path.join(dir, 'stubs');
  for (const d of [
    path.join(repo, '.github', 'scripts'),
    path.join(repo, 'apps', 'android'),
    path.join(sdk, 'platform-tools'),
    path.join(sdk, 'emulator'),
    path.join(sdk, 'cmdline-tools', '16111833', 'bin'),
    stubs,
  ])
    mkdirSync(d, { recursive: true });
  const script = path.join(repo, '.github', 'scripts', 'android-emulator.sh');
  copyFileSync(SCRIPT, script);
  mkdirSync(path.join(repo, 'apps', 'android', 'scripts'), { recursive: true });
  copyFileSync(SETTLE, path.join(repo, 'apps', 'android', 'scripts', 'settle.sh'));
  /** @param {string} file @param {string} text */
  const stub = (file, text) => {
    writeFileSync(file, text);
    chmodSync(file, 0o755);
  };
  stub(path.join(repo, 'apps', 'android', 'gradlew'), GRADLEW);
  stub(path.join(sdk, 'platform-tools', 'adb'), ADB);
  stub(path.join(sdk, 'emulator', 'emulator'), EMULATOR);
  stub(path.join(sdk, 'cmdline-tools', '16111833', 'bin', 'avdmanager'), AVDMANAGER);
  const log = path.join(dir, 'calls.log');
  const lock = path.join(dir, 'emulator.lock');
  /**
   * @param {string[]} args
   * @param {Record<string, string>} [env]
   * @returns {Promise<{ status: number | null, stdout: string, calls: string[] }>}
   */
  const run = (args, env = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn('bash', [script, ...args], {
        timeout: 60_000,
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin',
          STUB_LOG: log,
          STUB_DIR: stubs,
          ANDROID_HOME: sdk,
          PENMOSS_CACHE: path.join(toolCache, 'penmoss'),
          RUNNER_TOOL_CACHE: toolCache,
          RUNNER_TEMP: dir,
          PENMOSS_EMULATOR_LOCK: lock,
          // One look at the launcher is enough here; CI waits for 10 s of it.
          PENMOSS_EMULATOR_QUIET_SECONDS: '1',
          ...env,
        },
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stdout += d.toString()));
      child.on('error', reject);
      child.on('close', (status) => {
        const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
        resolve({ status, stdout, calls });
      });
    });
  const makeAvd = () => run(['avd']).then(() => writeFileSync(log, ''));
  const emulatorRunning = () => {
    const pidFile = path.join(stubs, 'emulator.pid');
    if (!existsSync(pidFile)) return false;
    return spawnSync('kill', ['-0', readFileSync(pidFile, 'utf8').trim()]).status === 0;
  };
  return { dir, avdHome, lock, run, makeAvd, emulatorRunning };
}

describe('android-emulator.sh avd', () => {
  it("makes the API 37 AVD once, in the runner's tool cache", async () => {
    const f = fixture();
    const first = await f.run(['avd'], { PENMOSS_EMULATOR_ARCH: 'arm64' });
    assert.equal(first.status, 0, first.stdout);
    assert.deepEqual(
      first.calls.filter((c) => c.startsWith('avdmanager ')),
      [
        'avdmanager create avd --name penmoss37-ci --package system-images;android-37.0;google_apis;arm64-v8a --device pixel_7 --force',
      ],
    );
    const config = readFileSync(path.join(f.avdHome, 'penmoss37-ci.avd', 'config.ini'), 'utf8');
    assert.match(config, /^hw\.ramSize=3072$/m);
    assert.match(config, /^hw\.lcd\.height=2400$/m);

    const again = await f.run(['avd']);
    assert.equal(again.status, 0, again.stdout);
    assert.equal(again.calls.filter((c) => c.startsWith('avdmanager ')).length, 1);
    assert.match(again.stdout, /keeping penmoss37-ci/);
  });

  it('uses the x86_64 image on an x86_64 machine (a hosted Ubuntu runner, A1235)', async () => {
    const f = fixture();
    const r = await f.run(['avd'], { PENMOSS_EMULATOR_ARCH: 'x86_64' });
    assert.equal(r.status, 0, r.stdout);
    assert.ok(
      r.calls.includes(
        'avdmanager create avd --name penmoss37-ci --package system-images;android-37.0;google_apis;x86_64 --device pixel_7 --force',
      ),
      r.calls.join('\n'),
    );
  });

  it("keeps the AVD in ~/.android/avd without a Mac runner's tool cache", async () => {
    const f = fixture();
    const r = await f.run(['avd'], { PENMOSS_CACHE: '', HOME: f.dir });
    assert.equal(r.status, 0, r.stdout);
    assert.ok(existsSync(path.join(f.dir, '.android', 'avd', 'penmoss37-ci.ini')), r.stdout);
  });
});

describe(
  'android-emulator.sh test (adb, the emulator and Gradle stubbed)',
  { concurrency: true },
  () => {
    it('boots emulator-5580 headless, runs the tests on it alone, and kills it', async () => {
      const f = fixture();
      await f.makeAvd();
      const r = await f.run(['test']);
      assert.equal(r.status, 0, r.stdout);

      const boot = r.calls.find((c) => c.startsWith('emulator '));
      assert.ok(boot, r.stdout);
      for (const flag of [
        '-avd penmoss37-ci',
        '-port 5580',
        '-no-window',
        '-no-audio',
        '-no-boot-anim',
        '-no-snapshot',
        '-gpu swiftshader_indirect',
      ])
        assert.ok(boot.includes(flag), `${boot} has ${flag}`);
      assert.ok(
        r.calls.includes(`emulator-env ANDROID_AVD_HOME=${f.avdHome} ANDROID_ADB_SERVER_PORT=5050`),
      );

      // adb's own server on 5050, started without scanning before the emulator, so it never
      // connects to a slot's emulator; every other adb call names emulator-5580.
      const adb = r.calls.filter((c) => c.startsWith('adb '));
      const start = r.calls.indexOf('adb start-server');
      assert.ok(start >= 0 && start < r.calls.indexOf(boot));
      assert.equal(
        r.calls[start + 1],
        'adb-env ANDROID_SERIAL=emulator-5580 ANDROID_ADB_SERVER_PORT=5050 ADB_EMU=0',
      );
      for (const call of adb)
        assert.ok(
          /^adb (start-server|kill-server|devices)$/.test(call) ||
            call.startsWith('adb -s emulator-5580 '),
          call,
        );
      for (const env of r.calls.filter((c) => c.startsWith('adb-env ')))
        assert.match(env, /^adb-env ANDROID_SERIAL=emulator-5580 ANDROID_ADB_SERVER_PORT=5050 /);

      // The last run's app goes first; then Gradle's instrumented tests on that serial alone.
      const gradle = r.calls.find((c) => c.startsWith('gradlew '));
      assert.equal(
        gradle,
        'gradlew --console=plain :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.notClass=app.penmoss.NoteListJankTest',
      );
      assert.ok(
        r.calls.includes('gradle-env ANDROID_SERIAL=emulator-5580 ANDROID_ADB_SERVER_PORT=5050'),
      );
      assert.ok(
        r.calls.indexOf('adb -s emulator-5580 uninstall app.penmoss.debug') <
          r.calls.indexOf(gradle),
      );

      // And the emulator is killed at the end, then adb's server.
      const kill = r.calls.indexOf('adb -s emulator-5580 emu kill');
      assert.ok(kill > r.calls.indexOf(gradle));
      assert.ok(r.calls.lastIndexOf('adb kill-server') > kill);
      assert.equal(f.emulatorRunning(), false);
    });

    it("lets the emulator settle before the tests, answering System UI's dialog with Wait (PEN-97)", async () => {
      const f = fixture();
      await f.makeAvd();
      const r = await f.run(['test'], { STUB_ANR_LOOKS: '2' });
      assert.equal(r.status, 0, r.stdout);
      const idle = r.calls.indexOf('adb -s emulator-5580 shell am wait-for-broadcast-idle');
      const tap = r.calls.indexOf('adb -s emulator-5580 shell input tap 200 300');
      const gradle = r.calls.findIndex((c) => c.startsWith('gradlew '));
      assert.ok(idle >= 0 && idle < tap && tap < gradle, r.calls.join('\n'));
      assert.match(r.stdout, /com\.android\.systemui wasn't responding after \d+s: pressed Wait/);
      assert.match(r.stdout, /\[emulator\] settled in \d+s/);
    });

    it("uses 5580 and adb's 5050 even when a slot's settings are in the environment", async () => {
      const f = fixture();
      await f.makeAvd();
      const r = await f.run(['test'], {
        PENMOSS_EMULATOR_PORT: '5560',
        ANDROID_SERIAL: 'emulator-5560',
        ANDROID_ADB_SERVER_PORT: '5040',
        PENMOSS_AVD: 'penmoss37-slot1',
      });
      assert.equal(r.status, 0, r.stdout);
      assert.ok(
        r.calls.find((c) => c.startsWith('emulator '))?.includes('-avd penmoss37-ci -port 5580 '),
      );
      const calls = r.calls.map((c) => c.replaceAll(f.dir, '<fixture>'));
      assert.equal(calls.filter((c) => /5560|5040|slot1/.test(c)).length, 0, calls.join('\n'));
    });

    it('fails when a test fails, and still kills the emulator', async () => {
      const f = fixture();
      await f.makeAvd();
      const r = await f.run(['test'], { STUB_TESTS_FAIL: '1' });
      assert.notEqual(r.status, 0);
      assert.ok(r.calls.includes('adb -s emulator-5580 emu kill'));
      assert.equal(f.emulatorRunning(), false);
    });

    it('gives up on a boot after its bound, and kills the emulator', async () => {
      const f = fixture();
      await f.makeAvd();
      const r = await f.run(['test'], {
        STUB_NEVER_BOOTS: '1',
        PENMOSS_EMULATOR_BOOT_SECONDS: '3',
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /emulator-5580 didn't boot in 3s/);
      assert.equal(r.calls.filter((c) => c.startsWith('gradlew ')).length, 0);
      assert.ok(r.calls.includes('adb -s emulator-5580 emu kill'));
      assert.equal(f.emulatorRunning(), false);
    });

    it('says so when the emulator exits, pointing at its log', async () => {
      const f = fixture();
      await f.makeAvd();
      const r = await f.run(['test'], { STUB_EMULATOR_DIES: '1' });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /the emulator exited; see .*emulator\.log/);
      assert.equal(r.calls.filter((c) => c.startsWith('gradlew ')).length, 0);
    });

    it("falls back to a scanning adb server when the emulator doesn't announce itself", async () => {
      const f = fixture();
      await f.makeAvd();
      const r = await f.run(['test'], {
        STUB_NEVER_ANNOUNCES: '1',
        PENMOSS_EMULATOR_REGISTER_SECONDS: '1',
      });
      assert.equal(r.status, 0, r.stdout);
      assert.match(r.stdout, /didn't announce itself/);
      const starts = r.calls.flatMap((c, i) => (c === 'adb start-server' ? [r.calls[i + 1]] : []));
      assert.deepEqual(starts, [
        'adb-env ANDROID_SERIAL=emulator-5580 ANDROID_ADB_SERVER_PORT=5050 ADB_EMU=0',
        'adb-env ANDROID_SERIAL=emulator-5580 ANDROID_ADB_SERVER_PORT=5050 ADB_EMU=',
      ]);
      assert.ok(r.calls.some((c) => c.startsWith('gradlew ')));
    });

    it('needs the AVD first', async () => {
      const r = await fixture().run(['test']);
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /no AVD penmoss37-ci/);
      assert.equal(r.calls.filter((c) => c.startsWith('emulator ')).length, 0);
    });

    it("waits for another runner's emulator job, and starts nothing when the wait runs out", async () => {
      const f = fixture();
      await f.makeAvd();
      const lockTool = ['lockf', 'flock'].find(
        (t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0,
      );
      assert.ok(lockTool, 'lockf (macOS) or flock (Linux) is installed');
      // Another runner's job holds the lock for a few seconds.
      const holder = spawn(
        lockTool,
        lockTool === 'lockf' ? ['-k', f.lock, 'sleep', '5'] : [f.lock, 'sleep', '5'],
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const r = await f.run(['test'], { PENMOSS_EMULATOR_LOCK_SECONDS: '1' });
      holder.kill();
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /waiting for .*emulator\.lock/);
      assert.equal(
        r.calls.filter((c) => c.startsWith('emulator ') || c.startsWith('adb ')).length,
        0,
      );
    });
  },
);

describe('android-emulator.sh stop', () => {
  it("stops nothing outside a runner's tool cache", async () => {
    const f = fixture();
    const r = await f.run(['stop'], {
      ANDROID_HOME: path.join(f.dir, 'Library', 'Android', 'sdk'),
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /isn't in this runner's tool cache: stopping nothing/);
  });

  it('is a no-op without an SDK (a job that failed before installing it)', async () => {
    const r = await fixture().run(['stop'], { ANDROID_HOME: '' });
    assert.equal(r.status, 0);
  });
});

describe("ci.yml's android-emulator job", () => {
  const workflow = parseWorkflow(readFileSync(CI, 'utf8'), 'ci.yml');
  const job = workflow.jobs.find((j) => j.name === 'android-emulator');
  const text = readFileSync(CI, 'utf8');
  const body = text.slice(text.indexOf('\n  android-emulator:\n'));
  const own = body.slice(0, body.slice(1).search(/\n {2}[\w-]+:\n/) + 1);

  it('runs on a hosted Ubuntu runner when pick says Android changed (A1235)', () => {
    assert.ok(job);
    assert.equal(job.runsOn, 'ubuntu-latest');
    assert.equal(job.if, "needs.pick.outputs.android-app == 'true'");
    assert.match(own, /\n {4}needs: pick\n/);
  });

  it('enables KVM, makes the AVD, builds before the boot, runs the tests, and always stops the emulator', () => {
    const at = (/** @type {string} */ s) => {
      const i = own.indexOf(s);
      assert.ok(i >= 0, `the job has ${s}`);
      return i;
    };
    const kvm = at('udevadm trigger --name-match=kvm');
    const sdk = at('system-images;android-37.0;google_apis;x86_64');
    assert.ok(kvm < sdk);
    const avd = at('android-emulator.sh avd');
    const build = at('task android:build -- :app:assembleDebugAndroidTest');
    const tests = at('android-emulator.sh test');
    const stop = at('android-emulator.sh stop');
    assert.ok(sdk < avd && avd < build && build < tests && tests < stop);
    assert.match(own.slice(own.lastIndexOf('- name:', stop)), /if: always\(\)/);
  });
});
