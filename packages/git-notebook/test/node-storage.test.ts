/** The file storage's Status figure while saves are under way. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStorage } from '../src/node/storage';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('FileStorage.bytes', () => {
  it('counts what is there when a file goes between the listing and its size (a save renaming its temporary file)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'penmoss-storage-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'state'));
    writeFileSync(join(dir, 'state', 'meta.json'), '1234');
    // Listed, but gone when stat looks: as `meta.json.<pid>.<random>.tmp` is once renamed.
    symlinkSync(join(dir, 'state', 'gone'), join(dir, 'state', 'meta.json.1.abc.tmp'));
    await expect(new FileStorage(dir).bytes()).resolves.toBe(4);
  });
});
