import { buildTree } from '@penmoss/core/workspace';
import { initNote } from '@penmoss/sync-client/note';
import type { NoteRecord } from '@penmoss/sync-client';
import { setFrontmatterTag } from '@penmoss/sync-client/tags';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { describe, expect, it } from 'vitest';
import {
  copyTitle,
  itemsCount,
  topItems,
  transfer,
  type NotebookServices,
} from '../../src/workspace/transfer';

describe("Duplicate's title (T68, #227)", () => {
  it('is "(copy)", then the next free number from the same base', () => {
    expect(copyTitle('Plan', ['Plan'])).toBe('Plan (copy)');
    expect(copyTitle('Plan', ['Plan', 'Plan (copy)'])).toBe('Plan (copy 2)');
    expect(copyTitle('Plan', ['Plan', 'Plan (copy)', 'Plan (copy 2)'])).toBe('Plan (copy 3)');
    // A copy of a copy counts from the same base.
    expect(copyTitle('Plan (copy)', ['Plan', 'Plan (copy)'])).toBe('Plan (copy 2)');
    expect(copyTitle('Plan (copy 2)', ['Plan (copy 2)', 'Plan (copy 7)'])).toBe('Plan (copy 8)');
    // Other notes that only start alike do not count.
    expect(copyTitle('Plan', ['Plans (copy)', 'Plan B (copy 4)'])).toBe('Plan (copy)');
    expect(copyTitle('', [])).toBe('Untitled (copy)');
  });
});

describe('what goes to another notebook (T68, #230)', () => {
  const folder = (id: string, parentId: string | null, position: string) => ({
    id,
    name: id,
    parentId,
    position,
    sortMode: 'manual' as const,
  });
  const note = (id: string, folderId: string | null, position: string) => ({
    id,
    folderId,
    position,
    title: id,
    updatedAt: 0,
  });
  const tree = buildTree(
    [folder('A', null, 'a'), folder('B', 'A', 'a'), folder('C', null, 'b')],
    [note('n1', 'B', 'a'), note('n2', null, 'a'), note('n3', 'C', 'a')],
    'manual',
  );

  it('leaves out what a picked folder already takes', () => {
    expect(
      topItems(tree, [
        { kind: 'folder', id: 'A' },
        { kind: 'folder', id: 'B' },
        { kind: 'note', id: 'n1' },
        { kind: 'note', id: 'n2' },
        { kind: 'note', id: 'n3' },
        { kind: 'note', id: 'n2' },
      ]),
    ).toEqual([
      { kind: 'folder', id: 'A' },
      { kind: 'note', id: 'n2' },
      { kind: 'note', id: 'n3' },
    ]);
  });

  it('names what moved', () => {
    expect(itemsCount(1, 0)).toBe('1 note');
    expect(itemsCount(0, 2)).toBe('2 folders');
    expect(itemsCount(2, 1)).toBe('2 notes and 1 folder');
  });
});

describe("Copy to Notebook's Copy Tags (A1353)", () => {
  const tree = buildTree(
    [],
    [{ id: 'n1', folderId: null, position: 'a', title: 'Plan', updatedAt: 0 }],
    'manual',
  );

  /** A note tagged `work`, and two notebooks: the copies land in `added`. */
  function notebooks() {
    const replica = createYjs14Replica();
    initNote(replica.doc, { id: 'n1', created: '2026-11-13T09:00:00-06:00', kind: 'note' }, 'Plan');
    setFrontmatterTag(replica.doc, 'work', true);
    const state = replica.encodeStateAsUpdate();
    replica.destroy();
    const added: NoteRecord[] = [];
    const deleted: string[] = [];
    const services = (own: boolean): NotebookServices =>
      ({
        notes: {
          stateOf: (id: string) => Promise.resolve(own && id === 'n1' ? state : null),
          addCopy: (record: NoteRecord) => {
            added.push(record);
            return record.noteId;
          },
          deleteNote: (id: string) => {
            deleted.push(id);
            return Promise.resolve();
          },
          attachments: { bytes: () => Promise.resolve(null), copyIn: () => Promise.resolve(true) },
        },
        workspace: {
          createFolder: () => 'f',
          registerNote: () => undefined,
          setSortMode: () => undefined,
          deleteFolder: () => undefined,
          notebookOf: () => null,
          apply: () => undefined,
        },
      }) as unknown as NotebookServices;
    const tagsOf = (record: NoteRecord) => record.tags ?? [];
    return { from: services(true), to: services(false), added, deleted, tagsOf };
  }
  const items = [{ kind: 'note', id: 'n1' }] as const;

  it('copies the tags by default and when ticked', async () => {
    for (const tags of [{}, { tags: true }]) {
      const { from, to, added, tagsOf } = notebooks();
      await transfer({ from, to, tree, items, folderId: null, mode: 'copy', ...tags });
      expect(added.map(tagsOf)).toEqual([['work']]);
    }
  });

  it('leaves them behind when unticked', async () => {
    const { from, to, added, deleted, tagsOf } = notebooks();
    const result = await transfer({
      from,
      to,
      tree,
      items,
      folderId: null,
      mode: 'copy',
      tags: false,
    });
    expect(result.notes).toBe(1);
    expect(added.map(tagsOf)).toEqual([[]]);
    expect(deleted).toEqual([]);
  });

  it('always keeps them on a move', async () => {
    const { from, to, added, deleted, tagsOf } = notebooks();
    await transfer({ from, to, tree, items, folderId: null, mode: 'move', tags: false });
    expect(added.map(tagsOf)).toEqual([['work']]);
    expect(deleted).toEqual(['n1']);
  });
});
