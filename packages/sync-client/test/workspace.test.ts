import { buildTree, keyBetween } from '@penmoss/core/workspace';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import {
  createFolder,
  deleteFolder,
  moveFolder,
  moveNote,
  readSettings,
  readFolderTrash,
  readWorkspace,
  registerNote,
  rehomeNotes,
  restoreFolder,
  FOLDER_TRASH_DAYS,
  renameFolder,
  setSetting,
  setSortMode,
  WorkspaceError,
} from '../src/workspace';

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function tree(doc: Y.Doc) {
  const { folders, notes, rootSortMode } = readWorkspace(doc);
  return buildTree(
    folders,
    notes.map((n) => ({ ...n, title: n.id, updatedAt: 0 })),
    rootSortMode,
  );
}

describe('workspace document', () => {
  it('creates, renames, nests and appends folders in order', () => {
    const doc = new Y.Doc();
    createFolder(doc, { id: 'work', name: 'Work', parentId: null });
    createFolder(doc, { id: 'home', name: 'Home', parentId: null });
    createFolder(doc, { id: 'p', name: 'Projects', parentId: 'work' });
    createFolder(doc, { id: 'deep', name: 'Deep', parentId: 'p' });
    renameFolder(doc, 'work', 'Job');

    const t = tree(doc);
    expect(t.folders.map((f) => f.name)).toEqual(['Job', 'Home']);
    expect(t.byId.get('p')?.folders.map((f) => f.id)).toEqual(['deep']);
  });

  it('refuses to move a folder into its own subfolder', () => {
    const doc = new Y.Doc();
    createFolder(doc, { id: 'a', name: 'A', parentId: null });
    createFolder(doc, { id: 'b', name: 'B', parentId: 'a' });
    expect(() => moveFolder(doc, 'a', 'b', 'a0')).toThrow(WorkspaceError);
    expect(() => moveFolder(doc, 'a', 'a', 'a0')).toThrow(WorkspaceError);
    expect(() => createFolder(doc, { id: 'x', name: 'X', parentId: 'missing' })).toThrow(
      WorkspaceError,
    );
  });

  it('merges a rename and a move made on two devices', () => {
    const a = new Y.Doc();
    createFolder(a, { id: 'f', name: 'Folder', parentId: null });
    createFolder(a, { id: 'g', name: 'Other', parentId: null });
    const b = new Y.Doc();
    sync(a, b);

    renameFolder(a, 'f', 'Renamed');
    moveFolder(b, 'f', 'g', 'a0');
    sync(a, b);

    for (const doc of [a, b]) {
      expect(
        tree(doc)
          .byId.get('g')
          ?.folders.map((f) => f.name),
      ).toEqual(['Renamed']);
    }
  });

  it('resolves concurrent moves that form a cycle the same way on both devices, without writing', () => {
    const a = new Y.Doc();
    createFolder(a, { id: 'x', name: 'X', parentId: null });
    createFolder(a, { id: 'y', name: 'Y', parentId: null });
    const b = new Y.Doc();
    sync(a, b);

    moveFolder(a, 'x', 'y', 'a0'); // x into y
    moveFolder(b, 'y', 'x', 'a0'); // y into x
    let writes = 0;
    a.on('update', () => writes++);
    sync(a, b);
    writes = 0;

    const ta = tree(a);
    const tb = tree(b);
    expect(ta.folders.map((f) => f.id)).toEqual(['x']);
    expect(ta.byId.get('x')?.folders.map((f) => f.id)).toEqual(['y']);
    expect(tb.folders.map((f) => f.id)).toEqual(ta.folders.map((f) => f.id));
    expect(writes).toBe(0);
  });

  it('reorders notes with order keys and syncs the order', () => {
    const a = new Y.Doc();
    registerNote(a, { id: 'n1', folderId: null });
    registerNote(a, { id: 'n2', folderId: null });
    registerNote(a, { id: 'n3', folderId: null });
    registerNote(a, { id: 'n1', folderId: null }); // idempotent
    const b = new Y.Doc();
    sync(a, b);

    const [p1, p2] = [
      readWorkspace(a).notes.find((n) => n.id === 'n1')!.position,
      readWorkspace(a).notes.find((n) => n.id === 'n2')!.position,
    ];
    moveNote(a, 'n3', null, keyBetween(p1, p2)); // Alt+↑ twice
    sync(a, b);

    expect(tree(b).notes.map((n) => n.id)).toEqual(['n1', 'n3', 'n2']);
  });

  it("remembers each folder's sort mode, and the top level's, across devices", () => {
    const a = new Y.Doc();
    createFolder(a, { id: 'f', name: 'F', parentId: null });
    setSortMode(a, 'f', 'alpha');
    setSortMode(a, null, 'modified');
    const b = new Y.Doc();
    sync(a, b);
    expect(tree(b).byId.get('f')?.sortMode).toBe('alpha');
    expect(tree(b).rootSortMode).toBe('modified');
  });

  it('deleting a folder keeps its notes, moving them up', () => {
    const doc = new Y.Doc();
    createFolder(doc, { id: 'parent', name: 'Parent', parentId: null });
    createFolder(doc, { id: 'gone', name: 'Gone', parentId: 'parent' });
    createFolder(doc, { id: 'inner', name: 'Inner', parentId: 'gone' });
    registerNote(doc, { id: 'n1', folderId: 'gone' });
    registerNote(doc, { id: 'n2', folderId: 'inner' });

    deleteFolder(doc, 'gone');

    const t = tree(doc);
    expect(t.byId.has('gone')).toBe(false);
    expect(t.byId.has('inner')).toBe(false);
    expect(
      t.byId
        .get('parent')
        ?.notes.map((n) => n.id)
        .sort(),
    ).toEqual(['n1', 'n2']);
  });

  it('keeps the manual order of the notes it moves up', () => {
    const doc = new Y.Doc();
    createFolder(doc, { id: 'gone', name: 'Gone', parentId: null });
    createFolder(doc, { id: 'sub', name: 'Sub', parentId: 'gone' });
    registerNote(doc, { id: 'top', folderId: null });
    registerNote(doc, { id: 'c', folderId: 'gone', position: 'a1' });
    registerNote(doc, { id: 's', folderId: 'sub', position: 'a0' });
    registerNote(doc, { id: 'a', folderId: 'gone', position: 'a3' });
    registerNote(doc, { id: 'b', folderId: 'gone', position: 'a2' });
    deleteFolder(doc, 'gone');
    expect(tree(doc).notes.map((n) => n.id)).toEqual(['top', 'c', 'b', 'a', 's']);
  });

  it('shows a note moved into a folder deleted concurrently at the top level', () => {
    const a = new Y.Doc();
    createFolder(a, { id: 'f', name: 'F', parentId: null });
    registerNote(a, { id: 'n', folderId: null });
    const b = new Y.Doc();
    sync(a, b);
    deleteFolder(a, 'f');
    moveNote(b, 'n', 'f', 'a0');
    sync(a, b);
    expect(tree(a).notes.map((n) => n.id)).toEqual(['n']);
  });

  describe('folder Trash (T42, A560)', () => {
    const DAY = 24 * 60 * 60 * 1000;

    function garden() {
      const doc = new Y.Doc();
      createFolder(doc, { id: 'home', name: 'Home', parentId: null });
      createFolder(doc, { id: 'garden', name: 'Garden', parentId: 'home', position: 'a5' });
      createFolder(doc, { id: 'beds', name: 'Beds', parentId: 'garden' });
      createFolder(doc, { id: 'seeds', name: 'Seeds', parentId: 'garden' });
      setSortMode(doc, 'garden', 'alpha');
      setSortMode(doc, 'beds', 'modified');
      registerNote(doc, { id: 'plan', folderId: 'garden', position: 'a1' });
      registerNote(doc, { id: 'list', folderId: 'garden', position: 'a2' });
      registerNote(doc, { id: 'north', folderId: 'beds', position: 'a1' });
      registerNote(doc, { id: 'kept', folderId: 'home', position: 'a0' });
      return doc;
    }

    it('keeps a deleted folder in Trash with its subfolders and notes, and restores it all', () => {
      const doc = garden();
      const before = readWorkspace(doc);
      deleteFolder(doc, 'garden', null, {
        now: 1_000,
        by: { label: 'Claude Code', kind: 'agent' },
      });
      expect(
        readWorkspace(doc)
          .folders.map((folder) => folder.id)
          .sort(),
      ).toEqual(['home']);
      expect(readFolderTrash(doc, 2_000)).toEqual([
        {
          id: 'garden',
          name: 'Garden',
          parentId: 'home',
          deletedAt: 1_000,
          deletedBy: { label: 'Claude Code', kind: 'agent' },
          folders: 2,
          notes: 3,
          notebook: false,
        },
      ]);

      expect(restoreFolder(doc, 'garden')).toEqual({
        restored: true,
        parentGone: false,
        parentId: 'home',
        notes: 3,
        skipped: [],
        notebook: false,
        filed: [],
      });
      const after = readWorkspace(doc);
      const sorted = <T extends { id: string }>(items: readonly T[]) =>
        [...items].sort((a, b) => a.id.localeCompare(b.id));
      expect(sorted(after.folders)).toEqual(sorted(before.folders));
      expect(sorted(after.notes)).toEqual(sorted(before.notes));
      expect(readFolderTrash(doc, 2_000)).toEqual([]);
      // Again: it is not in Trash any more.
      expect(restoreFolder(doc, 'garden').restored).toBe(false);
    });

    it('leaves notes moved or deleted since where they are, and says which', () => {
      const doc = garden();
      deleteFolder(doc, 'garden');
      moveNote(doc, 'plan', null, 'z0');
      doc.transact(() => doc.get('notes').deleteAttr('north'));
      const restored = restoreFolder(doc, 'garden');
      expect(restored).toMatchObject({ restored: true, notes: 1 });
      expect([...restored.skipped].sort()).toEqual(['north', 'plan']);
      const notes = new Map(readWorkspace(doc).notes.map((note) => [note.id, note.folderId]));
      expect(notes.get('plan')).toBeNull();
      expect(notes.get('list')).toBe('garden');
      expect(notes.has('north')).toBe(false);
    });

    it('restores at the top level when the folder it was in is gone', () => {
      const doc = garden();
      deleteFolder(doc, 'garden');
      deleteFolder(doc, 'home');
      expect(readFolderTrash(doc).map((entry) => entry.id)).toEqual(
        expect.arrayContaining(['garden', 'home']),
      );
      const restored = restoreFolder(doc, 'garden');
      expect(restored).toMatchObject({ restored: true, parentGone: true });
      expect(readWorkspace(doc).folders.find((folder) => folder.id === 'garden')?.parentId).toBe(
        null,
      );
      // The notes the first delete moved into Home moved again with Home's delete: they stay.
      expect(restored.notes).toBe(0);
      expect(restored.skipped).toHaveLength(3);
    });

    it('syncs: a folder one device deletes, another restores', () => {
      const a = garden();
      const b = new Y.Doc();
      sync(a, b);
      deleteFolder(a, 'garden');
      sync(a, b);
      expect(readFolderTrash(b).map((entry) => entry.id)).toEqual(['garden']);
      restoreFolder(b, 'garden');
      sync(a, b);
      expect(readWorkspace(a).folders.some((folder) => folder.id === 'garden')).toBe(true);
      expect(readFolderTrash(a)).toEqual([]);
    });

    it(`forgets a deleted folder after ${FOLDER_TRASH_DAYS} days`, () => {
      const doc = garden();
      deleteFolder(doc, 'beds', null, { now: 0 });
      expect(readFolderTrash(doc, FOLDER_TRASH_DAYS * DAY - 1)).toHaveLength(1);
      expect(readFolderTrash(doc, FOLDER_TRASH_DAYS * DAY + 1)).toEqual([]);
      // The next delete drops it from the document.
      deleteFolder(doc, 'seeds', null, { now: FOLDER_TRASH_DAYS * DAY + 1 });
      expect([...doc.get('folderTrash').attrEntries()].map(([id]) => id)).toEqual(['seeds']);
    });
  });

  it('keeps per-user settings', () => {
    const a = new Y.Doc();
    setSetting(a, 'u1', 'theme', { name: 'moss', mode: 'dark' });
    setSetting(a, 'u1', 'timeZone', 'America/Chicago');
    setSetting(a, 'u2', 'theme', { name: 'paper', mode: 'light' });
    const b = new Y.Doc();
    sync(a, b);
    setSetting(b, 'u1', 'timeZone', undefined);
    sync(a, b);
    expect(readSettings(a, 'u1')).toEqual({ theme: { name: 'moss', mode: 'dark' } });
    expect(readSettings(a, 'u2')).toEqual({ theme: { name: 'paper', mode: 'light' } });
  });

  it("keeps both devices' first settings when they are written concurrently", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    setSetting(a, 'u1', 'theme', 'moss');
    setSetting(b, 'u1', 'timeZone', 'America/Chicago');
    sync(a, b);
    const expected = { theme: 'moss', timeZone: 'America/Chicago' };
    expect(readSettings(a, 'u1')).toEqual(expected);
    expect(readSettings(b, 'u1')).toEqual(expected);
    expect(readSettings(a, 'u')).toEqual({});
  });
});

// A674: one device files a note into a folder while another deletes that folder. Each delete
// moves only the notes it knew of, so the merge leaves the note filed in a folder that is gone.
// `rehomeNotes` moves it up as any folder delete moves notes (A560), and the folder's Trash
// record lists it, so Restore puts it back. The server runs it after each merge.
describe('rehomeNotes', () => {
  /** P > F, and a note at the top level; then a delete of F and a filing into F, concurrently. */
  function concurrentFileAndDelete() {
    const base = new Y.Doc();
    createFolder(base, { id: 'p', name: 'Parent', parentId: null });
    createFolder(base, { id: 'f', name: 'Doomed', parentId: 'p' });
    registerNote(base, { id: 'n', folderId: null });
    const deleter = new Y.Doc();
    Y.applyUpdate(deleter, Y.encodeStateAsUpdate(base));
    deleteFolder(deleter, 'f');
    const filer = new Y.Doc();
    Y.applyUpdate(filer, Y.encodeStateAsUpdate(base));
    moveNote(filer, 'n', 'f', 'a5');
    const merged = new Y.Doc();
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(deleter));
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(filer));
    return merged;
  }
  const noteOf = (doc: Y.Doc) => readWorkspace(doc).notes.find((note) => note.id === 'n');

  it('moves a note filed into a folder deleted meanwhile up to its parent, and Restore puts it back', () => {
    const merged = concurrentFileAndDelete();
    expect(noteOf(merged)?.folderId).toBe('f');

    expect(rehomeNotes(merged)).toEqual({ moved: 1, untracked: 0, folders: 0 });

    expect(noteOf(merged)?.folderId).toBe('p');
    expect(readFolderTrash(merged)).toMatchObject([{ id: 'f', notes: 1 }]);
    expect(restoreFolder(merged, 'f')).toMatchObject({ restored: true, notes: 1 });
    expect(noteOf(merged)).toMatchObject({ folderId: 'f', position: 'a5' });
  });

  it('changes nothing the second time, and nothing when no note is in a missing folder', () => {
    const merged = concurrentFileAndDelete();
    rehomeNotes(merged);
    const after = Y.encodeStateVector(merged);
    expect(rehomeNotes(merged)).toEqual({ moved: 0, untracked: 0, folders: 0 });
    expect(Y.encodeStateVector(merged)).toEqual(after);
  });

  it('gives the same result wherever it runs on the same state', () => {
    const one = concurrentFileAndDelete();
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    rehomeNotes(one);
    rehomeNotes(two);
    expect(readWorkspace(two)).toEqual(readWorkspace(one));
    expect(readFolderTrash(two)).toEqual(readFolderTrash(one));
  });

  // Fail closed (T43 review B1, A757): with no record of where the folder was, the note's notebook
  // is unknown, so it stays where it is, held by every mirror, rather than go to the top level
  // (the default notebook's, which its repository would publish).
  it('keeps a note whose folder has no Trash record where it is, and says so', () => {
    const doc = new Y.Doc();
    registerNote(doc, { id: 'n', folderId: null });
    doc.transact(() => (doc.get('notes').getAttr('n') as Y.Node).setAttr('folder', 'never-made'));
    expect(rehomeNotes(doc)).toEqual({ moved: 0, untracked: 1, folders: 0 });
    expect(noteOf(doc)?.folderId).toBe('never-made');
  });

  // Review of #132, N-c: two repairs of different notes into one Trash record, on two devices,
  // keep both listings (one key per note, not one list each side replaces).
  it('keeps both listings when two devices each move a note into one Trash record', () => {
    const base = new Y.Doc();
    createFolder(base, { id: 'f', name: 'Doomed', parentId: null });
    registerNote(base, { id: 'n1', folderId: null });
    registerNote(base, { id: 'n2', folderId: null });
    deleteFolder(base, 'f');
    const stray = (doc: Y.Doc, id: string) =>
      doc.transact(() => (doc.get('notes').getAttr(id) as Y.Node).setAttr('folder', 'f'));
    const one = new Y.Doc();
    Y.applyUpdate(one, Y.encodeStateAsUpdate(base));
    stray(one, 'n1');
    rehomeNotes(one);
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(base));
    stray(two, 'n2');
    rehomeNotes(two);
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));

    expect(readFolderTrash(one)).toMatchObject([{ id: 'f', notes: 2 }]);
    expect(restoreFolder(one, 'f')).toMatchObject({ restored: true, notes: 2 });
  });

  it('still reads the notes an older record lists in its one list', () => {
    const merged = concurrentFileAndDelete();
    // As a record written before per-note keys: deleteFolder's own list holds them all.
    expect(readFolderTrash(merged)).toMatchObject([{ id: 'f', notes: 0 }]);
    rehomeNotes(merged);
    expect(readFolderTrash(merged)).toMatchObject([{ id: 'f', notes: 1 }]);
  });

  // Review of #132, N-d: a folder id the tree keeps as a plain value is there, not missing.
  it('never moves a note out of a folder held as a value rather than a node', () => {
    const doc = new Y.Doc();
    registerNote(doc, { id: 'n', folderId: null });
    doc.transact(() => {
      doc.get('folders').setAttr('odd', 'a folder written as a value' as never);
      (doc.get('notes').getAttr('n') as Y.Node).setAttr('folder', 'odd');
    });
    expect(rehomeNotes(doc)).toEqual({ moved: 0, untracked: 0, folders: 0 });
    expect(noteOf(doc)?.folderId).toBe('odd');
  });

  it('leaves notes `which` does not pick', () => {
    const merged = concurrentFileAndDelete();
    expect(rehomeNotes(merged, () => false)).toEqual({ moved: 0, untracked: 0, folders: 0 });
    expect(noteOf(merged)?.folderId).toBe('f');
  });
});
