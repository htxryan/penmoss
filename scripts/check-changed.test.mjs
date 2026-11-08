import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-changed.sh', import.meta.url));

/** A throwaway repo holding the script, with one commit per entry of `commits`. */
function repo(commits) {
  const dir = mkdtempSync(join(tmpdir(), 'check-changed-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(script, join(dir, 'scripts/check-changed.sh'));
  for (const files of [['README.md'], ...commits]) {
    for (const file of files) write(dir, file);
    git('add', '-A');
    git('commit', '-q', '-m', files.join(' '));
  }
  return dir;
}

function write(dir, file) {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), `${file} ${Math.random()}\n`);
}

const plan = (dir, ...args) =>
  execFileSync('sh', ['scripts/check-changed.sh', ...args], {
    cwd: dir,
    env: { ...process.env, PENMOSS_CHECK_CHANGED_PLAN: '1' },
    encoding: 'utf8',
  }).trim();

test('checks only what is about to be committed', () => {
  const dir = repo([['tools/a/one.ts', 'tools/a/two.ts']]);
  write(dir, 'tools/a/one.ts');
  assert.equal(plan(dir), '[check:changed] plan: files 1');
});

test('a shared config change earlier on the branch no longer makes every commit a full check', () => {
  const dir = repo([['Taskfile.yml'], ['tools/a/one.ts']]);
  assert.equal(plan(dir), '[check:changed] plan: files 1');
  write(dir, 'tools/a/two.ts');
  assert.equal(plan(dir), '[check:changed] plan: files 1');
});

test('shared config in the change itself runs the whole check', () => {
  const dir = repo([['tools/a/one.ts']]);
  write(dir, 'eslint.config.js');
  assert.equal(plan(dir), '[check:changed] plan: full');
  const committed = repo([['Taskfile.yml']]);
  assert.equal(plan(committed), '[check:changed] plan: full');
});

test('a ref still checks everything since its merge base', () => {
  const dir = repo([['Taskfile.yml'], ['tools/a/one.ts']]);
  assert.equal(plan(dir, 'HEAD~2'), '[check:changed] plan: full');
});
