/** Notebooks in the WorkspaceDoc (T43, A750, A751, A756). */
import { notebookIndex } from '@penmoss/core/workspace';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import {
  createFolder,
  defaultNotebookName,
  deleteFolder,
  moveFolder,
  moveNote,
  notebookOfFolder,
  notebookPlaces,
  notebookTrashNotes,
  readFolderTrash,
  readWorkspace,
  registerNote,
  rehomeNotes,
  restoreFolder,
  setDefaultNotebookName,
  setNotebook,
  trashAsNotebook,
  WorkspaceError,
} from '../src/workspace';

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function workspace() {
  const doc = new Y.Doc();
  createFolder(doc, { id: 'work', name: 'Work', parentId: null, notebook: true });
  createFolder(doc, { id: 'specs', name: 'Specs', parentId: 'work' });
  createFolder(doc, { id: 'home', name: 'Home', parentId: null });
  registerNote(doc, { id: 'plan', folderId: 'work', position: 'a1' });
  registerNote(doc, { id: 'spec', folderId: 'specs', position: 'a1' });
  registerNote(doc, { id: 'list', folderId: 'home', position: 'a1' });
  registerNote(doc, { id: 'top', folderId: null, position: 'a1' });
  return doc;
}

describe('notebooks in the workspace document (T43)', () => {
  it('flags only the notebook folder, and reads other folders exactly as before', () => {
    const doc = workspace();
    const { folders } = readWorkspace(doc);
    expect(folders.find((f) => f.id === 'work')).toMatchObject({ notebook: true });
    // No `notebook` key at all on other folders: a tree without notebooks is unchanged.
    expect(Object.keys(folders.find((f) => f.id === 'home')!)).not.toContain('notebook');
    expect(() =>
      createFolder(doc, { id: 'x', name: 'X', parentId: 'home', notebook: true }),
    ).toThrow(WorkspaceError);
  });

  it('turns a top-level folder into a notebook and back in one step', () => {
    const doc = workspace();
    setNotebook(doc, 'home', true);
    expect(notebookIndex(readWorkspace(doc).folders).ofFolder('home')).toBe('home');
    setNotebook(doc, 'home', false);
    expect(notebookIndex(readWorkspace(doc).folders).ofFolder('home')).toBeNull();
    expect(() => setNotebook(doc, 'specs', true)).toThrow(/top-level/);
  });

  it('refuses to nest a notebook', () => {
    const doc = workspace();
    expect(() => moveFolder(doc, 'work', 'home', 'a0')).toThrow(/top level/);
    // Folders move in and out of notebooks freely.
    moveFolder(doc, 'home', 'work', 'a9');
    expect(notebookIndex(readWorkspace(doc).folders).ofFolder('home')).toBe('work');
  });

  it('sends a deleted notebook to Trash with every note in it, never up into the default', () => {
    const doc = workspace();
    const deleted = deleteFolder(doc, 'work', null, { now: 1_000 });
    expect(deleted).toEqual({ notebook: true, trashed: ['plan', 'spec'] });
    const after = readWorkspace(doc);
    expect(after.folders.map((f) => f.id)).toEqual(['home']);
    // Its notes left the registry: none of them is now at the top level.
    expect(after.notes.map((n) => n.id).sort()).toEqual(['list', 'top']);
    expect(readFolderTrash(doc, 2_000)).toMatchObject([
      { id: 'work', notebook: true, notes: 2, folders: 1 },
    ]);
    expect([...notebookTrashNotes(doc, 2_000)]).toEqual([
      ['plan', 'work'],
      ['spec', 'work'],
    ]);
  });

  it('restores a notebook as a unit: its folders, its flag and its notes where they were', () => {
    const doc = workspace();
    const before = readWorkspace(doc);
    deleteFolder(doc, 'work');
    const restored = restoreFolder(doc, 'work');
    expect(restored).toMatchObject({ restored: true, notebook: true, notes: 2 });
    expect([...restored.filed].sort()).toEqual(['plan', 'spec']);
    const after = readWorkspace(doc);
    const byId = <T extends { id: string }>(items: readonly T[]) =>
      [...items].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(after.folders)).toEqual(byId(before.folders));
    expect(byId(after.notes)).toEqual(byId(before.notes));
    expect(notebookTrashNotes(doc).size).toBe(0);
  });

  it('leaves a note restored on its own where it is now', () => {
    const doc = workspace();
    deleteFolder(doc, 'work');
    registerNote(doc, { id: 'plan', folderId: 'home' });
    const restored = restoreFolder(doc, 'work');
    expect(restored.skipped).toEqual(['plan']);
    expect(readWorkspace(doc).notes.find((n) => n.id === 'plan')?.folderId).toBe('home');
  });

  it('sends a note filed into the notebook as it was deleted to Trash with it', () => {
    const a = workspace();
    const b = new Y.Doc();
    sync(a, b);
    deleteFolder(a, 'work');
    registerNote(b, { id: 'late', folderId: 'specs' });
    sync(a, b);
    // The merge leaves `late` filed in a folder that is gone; the repair (A674) runs on it.
    expect(rehomeNotes(a)).toEqual({ moved: 1, untracked: 0, folders: 0 });
    expect(readWorkspace(a).notes.some((n) => n.id === 'late')).toBe(false);
    expect(notebookTrashNotes(a).get('late')).toBe('work');
    expect(restoreFolder(a, 'work').filed).toContain('late');
  });

  it('names the default notebook, "Personal" until someone does', () => {
    const doc = workspace();
    expect(defaultNotebookName(readWorkspace(doc))).toBe('Personal');
    setDefaultNotebookName(doc, '  Life ');
    expect(defaultNotebookName(readWorkspace(doc))).toBe('Life');
    setDefaultNotebookName(doc, '');
    expect(readWorkspace(doc).defaultNotebookName).toBeUndefined();
  });
});

describe('each note’s notebook, as the record writers read it (T43, A766)', () => {
  it('maps each certainly placed note to its notebook key', () => {
    const doc = workspace();
    expect(Object.fromEntries(notebookPlaces(doc))).toEqual({
      plan: 'work',
      spec: 'work',
      list: 'default',
      top: 'default',
    });
    expect(notebookOfFolder(doc, 'specs')).toBe('work');
    expect(notebookOfFolder(doc, 'home')).toBe('default');
    expect(notebookOfFolder(doc, null)).toBe('default');
    // A folder this document doesn't hold: not certain, so no record is written for it.
    expect(notebookOfFolder(doc, 'nowhere')).toBeNull();
  });

  it('turns a folder deleted as a folder into a deleted notebook, its notes into Trash', () => {
    const doc = workspace();
    // Deleted before this device saw it flagged: its notes moved up to the top level.
    setNotebook(doc, 'work', false);
    deleteFolder(doc, 'work');
    expect(
      readWorkspace(doc)
        .notes.map((note) => note.id)
        .sort(),
    ).toEqual(['list', 'plan', 'spec', 'top']);
    // A note moved on since the delete stays where it is.
    moveNote(doc, 'spec', 'home', 'a2');
    expect(trashAsNotebook(doc, 'work')).toEqual(['plan']);
    expect(
      readWorkspace(doc)
        .notes.map((note) => note.id)
        .sort(),
    ).toEqual(['list', 'spec', 'top']);
    expect([...notebookTrashNotes(doc).keys()]).toEqual(['plan']);
    // Already a notebook's record: nothing more happens.
    expect(trashAsNotebook(doc, 'work')).toEqual([]);
    expect(trashAsNotebook(doc, 'unknown')).toEqual([]);
  });
});
