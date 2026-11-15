/**
 * Rename (Ryan's review of PR #192): a notebook's name is `notebook.json`'s, written by the next
 * sync like any other change, so every device and agent that syncs follows.
 */
import { describe, expect, it } from 'vitest';
import { cleanNotebookName, NOTEBOOK_NAME_MAX, parseNotebookInfo } from '../src';
import { testNotebook } from './support/notebooks';

function nameAtHead(nb: ReturnType<typeof testNotebook>): string | undefined {
  const head = nb.head();
  if (!head) return undefined;
  const bytes = nb.remote.read(head, '.penmoss/notebook.json');
  return bytes ? parseNotebookInfo(bytes)?.name : undefined;
}

describe('cleanNotebookName', () => {
  it('keeps one line of words, its spaces collapsed, cut to the longest name', () => {
    expect(cleanNotebookName('  Personal  (old) ')).toBe('Personal (old)');
    expect(cleanNotebookName('Two\nlines\tand\u0007bell')).toBe('Two lines and bell');
    expect(cleanNotebookName('x'.repeat(200))).toHaveLength(NOTEBOOK_NAME_MAX);
    expect(cleanNotebookName('   ')).toBeNull();
    expect(cleanNotebookName(42)).toBeNull();
  });
});

describe('Rename', () => {
  it('writes notebook.json’s name at the next sync, and another device follows', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    expect(b.engine.info?.name).toBe('Work');

    a.engine.rename('  Work (old) ');
    // Shown here at once, before it syncs.
    expect(a.engine.info?.name).toBe('Work (old)');
    expect(a.engine.pendingName).toBe('Work (old)');
    const report = await a.engine.sync();
    expect(report.commit).not.toBeNull();
    expect(nameAtHead(nb)).toBe('Work (old)');
    expect(a.engine.pendingName).toBeNull();
    // Only the name changed in notebook.json: id, format and render version are kept.
    const info = parseNotebookInfo(nb.remote.read(nb.head()!, '.penmoss/notebook.json')!)!;
    expect(info.id).toBe(a.engine.info!.id);

    await b.engine.sync();
    expect(b.engine.info?.name).toBe('Work (old)');
    expect(b.engine.pendingName).toBeNull();
  });

  it('survives a restart before it syncs (it is saved with the engine’s bookkeeping)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    await a.engine.sync();
    a.engine.rename('Renamed');
    await a.engine.save();
    const restarted = await nb.open('A', {
      storage: a.storage.copy(),
      secrets: a.secrets,
      transport: a.transport,
    });
    expect(restarted.engine.pendingName).toBe('Renamed');
    await restarted.engine.sync();
    expect(nameAtHead(nb)).toBe('Renamed');
  });

  it('a notebook renamed before its first push is made with that name', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    a.engine.rename('Personal (2)');
    await a.engine.sync();
    expect(nameAtHead(nb)).toBe('Personal (2)');
  });

  it('a rename that is not pushed yet wins over a name another device pushed meanwhile', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    b.engine.rename('From B');
    await b.engine.sync();
    a.engine.rename('From A');
    await a.engine.sync();
    expect(nameAtHead(nb)).toBe('From A');
    await b.engine.sync();
    expect(b.engine.info?.name).toBe('From A');
  });

  it('renamed back to the name at head before it synced: nothing to commit', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    await a.engine.sync();
    const head = nb.head();
    a.engine.rename('Other');
    a.engine.rename('Work');
    const report = await a.engine.sync();
    expect(report.commit).toBeNull();
    expect(nb.head()).toBe(head);
    expect(a.engine.pendingName).toBeNull();
    expect(a.engine.info?.name).toBe('Work');
  });

  it('a push that fails keeps the rename for the next sync', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    await a.engine.sync();
    a.engine.rename('Kept');
    await expect(
      a.engine.sync({
        beforePush: () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toThrow('offline');
    expect(a.engine.pendingName).toBe('Kept');
    expect(nameAtHead(nb)).toBe('Work');
    await a.engine.sync();
    expect(nameAtHead(nb)).toBe('Kept');
  });

  it('refuses a name with nothing in it', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    expect(() => a.engine.rename('  ')).toThrow(RangeError);
    expect(a.engine.info?.name).toBe('Work');
  });
});
