import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  AdminCheck,
  answerOf,
  CHECK_TIMEOUT_MS,
  HELPER_EXIT,
  MESSAGES,
  runHelper,
  type HelperOutcome,
  type HelperRunner,
} from '../../src/admin-check';

// T41, T50 (D34, A504, A855): Touch ID or the Mac's password before an owner check, through
// Touch ID itself or the signed helper; never a plain confirmation.

const HELPER = '/Applications/Penmoss.app/Contents/Resources/auth/Penmoss';

function runner(outcome: HelperOutcome | Promise<HelperOutcome>) {
  return vi.fn<HelperRunner>(() => Promise.resolve(outcome));
}

const PURGE = 'delete a note in a git notebook for good';

describe('the Mac’s owner check through its helper (T41, A504)', () => {
  it('runs the helper with main’s words', async () => {
    const run = runner({ kind: 'exit', code: 0 });
    await expect(new AdminCheck({ helper: HELPER, run }).confirmOwn(PURGE)).resolves.toEqual({
      ok: true,
    });
    expect(run).toHaveBeenCalledWith(HELPER, PURGE, CHECK_TIMEOUT_MS);
  });

  it('is a yes only for exit code 0', () => {
    expect(answerOf({ kind: 'exit', code: HELPER_EXIT.confirmed })).toEqual({ ok: true });
    expect(answerOf({ kind: 'exit', code: HELPER_EXIT.refused })).toEqual({
      ok: false,
      message: MESSAGES.refused,
    });
    expect(answerOf({ kind: 'exit', code: HELPER_EXIT.unavailable })).toEqual({
      ok: false,
      message: MESSAGES.unavailable,
    });
    // A usage error, a crash, a signal: the check did not happen.
    for (const code of [HELPER_EXIT.usage, 3, 134, null]) {
      expect(answerOf({ kind: 'exit', code })).toEqual({ ok: false, message: MESSAGES.missing });
    }
    expect(answerOf({ kind: 'timeout' })).toEqual({ ok: false, message: MESSAGES.timeout });
    expect(answerOf({ kind: 'error', error: new Error('ENOENT') })).toEqual({
      ok: false,
      message: MESSAGES.missing,
    });
  });

  it('refuses, saying why, when there is no helper or it will not run', async () => {
    const run = runner({ kind: 'exit', code: 0 });
    await expect(new AdminCheck({ helper: null, run }).confirmOwn(PURGE)).resolves.toEqual({
      ok: false,
      message: MESSAGES.notMac,
    });
    expect(run).not.toHaveBeenCalled();
    const throwing = vi.fn<HelperRunner>(() => Promise.reject(new Error('spawn EACCES')));
    await expect(
      new AdminCheck({ helper: HELPER, run: throwing }).confirmOwn(PURGE),
    ).resolves.toEqual({ ok: false, message: MESSAGES.missing });
  });

  it('refuses a check with no words, without running anything', async () => {
    const run = runner({ kind: 'exit', code: 0 });
    const check = new AdminCheck({ helper: HELPER, run });
    for (const words of ['', '   ', 7, null, undefined]) {
      await expect(check.confirmOwn(words as string)).resolves.toEqual({
        ok: false,
        message: MESSAGES.unknown,
      });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('runs one check at a time: a second request while one is open is refused', async () => {
    let finish: (outcome: HelperOutcome) => void = () => undefined;
    const run = vi.fn<HelperRunner>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const check = new AdminCheck({ helper: HELPER, run });
    const first = check.confirmOwn('remove the git notebook “Home” from this Mac');
    await expect(check.confirmOwn(PURGE)).resolves.toEqual({
      ok: false,
      message: MESSAGES.busy,
    });
    finish({ kind: 'exit', code: 0 });
    await expect(first).resolves.toEqual({ ok: true });
    run.mockResolvedValueOnce({ kind: 'exit', code: 1 });
    await expect(check.confirmOwn(PURGE)).resolves.toEqual({
      ok: false,
      message: MESSAGES.refused,
    });
  });
});

describe('running the helper (T41, A504)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penmoss-auth-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function script(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it.runIf(process.platform !== 'win32')(
    'passes the reason as one argument, never through a shell',
    async () => {
      const seen = join(dir, 'seen');
      const helper = script('echo', `printf '%s' "$#:$1" > "${seen}"\nexit 0`);
      const reason = 'delete a note for good; rm -rf / $(id)';
      await expect(runHelper(helper, reason, 5_000)).resolves.toEqual({ kind: 'exit', code: 0 });
      expect(readFileSync(seen, 'utf8')).toBe(`1:${reason}`);
    },
  );

  it.runIf(process.platform !== 'win32')('reports its exit code', async () => {
    await expect(runHelper(script('no', 'exit 1'), 'x', 5_000)).resolves.toEqual({
      kind: 'exit',
      code: 1,
    });
    await expect(runHelper(script('none', 'exit 2'), 'x', 5_000)).resolves.toEqual({
      kind: 'exit',
      code: 2,
    });
  });

  it.runIf(process.platform !== 'win32')('kills a helper that takes too long', async () => {
    const started = Date.now();
    await expect(runHelper(script('slow', 'sleep 30'), 'x', 200)).resolves.toEqual({
      kind: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports a missing helper as an error, not a yes', async () => {
    const outcome = await runHelper(join(dir, 'does-not-exist'), 'x', 5_000);
    expect(outcome.kind).toBe('error');
    expect(answerOf(outcome)).toEqual({ ok: false, message: MESSAGES.missing });
  });
});

describe('main’s own checks (T50, A855)', () => {
  it('asks Touch ID itself where the Mac has it, with main’s words', async () => {
    const run = runner({ kind: 'exit', code: 0 });
    const prompt = vi.fn((reason: string) => Promise.resolve(void reason));
    const check = new AdminCheck({ helper: HELPER, run, touchId: { can: () => true, prompt } });
    await expect(check.confirmOwn('remove the git notebook “Home” from this Mac')).resolves.toEqual(
      {
        ok: true,
      },
    );
    expect(prompt).toHaveBeenCalledWith('remove the git notebook “Home” from this Mac');
    expect(run).not.toHaveBeenCalled();
  });

  it('a finger that does not match, or a cancel, is a no', async () => {
    const run = runner({ kind: 'exit', code: 0 });
    const check = new AdminCheck({
      helper: HELPER,
      run,
      touchId: { can: () => true, prompt: () => Promise.reject(new Error('cancelled')) },
    });
    await expect(check.confirmOwn('confirm that x is a private repository')).resolves.toEqual({
      ok: false,
      message: MESSAGES.refused,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('without Touch ID, asks the helper (the password); without either, refuses', async () => {
    const run = runner({ kind: 'exit', code: 0 });
    const check = new AdminCheck({
      helper: HELPER,
      run,
      touchId: { can: () => false, prompt: () => Promise.resolve() },
    });
    await expect(check.confirmOwn('delete a note in a git notebook for good')).resolves.toEqual({
      ok: true,
    });
    expect(run).toHaveBeenCalledWith(
      HELPER,
      'delete a note in a git notebook for good',
      CHECK_TIMEOUT_MS,
    );
    await expect(new AdminCheck({ helper: null, run }).confirmOwn('x')).resolves.toEqual({
      ok: false,
      message: MESSAGES.notMac,
    });
    await expect(new AdminCheck({ helper: HELPER, run }).confirmOwn('')).resolves.toEqual({
      ok: false,
      message: MESSAGES.unknown,
    });
  });

  it('one check at a time, Touch ID’s too', async () => {
    let finish: () => void = () => undefined;
    const check = new AdminCheck({
      helper: HELPER,
      run: runner({ kind: 'exit', code: 0 }),
      touchId: {
        can: () => true,
        prompt: () => new Promise<void>((resolve) => (finish = resolve)),
      },
    });
    const first = check.confirmOwn('one');
    await expect(check.confirmOwn('two')).resolves.toEqual({ ok: false, message: MESSAGES.busy });
    await expect(check.confirmOwn(PURGE)).resolves.toEqual({ ok: false, message: MESSAGES.busy });
    finish();
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('a Touch ID prompt that runs out of time refuses, and no other prompt opens over it', async () => {
    let finish: () => void = () => undefined;
    const check = new AdminCheck({
      helper: HELPER,
      run: runner({ kind: 'exit', code: 0 }),
      timeoutMs: 20,
      touchId: {
        can: () => true,
        prompt: () => new Promise<void>((resolve) => (finish = resolve)),
      },
    });
    await expect(check.confirmOwn('remove one')).resolves.toEqual({
      ok: false,
      message: MESSAGES.timeout,
    });
    // Electron cannot close the system's prompt: while it is still up, a finger on it must not
    // seem to answer another check, so none opens.
    await expect(check.confirmOwn('remove two')).resolves.toEqual({
      ok: false,
      message: MESSAGES.busy,
    });
    await expect(check.confirmOwn(PURGE)).resolves.toEqual({ ok: false, message: MESSAGES.busy });
    // The finger lands on the old prompt: still a no for it, and checks can run again.
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = check.confirmOwn('remove three');
    finish();
    await expect(next).resolves.toEqual({ ok: true });
  });
});
