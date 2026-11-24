/**
 * Journal and Inbox filing (T19, T30, A820): the Mac, the phone and the CLI all file through
 * these, and the folder ids are stored and merged across devices, so they are pinned here to the
 * values every earlier build made.
 */
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import {
  createFolder,
  fileJournalNote,
  inboxFolder,
  INBOX,
  readWorkspace,
  registerNote,
} from '../src/workspace';

const SALT = '01JNOTEBOOK0000000000000000';

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

const folders = (doc: Y.Doc) =>
  readWorkspace(doc)
    .folders.map(({ id, name, parentId }) => ({ id, name, parentId }))
    .sort((a, b) => a.id.localeCompare(b.id));

describe('fileJournalNote', () => {
  it('files a daily note under Journal/<year>/<month>, with the ids every device makes', () => {
    const doc = new Y.Doc();
    fileJournalNote(doc, 'day', 'daily', '2026-10-22', SALT);
    expect(folders(doc)).toEqual([
      { id: '000000000002BAF9RM6YWV5S38', name: '10', parentId: '0000000000M6S1XJ4S21QDVDXX' },
      { id: '00000000005Z646NR4FHPHGSRQ', name: 'Journal', parentId: null },
      { id: '0000000000M6S1XJ4S21QDVDXX', name: '2026', parentId: '00000000005Z646NR4FHPHGSRQ' },
    ]);
    expect(readWorkspace(doc).notes.find((note) => note.id === 'day')?.folderId).toBe(
      '000000000002BAF9RM6YWV5S38',
    );
  });

  it('files a weekly note under Journal/<year>/Weekly, beside the months', () => {
    const doc = new Y.Doc();
    fileJournalNote(doc, 'day', 'daily', '2026-10-22', SALT);
    fileJournalNote(doc, 'week', 'weekly', '2026-W43', SALT);
    expect(folders(doc)).toHaveLength(4);
    expect(readWorkspace(doc).notes.find((note) => note.id === 'week')?.folderId).toBe(
      '0000000000T0P8HEBNGHSRQ0PX',
    );
  });

  it('keeps the unsalted ids for the notebook imported from the personal workspace', () => {
    for (const salt of [undefined, '']) {
      const doc = new Y.Doc();
      fileJournalNote(doc, 'day', 'daily', '2026-10-22', salt);
      expect(readWorkspace(doc).notes[0]?.folderId).toBe('0000000000W0FMBFGYJBDC9DN6');
    }
  });

  it('leaves a note already filed where it is, and two devices offline make one set of folders', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    createFolder(a, { id: 'mine', name: 'Mine', parentId: null });
    registerNote(a, { id: 'day', folderId: 'mine' });
    fileJournalNote(a, 'day', 'daily', '2026-10-22', SALT);
    expect(folders(a)).toEqual([{ id: 'mine', name: 'Mine', parentId: null }]);

    fileJournalNote(b, 'other', 'daily', '2026-10-23', SALT);
    const c = new Y.Doc();
    fileJournalNote(c, 'other', 'daily', '2026-10-23', SALT);
    sync(b, c);
    expect(folders(b)).toEqual(folders(c));
    expect(folders(b)).toHaveLength(3);
  });
});

describe('inboxFolder', () => {
  it('makes the derived Inbox once, with the id every device makes', () => {
    const doc = new Y.Doc();
    expect(inboxFolder(doc, SALT)).toBe('0000000000A9WAXEW6RP7DK6Z8');
    expect(inboxFolder(doc, SALT)).toBe('0000000000A9WAXEW6RP7DK6Z8');
    expect(folders(doc)).toEqual([{ id: '0000000000A9WAXEW6RP7DK6Z8', name: INBOX, parentId: null }]);
    expect(inboxFolder(new Y.Doc())).toBe('0000000000ER2EH9S3C9F6Z509');
  });

  it("uses the notebook's own top-level Inbox, in any case, and never a nested one", () => {
    const doc = new Y.Doc();
    createFolder(doc, { id: 'work', name: 'Work', parentId: null });
    createFolder(doc, { id: 'nested', name: 'Inbox', parentId: 'work' });
    createFolder(doc, { id: 'own', name: ' inbox ', parentId: null });
    expect(inboxFolder(doc, SALT)).toBe('own');
    expect(folders(doc)).toHaveLength(3);
  });
});
