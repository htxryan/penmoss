// scripts/vm/desktop-test.sh against a fake `tart`: a VM this script didn't start is waited for,
// never stopped; one its own interrupted run left behind is stopped (F0.2, A1174). `--check` says
// whether a run could start now, and every "the VM can't take a run now" exits 75, which the
// software factory waits on instead of failing (F10).
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
[ "$1" = run ] && printf '%s\\n' "$@" >"$FAKE/run-args"
case "$1" in
  list)
    if [ "\${2:-}" = --quiet ]; then [ -n "\${FAKE_NO_VM:-}" ] || echo "$PENMOSS_VM"; exit 0; fi
    s="$(state)"
    n="$(cat "$FAKE/polls")"
    [ "$n" -gt 0 ] && [ "$n" -lt 1000 ] && echo $((n - 1)) >"$FAKE/polls"
    echo "Source Name Disk Size Accessed State"
    echo "local $PENMOSS_VM 50 GB 35 GB now $s"
    ;;
  stop) echo 0 >"$FAKE/polls" ;;
  exec)
    [ -n "\${FAKE_SLOW_EXEC:-}" ] && /bin/sleep 0.3
    [ -n "\${FAKE_NO_BOOT:-}" ] && exit 1
    ;;
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
  const env = (more = {}) => ({
    ...process.env,
    PATH: `${fake}:${process.env.PATH}`,
    FAKE: fake,
    PENMOSS_VM: vm,
    ...more,
  });
  const run = (more = {}, args = []) =>
    spawnSync('sh', [join(root, 'scripts/vm/desktop-test.sh'), ...args], {
      encoding: 'utf8',
      env: env(more),
    });
  const calls = () => readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n');
  return { root, fake, vm, pidFile, run, env, calls };
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
  assert.equal(r.status, 75, 'the factory waits on 75 and asks again later');
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

test('PENMOSS_VM_ROOT names the checkout to test, not the script’s own (the factory, A-NEW-1)', () => {
  // The factory runs its own copy of the script and names a run's worktree here.
  const { root, fake, run } = setUp(0);
  const worktree = mkdtempSync(join(tmpdir(), 'penmoss-vm-root-'));
  cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
  const r = run({ PENMOSS_VM_ROOT: worktree });
  assert.equal(r.status, 0, r.stderr);
  const args = readFileSync(join(fake, 'run-args'), 'utf8').trim().split('\n');
  assert.ok(args.includes(`--dir=src:${worktree}:ro`), args.join(' '));
  assert.ok(args.includes(`--dir=out:${worktree}/test-results/vm`), args.join(' '));
  assert.match(r.stdout, new RegExp(`log: ${worktree}/test-results/vm/desktop-test\\.log`));
  assert.throws(() => readFileSync(join(root, 'test-results/vm/tart-run.log')), /ENOENT/);
});

test('a run removes its pid file when it ends', () => {
  const { pidFile, run } = setUp(0);
  assert.equal(run().status, 0);
  assert.throws(() => readFileSync(pidFile), /ENOENT/);
});

test('--check: ready when the VM is made, free and stopped, and starts nothing', () => {
  const { run, calls } = setUp(0);
  const r = run({}, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is ready/);
  assert.deepEqual(
    calls().filter((c) => /^(stop|run|clone|set|exec) /.test(c)),
    [],
  );
});

test("--check: 75 for a VM that isn't made, which it never makes", () => {
  const { run, calls } = setUp(0);
  const r = run({ FAKE_NO_VM: '1' }, ['--check']);
  assert.equal(r.status, 75);
  assert.match(r.stderr, /isn't made yet: run task desktop:test:vm once/);
  assert.deepEqual(
    calls().filter((c) => /^(clone|run) /.test(c)),
    [],
  );
});

test('--check: 75 while another run holds the VM, without waiting for it', async (t) => {
  const { vm, run } = setUp(0);
  const holder = spawn('lockf', ['-k', `/tmp/penmoss-vm-${vm}.lock`, 'sleep', '30'], {
    stdio: 'ignore',
  });
  t.after(() => holder.kill());
  // The lock is taken once lockf runs its command.
  for (let i = 0; i < 100; i++) {
    const free = spawnSync('lockf', ['-s', '-t', '0', `/tmp/penmoss-vm-${vm}.lock`, 'true']);
    if (free.status !== 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const r = run({}, ['--check']);
  assert.equal(r.status, 75);
  assert.match(r.stderr, /is busy with another run/);
});

test('--check: 75 for a VM started outside the script, which it never stops', () => {
  const { run, calls } = setUp(1000);
  const r = run({}, ['--check']);
  assert.equal(r.status, 75);
  assert.match(r.stderr, /started outside this script; stop it \(tart stop /);
  assert.deepEqual(
    calls().filter((c) => c.startsWith('stop ')),
    [],
  );
});

test('75 when tart is not installed', () => {
  const { root } = setUp(0);
  const r = spawnSync('sh', [join(root, 'scripts/vm/desktop-test.sh'), '--check'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(r.status, 75);
  assert.match(r.stderr, /tart is not installed/);
});

test("75 when the VM doesn't boot, and the VM is stopped again", () => {
  const { run, calls } = setUp(0);
  const r = run({ FAKE_NO_BOOT: '1' });
  assert.equal(r.status, 75, r.stderr);
  assert.match(r.stderr, /did not answer in 3 minutes/);
  assert.ok(calls().filter((c) => c.startsWith('stop ')).length >= 2, 'stopped after the boot');
});

test('a run stopped with SIGTERM stops the VM and ends at once (the proof timeout)', async () => {
  // Boot checks that take a while, so SIGTERM lands in one, and a run that went on looping after
  // it would take half a minute.
  const { root, env, calls } = setUp(0);
  const child = spawn('sh', [join(root, 'scripts/vm/desktop-test.sh')], {
    env: env({ FAKE_NO_BOOT: '1', FAKE_SLOW_EXEC: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.resume();
  child.stderr.resume();
  // lockf, the group's leader, dies on SIGTERM at once; the script under it holds the output
  // open until its cleanup has run.
  const ended = new Promise((resolve) => child.once('close', resolve));
  for (let i = 0; i < 200 && !calls().some((c) => c.startsWith('exec ')); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const stopsBefore = calls().filter((c) => c.startsWith('stop ')).length;
  const t0 = Date.now();
  process.kill(-child.pid, 'SIGTERM');
  await ended;
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms to stop`);
  assert.ok(calls().filter((c) => c.startsWith('stop ')).length > stopsBefore, 'stopped the VM');
});
