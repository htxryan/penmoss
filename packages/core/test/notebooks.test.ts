import { describe, expect, it } from 'vitest';
import { journalFolderId } from '../src/periodic';
import {
  buildTree,
  notebookLineage,
  folderMoveRefusal,
  isJournalOrInbox,
  notebookFlagRefusal,
  notebookIndex,
  notebookKey,
  openNotebookFilter,
  DEFAULT_NOTEBOOK,
  type FolderRecord,
} from '../src/workspace';

const folder = (
  id: string,
  parentId: string | null,
  extra: Partial<FolderRecord> = {},
): FolderRecord => ({ id, name: id, parentId, position: 'a0', sortMode: 'manual', ...extra });

describe('notebook membership (T43, A750, A751)', () => {
  const folders = [
    folder('work', null, { notebook: true, position: 'a2' }),
    folder('qdk', null, { notebook: true, position: 'a1' }),
    folder('specs', 'work'),
    folder('deep', 'specs'),
    folder('home', null),
    folder('garden', 'home'),
  ];

  it('puts each folder in the notebook above it, and everything else in the default', () => {
    const index = notebookIndex(folders);
    expect(index.ofFolder('work')).toBe('work');
    expect(index.ofFolder('deep')).toBe('work');
    expect(index.ofFolder('garden')).toBeNull();
    expect(index.ofFolder(null)).toBeNull();
    expect(index.ofFolder('missing')).toBeNull();
    expect(index.isNotebook('work')).toBe(true);
    expect(index.isNotebook('specs')).toBe(false);
    // In the top level's manual order.
    expect(index.notebooks.map((n) => n.id)).toEqual(['qdk', 'work']);
  });

  it('keeps a notebook nested by a concurrent move a notebook: the outermost one counts', () => {
    const nested = [
      folder('outer', null, { notebook: true }),
      folder('inner', 'outer', { notebook: true }),
      folder('sub', 'inner'),
      folder('plain', null),
      folder('lost', 'plain', { notebook: true }),
      folder('child', 'lost'),
    ];
    const index = notebookIndex(nested);
    expect(index.ofFolder('sub')).toBe('outer');
    expect(index.ofFolder('inner')).toBe('outer');
    // Never the default's: its notes would publish to the default repository (A753).
    expect(index.ofFolder('child')).toBe('lost');
    expect(index.notebooks.map((n) => n.id).sort()).toEqual(['lost', 'outer']);
  });

  it('reads a cycle as the tree does, so membership is the same everywhere', () => {
    const cyclic = [folder('a', 'b', { notebook: true }), folder('b', 'a')];
    const index = notebookIndex(cyclic);
    // The cycle breaks at the smallest id ('a' goes to the top), as effectiveParents does.
    expect(index.ofFolder('b')).toBe('a');
    expect(index.ofFolder('a')).toBe('a');
  });

  it("leaves the default notebook's tree as it was", () => {
    const plain = [folder('home', null), folder('garden', 'home')];
    const before = buildTree(plain, []);
    const index = notebookIndex(plain);
    expect(index.notebooks).toEqual([]);
    expect(index.ofFolder('garden')).toBeNull();
    expect(buildTree(plain, [])).toEqual(before);
    expect(notebookKey(null)).toBe(DEFAULT_NOTEBOOK);
    expect(notebookKey('work')).toBe('work');
  });
});

describe('notebook rules (A750)', () => {
  const journal = folder(journalFolderId('Journal'), null, { name: 'Journal' });
  const year = folder(journalFolderId('Journal/2026'), journal.id, { name: '2026' });
  const inbox = folder('inbox1', null, { name: 'Inbox' });
  const folders = [
    folder('work', null, { notebook: true }),
    folder('specs', 'work'),
    folder('home', null),
    folder('garden', 'home'),
    journal,
    year,
    inbox,
  ];

  it('refuses nesting a notebook, and Journal or the Inbox going into one', () => {
    expect(folderMoveRefusal(folders, 'work', 'home')).toMatch(/top level/);
    expect(folderMoveRefusal(folders, 'work', null)).toBeNull();
    expect(folderMoveRefusal(folders, journal.id, 'work')).toMatch(/Journal/);
    expect(folderMoveRefusal(folders, inbox.id, 'specs')).toMatch(/Inbox/);
    // A folder holding Journal cannot go in either.
    expect(folderMoveRefusal([...folders, folder('box', null)], 'garden', 'specs')).toBeNull();
    expect(folderMoveRefusal(folders, 'garden', 'work')).toBeNull();
    expect(folderMoveRefusal(folders, journal.id, 'home')).toBeNull();
  });

  it('refuses a folder inside Journal or the Inbox going into a notebook (review S4)', () => {
    const month = folder(journalFolderId('Journal/2026/05'), year.id, { name: '05' });
    const kept = folder('kept', inbox.id, { name: 'Kept' });
    const all = [...folders, month, kept];
    expect(folderMoveRefusal(all, year.id, 'work')).toMatch(/Journal/);
    expect(folderMoveRefusal(all, month.id, 'specs')).toMatch(/Journal/);
    expect(folderMoveRefusal(all, kept.id, 'work')).toMatch(/Journal and the Inbox/);
    // Anywhere in the default notebook is fine.
    expect(folderMoveRefusal(all, year.id, 'home')).toBeNull();
    expect(folderMoveRefusal(all, month.id, null)).toBeNull();
  });

  it('turns only a top-level folder into a notebook, never Journal or the Inbox', () => {
    expect(notebookFlagRefusal(folders, 'home', true)).toBeNull();
    expect(notebookFlagRefusal(folders, 'garden', true)).toMatch(/top-level/);
    expect(notebookFlagRefusal(folders, journal.id, true)).toMatch(/Journal/);
    expect(notebookFlagRefusal(folders, inbox.id, true)).toMatch(/Inbox/);
    expect(notebookFlagRefusal(folders, 'work', false)).toBeNull();
    expect(notebookFlagRefusal(folders, 'home', false)).toMatch(/not a notebook/);
    expect(notebookFlagRefusal(folders, 'nope', true)).toMatch(/No such folder/);
    expect(isJournalOrInbox(year)).toBe(false);
    expect(isJournalOrInbox(journal)).toBe(true);
    expect(isJournalOrInbox({ id: journalFolderId('Inbox'), name: 'x', parentId: null })).toBe(
      true,
    );
  });

  it('shows the notes of open notebooks only; the default is always open (A752)', () => {
    const open = openNotebookFilter(folders, new Set(['work']));
    expect(open('specs')).toBe(false);
    expect(open('work')).toBe(false);
    expect(open('garden')).toBe(true);
    expect(open(null)).toBe(true);
    // The default notebook's id closes nothing.
    expect(openNotebookFilter(folders, new Set([DEFAULT_NOTEBOOK]))(null)).toBe(true);
    expect(openNotebookFilter(folders, new Set())('specs')).toBe(true);
  });
});

describe('fail closed: where a folder belongs once its chain is broken (review B1, A757)', () => {
  const folders = [
    folder('work', null, { notebook: true }),
    folder('proj', 'work'),
    folder('home', null),
    // Made offline under a folder another device deleted.
    folder('secret', 'gone-proj'),
    folder('deeper', 'secret'),
    folder('lost', 'gone-notebook'),
    folder('unknown', 'never-heard-of'),
    folder('a', 'b'),
    folder('b', 'a'),
    folder('c', 'd', { notebook: true }),
    folder('d', 'c'),
  ];
  const gone = [
    { id: 'gone-proj', parentId: 'work', notebook: false },
    { id: 'gone-notebook', parentId: null, notebook: true },
    { id: 'gone-sub', parentId: 'gone-notebook', notebook: false },
    { id: 'gone-home', parentId: 'home', notebook: false },
    { id: 'gone-top', parentId: null, notebook: false },
    // A record of a folder that is back in the tree: the tree wins.
    { id: 'proj', parentId: 'gone-notebook', notebook: false },
  ];
  const lineage = notebookLineage(folders, gone);

  it('is certain only when every folder on the way up is in the tree', () => {
    expect(lineage.placement(null)).toEqual({ certain: true, notebook: null });
    expect(lineage.placement('proj')).toEqual({ certain: true, notebook: 'work' });
    expect(lineage.placement('home')).toEqual({ certain: true, notebook: null });
  });

  it('follows Trash to the notebook a broken chain leads to, and holds it', () => {
    expect(lineage.placement('deeper')).toEqual({
      certain: false,
      reason: 'orphaned',
      notebook: 'work',
      deletedNotebook: null,
    });
    expect(lineage.placement('lost')).toEqual({
      certain: false,
      reason: 'orphaned',
      notebook: 'gone-notebook',
      deletedNotebook: 'gone-notebook',
    });
    // A note filed in a deleted folder reads the same way.
    expect(lineage.placement('gone-sub')).toMatchObject({ notebook: 'gone-notebook' });
    expect(lineage.placement('gone-home')).toMatchObject({ certain: false, notebook: null });
    expect(lineage.placement('unknown')).toMatchObject({ certain: false, reason: 'unknown' });
    expect(lineage.placement('unknown')).toHaveProperty('notebook', undefined);
    expect(lineage.placement('a')).toMatchObject({ certain: false, reason: 'cycle' });
    expect(lineage.placement('a')).toHaveProperty('notebook', undefined);
    // A loop through a notebook's folder stays that notebook's.
    expect(lineage.placement('d')).toMatchObject({ certain: false, notebook: 'c' });
  });

  it('falls back only within the notebook, never from a notebook into the default', () => {
    expect(lineage.fallback(null)).toEqual({ folderId: null });
    expect(lineage.fallback('proj')).toEqual({ folderId: 'proj' });
    // A live folder is a place even while its own chain is broken (it is held meanwhile).
    expect(lineage.fallback('secret')).toEqual({ folderId: 'secret' });
    expect(lineage.fallback('gone-proj')).toEqual({ folderId: 'work' });
    expect(lineage.fallback('gone-home')).toEqual({ folderId: 'home' });
    expect(lineage.fallback('gone-top')).toEqual({ folderId: null });
    expect(lineage.fallback('gone-sub')).toEqual({
      refused: 'notebook-gone',
      notebook: 'gone-notebook',
    });
    expect(lineage.fallback('gone-notebook')).toEqual({
      refused: 'notebook-gone',
      notebook: 'gone-notebook',
    });
    expect(lineage.fallback('never-heard-of')).toEqual({ refused: 'unknown', notebook: null });
  });
});
