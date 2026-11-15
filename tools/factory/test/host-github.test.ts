import { describe, expect, it } from 'vitest';
import type { Gh } from '../src/github.ts';
import { openOrReusePr } from '../src/host-github.ts';
import { testConfig } from './helpers.ts';

const config = testConfig();
const BRANCH = 'factory/42-fix-the-typo';

describe("the harness's PR", () => {
  function fakeGh(open: { number: number; url: string }[]): { gh: Gh; calls: string[][] } {
    const calls: string[][] = [];
    const gh: Gh = {
      run: (args) => {
        calls.push([...args]);
        return Promise.resolve(
          args[1] === 'create'
            ? 'Creating pull request…\nhttps://github.com/htxryan/penmoss/pull/7\n'
            : '{}',
        );
      },
      json: <T>(args: readonly string[]) => {
        calls.push([...args]);
        return Promise.resolve(open as T);
      },
      graphql: () => Promise.reject(new Error('not used')),
    };
    return { gh, calls };
  }
  const pr = {
    repo: 'htxryan/penmoss',
    branch: BRANCH,
    title: 'Fix the typo',
    bodyFile: '/runs/42/proof/body.md',
    reviewer: 'htxryan',
  };

  it('opens a PR for a branch that has none, asking Ryan to review', async () => {
    const { gh, calls } = fakeGh([]);
    expect(await openOrReusePr(gh, pr)).toBe('https://github.com/htxryan/penmoss/pull/7');
    expect(calls[1]).toEqual([
      ...['pr', 'create', '--repo', 'htxryan/penmoss', '--base', 'main', '--head', BRANCH],
      ...['--title', 'Fix the typo', '--reviewer', 'htxryan', '--body-file', pr.bodyFile],
    ]);
  });

  it("reuses the branch's open PR when a restarted run gets here again (R12)", async () => {
    const { gh, calls } = fakeGh([{ number: 5, url: 'https://github.com/htxryan/penmoss/pull/5' }]);
    expect(await openOrReusePr(gh, pr)).toBe('https://github.com/htxryan/penmoss/pull/5');
    expect(calls.some((c) => c[1] === 'create')).toBe(false);
    expect(calls[1]).toEqual([
      ...['api', '-X', 'PATCH', 'repos/htxryan/penmoss/pulls/5'],
      ...['-f', 'title=Fix the typo', '-F', `body=@${pr.bodyFile}`],
    ]);
  });
});

describe('openOrReusePr (R12)', () => {
  const fakeGh = (open: { number: number; url: string }[]) => {
    const calls: string[][] = [];
    const gh: Gh = {
      run: (args) => {
        calls.push([...args]);
        return Promise.resolve('https://github.com/htxryan/penmoss/pull/901\n');
      },
      json: <T>(args: readonly string[]) => {
        calls.push([...args]);
        return Promise.resolve(open as T);
      },
      graphql: () => Promise.reject(new Error('unused')),
    };
    return { gh, calls };
  };
  const pr = {
    repo: config.repo,
    branch: 'factory/42-x',
    title: 'T',
    bodyFile: '/tmp/body.md',
    reviewer: config.owner,
  };

  it('opens a PR for a new branch, asking Ryan to review', async () => {
    const f = fakeGh([]);
    expect(await openOrReusePr(f.gh, pr)).toBe('https://github.com/htxryan/penmoss/pull/901');
    expect(f.calls.at(-1)?.slice(0, 2)).toEqual(['pr', 'create']);
    expect(f.calls.at(-1)).toContain('--reviewer');
  });

  it("updates the branch's open PR when a restarted run publishes again, instead of failing", async () => {
    const f = fakeGh([{ number: 900, url: 'https://github.com/htxryan/penmoss/pull/900' }]);
    expect(await openOrReusePr(f.gh, pr)).toBe('https://github.com/htxryan/penmoss/pull/900');
    expect(f.calls.at(-1)?.slice(0, 4)).toEqual([
      'api',
      '-X',
      'PATCH',
      'repos/htxryan/penmoss/pulls/900',
    ]);
    expect(f.calls.some((c) => c[1] === 'create')).toBe(false);
  });
});
