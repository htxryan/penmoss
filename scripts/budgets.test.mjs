// Wall-clock budgets stay out of the unit run (A1244). A unit test that times itself fails at
// random on a loaded Mac (several sessions share it, W12), so a budget lives in a
// *.budget.test.* file, which each package's vitest config leaves out of `test` and runs alone in
// `budgets` (`task budgets`). performance.now() is how a budget
// measures, so it appears only there; a bound that only says a call didn't hang (far below the
// hang) is a unit test, and measures with Date.now().
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', 'build', '.astro', '.turbo', 'coverage']);
const TEST = /\.test\.(?:ts|tsx|mts|mjs|js)$/;
const BUDGET = /\.budget\.test\.(?:ts|tsx)$/;

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (TEST.test(entry.name)) found.push(path);
  }
  return found;
}

const self = fileURLToPath(import.meta.url);
const tests = ['apps', 'packages', 'tools', 'scripts']
  .flatMap((top) => walk(join(root, top)))
  .filter((file) => file !== self);

/** The package folder (the nearest one with a package.json) a file belongs to. */
function packageOf(file) {
  let dir = dirname(file);
  while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return dir;
}

test('only a budget file measures with performance.now()', () => {
  const timed = tests.filter(
    (file) => !BUDGET.test(file) && readFileSync(file, 'utf8').includes('performance.now('),
  );
  assert.deepEqual(
    timed.map((file) => relative(root, file)),
    [],
    'a wall-clock budget goes in a *.budget.test.ts file beside the unit test (A1244)',
  );
});

test('every package with a budget runs it in `budgets` and leaves it out of `test`', () => {
  const packages = [...new Set(tests.filter((file) => BUDGET.test(file)).map(packageOf))];
  assert.ok(packages.length > 0, 'the budgets were found');
  for (const dir of packages) {
    const name = relative(root, dir);
    const { scripts = {} } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(scripts.budgets, 'PENMOSS_BUDGETS=1 vitest run', `${name}: the budgets script`);
    const config = readFileSync(join(dir, 'vitest.config.ts'), 'utf8');
    assert.match(config, /process\.env\.PENMOSS_BUDGETS === '1'/, `${name}: the config's switch`);
    assert.match(config, /exclude: .*budget\.test/, `${name}: the unit run leaves budgets out`);
  }
});
