/**
 * Delete for good's mark in the WorkspaceDoc (A828), and Keep note taking it back before it lands
 * (A855): the note goes back where it was filed, and marking it again undoes that.
 */
import { createFolder, readWorkspace, registerNote } from '@penmoss/sync-client/workspace';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { isPurged, markPurged, markRecoveredFrom, recoveredFromOf, unmarkPurged } from '../src';
import { readTitle } from '@penmoss/sync-client/note';
import { testNotebook } from './support/notebooks';

const NOTE = '01JBN0000000000000000000A1';
const FOLDER = '01JBF0000000000000000000B1';

function filed(doc: Y.Doc) {
  return readWorkspace(doc).notes.find((note) => note.id === NOTE) ?? null;
}

describe('Keep note (A855)', () => {
  it('puts the note back in its folder, at its place; marking it again undoes that', () => {
    const doc = new Y.Doc();
    createFolder(doc, { id: FOLDER, name: 'Work', parentId: null });
    registerNote(doc, { id: NOTE, folderId: FOLDER, position: 'a5' });
    markPurged(doc, NOTE, 1);
    expect(isPurged(doc, NOTE)).toBe(true);
    expect(filed(doc)).toBeNull();
    unmarkPurged(doc, NOTE);
    expect(isPurged(doc, NOTE)).toBe(false);
    expect(filed(doc)).toMatchObject({ folderId: FOLDER, position: 'a5' });
    // Undo: marked again, and Keep again puts it back in the same place.
    markPurged(doc, NOTE, 2);
    expect(isPurged(doc, NOTE)).toBe(true);
    expect(filed(doc)).toBeNull();
    unmarkPurged(doc, NOTE);
    expect(filed(doc)).toMatchObject({ folderId: FOLDER, position: 'a5' });
  });

  it('a note in Trash (not filed) stays in Trash; a folder since gone means the top level', () => {
    const trash = new Y.Doc();
    markPurged(trash, NOTE, 1);
    unmarkPurged(trash, NOTE);
    expect(isPurged(trash, NOTE)).toBe(false);
    expect(filed(trash)).toBeNull();
    const gone = new Y.Doc();
    createFolder(gone, { id: FOLDER, name: 'Work', parentId: null });
    registerNote(gone, { id: NOTE, folderId: FOLDER });
    markPurged(gone, NOTE, 1);
    gone.get('folders').deleteAttr(FOLDER);
    unmarkPurged(gone, NOTE);
    expect(filed(gone)).toMatchObject({ folderId: null });
  });
});

describe('copies brought back after a store was cleared (A886)', () => {
  /** The WorkspaceDoc at head, every writer's log merged. */
  const workspaceAtHead = async (nb: ReturnType<typeof testNotebook>) => {
    const reader = await nb.open('Reader');
    await reader.engine.sync();
    return reader.engine.replica.workspace;
  };

  it('without a store of its own for them, the engine keeps a withheld copy whole in its bookkeeping', async () => {
    const nb = testNotebook();
    const mac = await nb.open('Mac', { create: true });
    const origin = mac.ops.createNote({ title: 'Passwords', markdown: 'hunter2' });
    await mac.engine.sync();
    const phone = await nb.open('Phone');
    await phone.engine.sync();
    // A copy as a recovery makes one, then the original is deleted for good elsewhere.
    const copy = phone.ops.createNote({
      title: 'Passwords (recovered)',
      markdown: 'hunter2 and more',
    });
    markRecoveredFrom(phone.engine.replica.workspace, copy, origin);
    mac.ops.purge(origin);
    await mac.engine.sync();
    await phone.engine.sync();
    expect(phone.engine.replica.note(copy)).toBeUndefined();
    const kept = phone.engine.withheld()[copy]!;
    expect(kept).toMatchObject({ origin, title: 'Passwords (recovered)' });
    const doc = new Y.Doc();
    Y.applyUpdate(
      doc,
      Uint8Array.from(atob(kept.update!), (c) => c.charCodeAt(0)),
    );
    expect(readTitle(doc)).toBe('Passwords (recovered)');
    expect(nb.files().some((path) => path.includes(copy))).toBe(false);
    expect(recoveredFromOf(await workspaceAtHead(nb)).has(copy)).toBe(false);
  });

  it('a copy’s entry never lands without its own log: one whose content is gone here leaves the tree', async () => {
    const nb = testNotebook();
    const phone = await nb.open('Phone', { create: true });
    const origin = phone.ops.createNote({ title: 'Plans', markdown: 'plans' });
    await phone.engine.sync();
    const copy = phone.ops.createNote({ title: 'Plans (recovered)', markdown: 'more plans' });
    markRecoveredFrom(phone.engine.replica.workspace, copy, origin);
    // Its doc lost (a store cut short): only its entry and its link are left here.
    phone.engine.replica.dropNoteFromGit(copy);
    await phone.engine.sync();
    expect(nb.files().some((path) => path.includes(copy))).toBe(false);
    const atHead = await workspaceAtHead(nb);
    expect(recoveredFromOf(atHead).has(copy)).toBe(false);
    expect(readWorkspace(atHead).notes.map((note) => note.id)).toEqual([origin]);
  });
});
