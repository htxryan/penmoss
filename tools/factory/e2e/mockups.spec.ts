/**
 * The host's mockup renderer (A1323) for real: the command validation runs in the gate's
 * sandbox, run here with this package's own `@playwright/test` and headless Chromium, on a phone
 * mockup, a desktop one and one that never finishes loading. No window opens.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { parseRendered, renderCommand } from '../src/mockups.ts';

const FACTORY = fileURLToPath(new URL('..', import.meta.url));

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const PHONE = `<!doctype html><html><body style="margin:0;display:flex;justify-content:center">
<div style="width:390px;height:844px;background:#123"><p style="color:#fff">Snackbar</p></div>
</body></html>`;
const DESKTOP = `<!doctype html><html><body style="margin:0">
<header style="height:48px;background:#234">Penmoss</header><main><p>Settings</p></main>
</body></html>`;
/** An image from an address that never answers: the render goes on with what loaded. */
const HANGING = `<!doctype html><html><body style="margin:0">
<main style="width:1280px"><img src="http://10.255.255.1/never.png"><p>Editor</p></main>
</body></html>`;

test('renders each staged mockup headless at a desktop or a phone size', () => {
  test.setTimeout(90_000);
  const dir = mkdtempSync(join(tmpdir(), 'factory-mockups-'));
  try {
    const mockups = join(dir, 'mockups');
    const out = join(dir, 'validation');
    mkdirSync(mockups);
    writeFileSync(join(mockups, 'ac1.html'), PHONE);
    writeFileSync(join(mockups, 'ac2.html'), DESKTOP);
    writeFileSync(join(mockups, 'ac3.html'), HANGING);
    writeFileSync(join(mockups, 'notes.txt'), 'not a mockup');
    const ran = spawnSync('/bin/sh', ['-c', renderCommand({ cwd: FACTORY, mockups, out })], {
      encoding: 'utf8',
      timeout: 80_000,
    });
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(parseRendered(ran.stdout)).toEqual([
      { file: 'ac1.html', png: 'ac1-mockup.png', width: 390, height: 844 },
      { file: 'ac2.html', png: 'ac2-mockup.png', width: 1280, height: 800 },
      { file: 'ac3.html', png: 'ac3-mockup.png', width: 1280, height: 800 },
    ]);
    expect(pngSize(join(out, 'ac1-mockup.png'))).toEqual({ width: 390, height: 844 });
    expect(pngSize(join(out, 'ac2-mockup.png'))).toEqual({ width: 1280, height: 800 });
    expect(pngSize(join(out, 'ac3-mockup.png'))).toEqual({ width: 1280, height: 800 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prints nothing and passes when the plan has no mockups', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-mockups-'));
  try {
    mkdirSync(join(dir, 'mockups'));
    const ran = spawnSync(
      '/bin/sh',
      ['-c', renderCommand({ cwd: FACTORY, mockups: join(dir, 'mockups'), out: join(dir, 'out') })],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
