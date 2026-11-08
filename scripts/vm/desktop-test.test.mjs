// scripts/vm/desktop-test.sh against a fake `tart`: a VM this script didn't start is waited for,
// never stopped; one its own interrupted run left behind is stopped (F0.2, A1174).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./desktop-test.sh', import.meta.url));
const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

// `tart list` says running while the `polls` file counts above zero, one poll at a time; every
// call is logged with the state the VM was in.
const FAKE_TART = `#!/bin/sh
state() { [ "$(cat "$FAKE/polls")" -gt 0 ] && echo running || echo stopped; }
echo "$1 $(state)" >>"$FAKE/calls"
case "$1" in
  list)
    if [ "\${2:-}" = --quiet ]; then echo "$PENMOSS_VM"; exit 0; fi
    s="$(state)"
    n="$(cat "$FAKE/polls")"
    [ "$n" -gt 0 ] && [ "$n" -lt 1000 ] && echo $((n - 1)) >"$FAKE/polls"
    echo "Source Name Disk Size Accessed State"
    echo "local $PENMOSS_VM 50 GB 35 GB now $s"
    ;;
  stop) echo 0 >"$FAKE/polls" ;;
esac
exit 0
`;

function setUp(polls) {
  const root = mkdtempSync(join(tmpdir(), 'penmoss-vm-test-'));
  const fake = join(root, 'fake');
  mkdirSync(join(root, 'scripts/vm'), { recursive: true });
  mkdirSync(fake);
  copyFileSync(script, join(root, 'scripts/vm/desktop-test.sh'));
  writeFileSync(join(fake, 'tart'), FAKE_TART);
  writeFileSync(join(fake, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(fake, 'tart'), 0o755);
  chmodSync(join(fake, 'sleep'), 0o755);
  writeFileSync(join(fake, 'polls'), String(polls));
  writeFileSync(join(fake, 'calls'), '');
  const vm = `penmoss-vm-unit-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const pidFile = `/tmp/penmoss-vm-${vm}.pid`;
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(pidFile, { force: true });
    rmSync(`/tmp/penmoss-vm-${vm}.lock`, { force: true });
  });
  const run = (env = {}) =>
    spawnSync('sh', [join(root, 'scripts/vm/desktop-test.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fake}:${process.env.PATH}`,
        FAKE: fake,
        PENMOSS_VM: vm,
        ...env,
      },
    });
  const calls = () => readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n');
  return { root, fake, vm, pidFile, run, calls };
}

test('waits for a VM started outside the script, then runs, and never stops it', () => {
  const { run, calls } = setUp(3);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /started outside this script; waiting for it to stop/);
  const stops = calls().filter((c) => c.startsWith('stop '));
  assert.ok(stops.length > 0);
  assert.deepEqual(
    stops.filter((c) => c === 'stop running'),
    [],
    'stopped a VM it did not start',
  );
  assert.ok(calls().includes('run stopped'));
});

test('gives up on a VM that stays up, without stopping it', () => {
  const { run, calls } = setUp(1000);
  const r = run({ PENMOSS_VM_WAIT_MINUTES: '0' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /still running after 0 minutes; stop it \(tart stop /);
  assert.deepEqual(
    calls().filter((c) => /^(stop|run) /.test(c)),
    [],
  );
});

test('stops a VM its own interrupted run left running, without waiting', async (t) => {
  const { fake, pidFile, run, calls } = setUp(1000);
  // A live process named tart, as the interrupted run's `tart run` would be.
  const leftover = join(fake, 'left', 'tart');
  mkdirSync(join(fake, 'left'));
  symlinkSync('/bin/sleep', leftover);
  const child = spawn(leftover, ['30'], { stdio: 'ignore' });
  t.after(() => child.kill());
  await new Promise((resolve) => child.once('spawn', resolve));
  writeFileSync(pidFile, String(child.pid));
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /waiting for it to stop/);
  assert.ok(calls().includes('stop running'));
});

test('a run removes its pid file when it ends', () => {
  const { pidFile, run } = setUp(0);
  assert.equal(run().status, 0);
  assert.throws(() => readFileSync(pidFile), /ENOENT/);
});
