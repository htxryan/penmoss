import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/exec.ts';
import { repoDir } from '../src/host.ts';
import {
  factoryWorktrees,
  issueOfBranch,
  issueOfWorktree,
  orphanWorktrees,
  pruneWorktreeRecords,
  sweep,
  worktreesFolder,
} from '../src/janitor.ts';
import { testConfig } from './helpers.ts';

const DAYS_AGO = (n: number) => new Date(Date.now() - n * 24 * 3600_000);
const age = (path: string, days: number) => utimesSync(path, DAYS_AGO(days), DAYS_AGO(days));

describe('the janitor (F13)', () => {
  it("lists the factory's worktrees folder itself: real folders only, never a link out of it", () => {
    const folder = mkdtempSync(join(tmpdir(), 'factory-worktrees-'));
    const outside = mkdtempSync(join(tmpdir(), 'factory-outside-'));
    for (const name of ['factory-12-tags', 'factory-13-search']) mkdirSync(join(folder, name));
    writeFileSync(join(folder, 'a-file'), '');
    symlinkSync(outside, join(folder, 'factory-15-link'));
    expect(factoryWorktrees(folder).map((w) => w.name)).toEqual([
      'factory-12-tags',
      'factory-13-search',
    ]);
    expect(factoryWorktrees(join(folder, 'missing'))).toEqual([]);
  });

  it('removes old sandbox worktrees of runs that are not running, and nothing else', () => {
    const folder = '/state/repo/.sandcastle/worktrees';
    const worktrees = ['factory-12-tags', 'factory-13-search', 'factory-14-new'].map((name) => ({
      name,
      path: join(folder, name),
    }));
    const hours = (p: string) => (p.endsWith('14-new') ? 1 : 30);
    const gone = orphanWorktrees(worktrees, 'factory/', new Set([13]), hours);
    expect(gone.map((w) => w.name)).toEqual(['factory-12-tags']);
  });

  it('knows the issue of a factory branch and of its worktree', () => {
    expect(issueOfBranch('factory/12-tags', 'factory/')).toBe(12);
    expect(issueOfBranch('factory/doctor-slot1-x', 'factory/')).toBeNull();
    expect(issueOfBranch('main', 'factory/')).toBeNull();
    expect(issueOfWorktree('factory-12-tags', 'factory/')).toBe(12);
    expect(issueOfWorktree('factory-doctor-slot1-x', 'factory/')).toBeNull();
  });

  it('never deletes a path that `git worktree list` names outside its folder (A-NEW-1)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-janitor-'));
    const config = { ...testConfig(), stateDir: join(root, 'state') };
    const clone = repoDir(config);
    const folder = worktreesFolder(config);
    // Ryan's checkout, say: old, of no running issue.
    const outside = mkdtempSync(join(tmpdir(), 'factory-outside-'));
    writeFileSync(join(outside, 'keep.md'), 'not the factory’s');
    age(outside, 3);
    // An orphan of the factory's own, which it does remove.
    const orphan = join(folder, 'factory-12-tags');
    mkdirSync(orphan, { recursive: true });
    age(orphan, 3);
    // What a sandbox can make `git worktree list` say: its record's gitdir is any path, here
    // one that starts inside the folder and leads out of it.
    const sneaky = `${folder}/${relative(folder, outside)}`;
    const calls: string[][] = [];
    const exec: Exec = (_cmd, args) => {
      calls.push([...args]);
      if (args.includes('list'))
        return Promise.resolve({
          code: 0,
          stdout: `worktree ${clone}\nHEAD a\nbranch refs/heads/main\n\nworktree ${sneaky}\nHEAD b\nbranch refs/heads/factory/99-gone\n`,
          stderr: '',
        });
      // `git worktree remove --force <path>` deletes the folder it is given.
      if (args.includes('remove')) rmSync(args.at(-1) ?? '', { recursive: true, force: true });
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    const lines: string[] = [];
    await sweep(config, exec, new Set(), (l) => lines.push(l));
    expect(existsSync(join(outside, 'keep.md'))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(calls).toEqual([]);
    expect(lines).toEqual([`janitor: removed the worktree ${orphan}`]);
  });

  it('drops records of worktrees that are gone, and never deletes the path a record names', () => {
    const clone = mkdtempSync(join(tmpdir(), 'factory-records-'));
    const outside = mkdtempSync(join(tmpdir(), 'factory-outside-'));
    const records = join(clone, '.git', 'worktrees');
    const record = (id: string, gitdir: string, locked = false) => {
      mkdirSync(join(records, id), { recursive: true });
      writeFileSync(join(records, id, 'gitdir'), `${gitdir}\n`);
      if (locked) writeFileSync(join(records, id, 'locked'), 'initializing');
    };
    writeFileSync(join(outside, '.git'), 'gitdir: elsewhere\n');
    record('gone', join(clone, '.sandcastle', 'worktrees', 'factory-12-tags', '.git'));
    record('alive', join(outside, '.git'));
    record('locked', join(clone, 'missing', '.git'), true);
    expect(pruneWorktreeRecords(clone)).toEqual(['gone']);
    expect(existsSync(join(records, 'alive'))).toBe(true);
    expect(existsSync(join(records, 'locked'))).toBe(true);
    expect(existsSync(join(outside, '.git'))).toBe(true);
  });
});
