import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeExec } from '../src/exec.ts';
import {
  mainChanges,
  mainCommit,
  planFiles,
  prepareSnapshot,
  SNAPSHOT_MAIN,
} from '../src/planning-host.ts';
import { publishDir } from '../src/publish.ts';
import { testConfig } from './helpers.ts';

/** A publish repo whose origin/main has two commits, as the host fetches it. */
function publishRepo() {
  const state = mkdtempSync(join(tmpdir(), 'plan-main-'));
  const config = { ...testConfig(), stateDir: state };
  const work = join(state, 'work');
  mkdirSync(work);
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8',
    }).trim();
  git(work, 'init', '-q', '-b', 'main');
  mkdirSync(join(work, 'apps/web/src/pages'), { recursive: true });
  writeFileSync(join(work, 'apps/web/src/pages/SettingsPage.tsx'), 'flat sections\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Settings as it was');
  const first = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'apps/web/src/pages/settings-index.ts'), 'five groups\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Settings: five groups and Search Settings (#204)');
  const second = git(work, 'rev-parse', 'HEAD');
  const publish = publishDir(config);
  execFileSync('git', ['init', '-q', '--bare', publish]);
  git(publish, 'fetch', '-q', work, '+refs/heads/main:refs/remotes/origin/main');
  return { config, first, second };
}

describe("the planning snapshot and main's moves (A1648)", () => {
  it('records the commit it was made from', { timeout: 30_000 }, async () => {
    const { config, second } = publishRepo();
    const files = planFiles(config, 137);
    expect(await mainCommit(config, nodeExec)).toBe(second);
    expect(await prepareSnapshot(config, files, nodeExec)).toBe(second);
    expect(readFileSync(join(files.repo, SNAPSHOT_MAIN), 'utf8').trim()).toBe(second);
    expect(existsSync(join(files.repo, 'apps/web/src/pages/settings-index.ts'))).toBe(true);
  });

  it(
    "names the commits and paths that landed since the session's snapshot",
    { timeout: 30_000 },
    async () => {
      const { config, first, second } = publishRepo();
      const text = await mainChanges(config, nodeExec, first, second);
      expect(text).toContain(
        `main moved from ${first.slice(0, 10)} to ${second.slice(0, 10)}: 1 commit(s), 1 path(s).`,
      );
      expect(text).toMatch(/- [0-9a-f]+ Settings: five groups and Search Settings \(#204\)/);
      expect(text).toContain('- apps/web/src/pages/settings-index.ts');
      expect(await mainChanges(config, nodeExec, undefined, second)).toBe(
        `main is now at ${second.slice(0, 10)}.`,
      );
    },
  );
});
