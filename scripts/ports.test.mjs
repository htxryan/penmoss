import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BASE_PORTS, MAX_BLOCK, parseBlock, ports, portsFor } from './ports.mjs';

const script = fileURLToPath(new URL('./ports.mjs', import.meta.url));

test('block 0 keeps every port as it is today', () => {
  assert.deepEqual(portsFor(0), {
    vite: 5173,
    preview: 4173,
    worker: 8787,
    fakeGithub: 8791,
    inspector: 9229,
  });
  assert.deepEqual(ports({}), BASE_PORTS);
  assert.deepEqual(ports({ PENMOSS_PORT_BLOCK: '' }), BASE_PORTS);
});

test("block n is 20000 + 100·n + each port's offset", () => {
  assert.deepEqual(portsFor(1), {
    vite: 20173,
    preview: 20174,
    worker: 20187,
    fakeGithub: 20191,
    inspector: 20129,
  });
  assert.deepEqual(ports({ PENMOSS_PORT_BLOCK: '2' }), {
    vite: 20273,
    preview: 20274,
    worker: 20287,
    fakeGithub: 20291,
    inspector: 20229,
  });
  assert.equal(portsFor(99).fakeGithub, 29991);
});

test('no two blocks share a port, and no block reuses one of its own', () => {
  const seen = new Set();
  for (let block = 0; block <= 99; block++) {
    for (const port of Object.values(portsFor(block))) {
      assert.ok(!seen.has(port), `port ${port} appears twice`);
      seen.add(port);
    }
  }
});

test('a bad block is an error, not a silent default', () => {
  for (const value of ['-1', '100', '1.5', 'one']) {
    assert.throws(
      () => parseBlock(value),
      /PENMOSS_PORT_BLOCK must be a whole number from 0 to 99/,
    );
  }
  assert.throws(() => portsFor(100));
});

test('the command line prints one port or all of them', () => {
  const env = { ...process.env, PENMOSS_PORT_BLOCK: '3' };
  assert.equal(execFileSync('node', [script, 'vite'], { env, encoding: 'utf8' }).trim(), '20373');
  assert.match(
    execFileSync('node', [script], { env, encoding: 'utf8' }),
    /^vite=20373\npreview=20374\n/,
  );
  assert.throws(() => execFileSync('node', [script, 'nope'], { env, stdio: 'pipe' }));
});

test('the command line works from a checkout whose path has a space', () => {
  // The factory's worktrees are under "~/Library/Application Support" (A1231).
  const dir = mkdtempSync(join(tmpdir(), 'penmoss ports '));
  try {
    const copy = join(dir, 'ports.mjs');
    copyFileSync(script, copy);
    const env = { ...process.env, PENMOSS_PORT_BLOCK: '3' };
    assert.equal(execFileSync('node', [copy, 'vite'], { env, encoding: 'utf8' }).trim(), '20373');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no block lands on cloudflared's metrics ports (20241–20245)", () => {
  for (let block = 1; block <= MAX_BLOCK; block++) {
    for (const port of Object.values(portsFor(block))) {
      assert.ok(port < 20241 || port > 20245, `block ${block} uses ${port}`);
    }
  }
});
