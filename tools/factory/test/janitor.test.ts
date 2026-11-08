import { describe, expect, it } from 'vitest';
import { issueOfBranch, orphanWorktrees, parseWorktrees } from '../src/janitor.ts';

const clone = '/state/repo';
const porcelain = [
  `worktree ${clone}\nHEAD a\nbranch refs/heads/main`,
  `worktree ${clone}/.sandcastle/worktrees/factory-12-tags\nHEAD b\nbranch refs/heads/factory/12-tags`,
  `worktree ${clone}/.sandcastle/worktrees/factory-13-search\nHEAD c\nbranch refs/heads/factory/13-search`,
  `worktree ${clone}/.sandcastle/worktrees/factory-14-new\nHEAD d\nbranch refs/heads/factory/14-new`,
  `worktree /state/plans/15/repo\nHEAD e\ndetached`,
].join('\n\n');

describe('the janitor (F13)', () => {
  it('reads git worktree list', () => {
    const w = parseWorktrees(porcelain);
    expect(w).toHaveLength(5);
    expect(w[1]).toEqual({
      path: `${clone}/.sandcastle/worktrees/factory-12-tags`,
      branch: 'factory/12-tags',
    });
    expect(w[4]?.branch).toBeNull();
  });
  it('removes old sandbox worktrees of runs that are not running, and nothing else', () => {
    const age = (p: string) => (p.endsWith('14-new') ? 1 : 30);
    const gone = orphanWorktrees(parseWorktrees(porcelain), clone, 'factory/', new Set([13]), age);
    expect(gone.map((w) => w.branch)).toEqual(['factory/12-tags']);
  });
  it('knows the issue of a factory branch', () => {
    expect(issueOfBranch('factory/12-tags', 'factory/')).toBe(12);
    expect(issueOfBranch('factory/doctor-slot1-x', 'factory/')).toBeNull();
    expect(issueOfBranch('main', 'factory/')).toBeNull();
  });
});
