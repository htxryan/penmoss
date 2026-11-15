/** The file storage: what a load reads as nothing stored, and its Status figure while saves are under way. */
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

describe('FileStorage.load', () => {
  function stateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'penmoss-storage-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'state'));
    return dir;
  }
  const meta = JSON.stringify({ saves: 3, meta: {} });

  it('reads nothing stored when there is no state, and no workspace or notes when those files are missing', async () => {
    const dir = stateDir();
    await expect(new FileStorage(dir).load()).resolves.toBeNull();
    await expect(new FileStorage(dir).generation()).resolves.toBe(0);
    await expect(new FileStorage(dir).readAttachment(`${'a'.repeat(64)}.png`)).resolves.toBeNull();
    writeFileSync(join(dir, 'state', 'meta.json'), meta);
    const loaded = await new FileStorage(dir).load();
    expect(loaded?.workspace).toBeNull();
    expect(loaded?.notes.size).toBe(0);
  });

  // A meta.json it cannot read is not a store with nothing in it: read as empty, the next save
  // would write a fresh replica over the store and lose every change not yet pushed.
  it('throws when a file is there but cannot be read, never reading it as nothing stored', async () => {
    const unreadableMeta = stateDir();
    mkdirSync(join(unreadableMeta, 'state', 'meta.json'));
    await expect(new FileStorage(unreadableMeta).load()).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(new FileStorage(unreadableMeta).generation()).rejects.toMatchObject({
      code: 'EISDIR',
    });

    const unreadableWorkspace = stateDir();
    writeFileSync(join(unreadableWorkspace, 'state', 'meta.json'), meta);
    mkdirSync(join(unreadableWorkspace, 'state', 'workspace.yjs'));
    await expect(new FileStorage(unreadableWorkspace).load()).rejects.toMatchObject({
      code: 'EISDIR',
    });

    const unlistableNotes = stateDir();
    writeFileSync(join(unlistableNotes, 'state', 'meta.json'), meta);
    writeFileSync(join(unlistableNotes, 'state', 'notes'), '');
    await expect(new FileStorage(unlistableNotes).load()).rejects.toMatchObject({
      code: 'ENOTDIR',
    });

    const unreadableAttachment = stateDir();
    const file = `${'a'.repeat(64)}.png`;
    mkdirSync(join(unreadableAttachment, 'attachments', file), { recursive: true });
    await expect(new FileStorage(unreadableAttachment).readAttachment(file)).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });
});
