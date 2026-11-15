// The shared vitest config (A1513): how many workers, and real git first on a Mac's PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { realGitDir, testPath, workers } from './vitest-shared.mjs';

test('four workers on CI, a quarter of the cores here, and the variable over both', () => {
  assert.equal(workers({ CI: 'true' }, 64), 4);
  assert.equal(workers({}, 18), 4);
  assert.equal(workers({}, 8), 2);
  assert.equal(workers({}, 2), 2);
  assert.equal(workers({ CI: 'true', PENMOSS_VITEST_WORKERS: '1' }, 18), 1);
  assert.equal(workers({ PENMOSS_VITEST_WORKERS: 'many' }, 18), 4);
});

test('leaves PATH alone off a Mac', () => {
  assert.equal(realGitDir('linux'), null);
  assert.equal(testPath({ PATH: '/usr/bin:/bin' }, 'linux'), '/usr/bin:/bin');
});

test(
  'on a Mac, puts the git that /usr/bin/git runs first, and it is the same git',
  {
    skip: process.platform !== 'darwin',
  },
  () => {
    const dir = realGitDir('darwin', { PATH: '/usr/bin:/bin' });
    assert.ok(dir, 'the tools are installed');
    const path = testPath({ PATH: '/usr/bin:/bin' }, 'darwin');
    assert.ok(path.startsWith(`${dir}:`));
    const version = (env) =>
      spawnSync('git', ['--version'], { env, encoding: 'utf8' }).stdout.trim();
    assert.equal(version({ PATH: path }), version({ PATH: '/usr/bin:/bin' }));
    const which = spawnSync('sh', ['-c', 'command -v git'], {
      env: { PATH: path },
      encoding: 'utf8',
    });
    assert.equal(which.stdout.trim(), `${dir}/git`);
    // Already a real git first (Homebrew's, say): nothing to change.
    assert.equal(realGitDir('darwin', { PATH: `${dir}:/usr/bin` }), null);
  },
);
