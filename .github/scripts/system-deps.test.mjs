// CI's system packages (A1308): .github/scripts/system-deps.sh against a stub ldd, pnpm and
// sudo that log their calls, and the ci.yml steps that use it. Part of `task workflows:test`.
// Nothing here runs apt.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'system-deps.sh');
const CI = path.join(here, '..', 'workflows', 'ci.yml');

function stub(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Runs the script in a fake runner: `missing` is what ldd can't find, `browser` whether Chromium is installed. */
function run({
  missing = [],
  browser = true,
  args = ['@penmoss/web'],
  onPath = [],
  sudoExit = 0,
  dpkgExit = 0,
  cached = [],
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'system-deps-'));
  const bin = path.join(root, 'bin');
  const browsers = path.join(root, 'ms-playwright');
  const log = path.join(root, 'calls.log');
  mkdirSync(bin);
  mkdirSync(path.join(browsers, 'chromium-1'), { recursive: true });
  if (browser) writeFileSync(path.join(browsers, 'chromium-1', 'chrome'), '');
  writeFileSync(log, '');
  stub(
    bin,
    'ldd',
    `echo "\tlibc.so.6 => /lib/libc.so.6"\n${missing.map((l) => `echo "\t${l} => not found"`).join('\n')}`,
  );
  stub(bin, 'pnpm', `echo "pnpm $*" >>"${log}"`);
  stub(
    bin,
    'sudo',
    `echo "sudo $*" >>"${log}"; [ "$1" = dpkg ] && exit ${dpkgExit}; exit ${sudoExit}`,
  );
  const debs = path.join(root, 'debs');
  if (cached.length > 0) mkdirSync(debs);
  for (const file of cached) writeFileSync(path.join(debs, file), '');
  for (const cmd of onPath) stub(bin, cmd, 'exit 0');
  const result = spawnSync('sh', [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      PLAYWRIGHT_BROWSERS_PATH: browsers,
      PENMOSS_DEB_CACHE: debs,
    },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { ...result, debs, calls: calls.map((call) => call.replaceAll(debs, '<debs>')) };
}

describe('system-deps.sh', () => {
  it('skips apt when the image has every library Chromium loads', () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, []);
    assert.match(r.stdout, /no apt/);
  });

  it("installs Chromium's libraries when one is missing", () => {
    const r = run({ missing: ['libgbm.so.1'] });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, ['pnpm --filter @penmoss/web exec playwright install-deps chromium']);
    assert.match(r.stdout, /libgbm\.so\.1/);
  });

  it('falls back to apt when there is no Chromium to check', () => {
    const r = run({ browser: false, args: ['@penmoss/site'] });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [
      'pnpm --filter @penmoss/site exec playwright install-deps chromium',
    ]);
  });

  it('installs only the named tools that are not on PATH, keeping their packages', () => {
    const r = run({ args: ['@penmoss/web', 'Xvfb:xvfb', 'xdotool:xdotool'], onPath: ['Xvfb'] });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [
      'sudo apt-get update',
      'sudo apt-get install -y --no-install-recommends -o Dir::Cache::Archives=<debs> xdotool',
    ]);
  });

  // PEN-114: the mirror was down for hours on 11 Nov 2026, and the Electron job's xdotool with it.
  it('installs the tools from the cache of their packages, without apt', () => {
    const r = run({
      args: ['@penmoss/web', 'xdotool:xdotool'],
      cached: ['libxdo3_1_amd64.deb', 'xdotool_1_amd64.deb'],
      sudoExit: 100,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [
      'sudo dpkg -i <debs>/libxdo3_1_amd64.deb <debs>/xdotool_1_amd64.deb',
    ]);
    assert.match(r.stdout, /from the cache/);
  });

  it("goes to apt, fixing what dpkg left, when the cached packages don't install", () => {
    const r = run({
      args: ['@penmoss/web', 'xdotool:xdotool'],
      cached: ['xdotool_1_amd64.deb'],
      dpkgExit: 1,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [
      'sudo dpkg -i <debs>/xdotool_1_amd64.deb',
      'sudo apt-get update',
      'sudo apt-get install -y --no-install-recommends -f -o Dir::Cache::Archives=<debs> xdotool',
    ]);
  });

  it('fails the step when apt fails', () => {
    const r = run({ args: ['@penmoss/web', 'xdotool:xdotool'], sudoExit: 100 });
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.calls, ['sudo apt-get update']);
  });
});

describe('ci.yml', () => {
  const ci = readFileSync(CI, 'utf8');

  it("asks apt for Chromium's libraries only through system-deps.sh", () => {
    assert.doesNotMatch(ci, /--with-deps/);
    assert.doesNotMatch(ci, /playwright install-deps/);
    assert.equal(ci.match(/sh \.github\/scripts\/system-deps\.sh /g)?.length, 3);
  });

  it("caches the Electron job's tool packages, and fetches Electron before checking its libraries", () => {
    const desktop = ci.slice(ci.indexOf('\n  desktop:'), ci.indexOf('\n  android:'));
    const cache = desktop.indexOf('path: ~/.cache/penmoss-ci/debs');
    const electron = desktop.indexOf(`exec node -e "require('electron')"`);
    const deps = desktop.indexOf('sh .github/scripts/system-deps.sh');
    assert.ok(cache > 0 && electron > cache && deps > electron, 'cache, then Electron, then deps');
  });
});
