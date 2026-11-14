/**
 * Every temporary folder the factory's tests make goes in one folder of the run's own, removed
 * when the run ends (vitest's globalSetup). The tests make about 240 a run (`mkdtemp` in
 * `tmpdir()`, and the git and shells they start), and most were never removed: the Mac's $TMPDIR
 * held thousands of them.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string | null = null;
let before: string | undefined;

export async function setup(): Promise<void> {
  before = process.env['TMPDIR'];
  root = await mkdtemp(join(tmpdir(), 'penmoss-factory-tests-'));
  // The test workers start after this and inherit it, and os.tmpdir() reads it on each call.
  process.env['TMPDIR'] = root;
}

export async function teardown(): Promise<void> {
  if (before === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = before;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
}
