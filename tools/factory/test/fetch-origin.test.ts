/**
 * Two picks in one poll fetched main into the publish repo together, and the second failed with
 * "cannot lock ref", which Blocked its card (A1377). Fetches of one repo now run one at a time
 * and retry once on a locked ref.
 */
import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/exec.ts';
import { fetchMainInto, fetchOrigin } from '../src/publish.ts';

const LOCKED =
  "error: cannot lock ref 'refs/remotes/origin/main': is at 5545ce3 but expected a48dcfe";
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A fake git: fetches take a few ms, and the ones listed in `fail` exit 1 with `stderr`. */
function fakeGit(fail: Record<number, string> = {}) {
  let running = 0;
  let most = 0;
  const fetches: string[] = [];
  const exec: Exec = async (_cmd, args) => {
    const sub = args.find((a) => a === 'fetch' || a === 'rev-parse');
    if (sub === 'rev-parse') return { code: 0, stdout: 'a'.repeat(40) + '\n', stderr: '' };
    const n = fetches.length;
    fetches.push(args.join(' '));
    running += 1;
    most = Math.max(most, running);
    await tick();
    running -= 1;
    const why = fail[n];
    return why ? { code: 1, stdout: '', stderr: why } : { code: 0, stdout: '', stderr: '' };
  };
  return { exec, fetches, most: () => most };
}

describe('fetching origin into the publish repo (A1377)', () => {
  it('runs one fetch at a time per repo', async () => {
    const git = fakeGit();
    await Promise.all([
      fetchMainInto(git.exec, '/state/publish', 0),
      fetchMainInto(git.exec, '/state/publish', 0),
      fetchMainInto(git.exec, '/state/publish', 0),
    ]);
    expect(git.fetches).toHaveLength(3);
    expect(git.most()).toBe(1);
  });

  it('lets different repos fetch at once', async () => {
    const git = fakeGit();
    await Promise.all([
      fetchMainInto(git.exec, '/state/publish', 0),
      fetchMainInto(git.exec, '/state/other', 0),
    ]);
    expect(git.most()).toBe(2);
  });

  it('retries once when another git held the ref', async () => {
    const git = fakeGit({ 0: LOCKED });
    await expect(fetchMainInto(git.exec, '/state/publish', 0)).resolves.toBe('a'.repeat(40));
    expect(git.fetches).toHaveLength(2);
  });

  it('gives up after one retry, and on any other error at once', async () => {
    const locked = fakeGit({ 0: LOCKED, 1: LOCKED });
    await expect(fetchMainInto(locked.exec, '/state/publish', 0)).rejects.toThrow(
      /cannot lock ref/,
    );
    expect(locked.fetches).toHaveLength(2);
    const offline = fakeGit({ 0: 'fatal: unable to access github.com' });
    await expect(
      fetchOrigin(offline.exec, '/state/publish', ['fetch', 'origin', 'main'], 0),
    ).rejects.toThrow(/unable to access/);
    expect(offline.fetches).toHaveLength(1);
  });

  it("doesn't let one failed fetch stop the next", async () => {
    const git = fakeGit({ 0: 'fatal: unable to access github.com' });
    const [first, second] = await Promise.allSettled([
      fetchMainInto(git.exec, '/state/publish', 0),
      fetchMainInto(git.exec, '/state/publish', 0),
    ]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });
});
