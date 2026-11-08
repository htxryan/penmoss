import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import {
  initNote,
  isoWithOffset,
  readIdentity,
  readNoteNotebook,
  readTitle,
  setNoteNotebook,
  setTitle,
} from '../src/note';

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('note layout', () => {
  it('stores identity and title', () => {
    const doc = new Y.Doc();
    initNote(
      doc,
      { id: '01JD2Z7Q8R4T6Y8W0E2R4T6Y8W', created: '2026-10-22T09:00:00-05:00', kind: 'note' },
      'Garden',
    );

    expect(readTitle(doc)).toBe('Garden');
    expect(readIdentity(doc)).toEqual({
      id: '01JD2Z7Q8R4T6Y8W0E2R4T6Y8W',
      created: '2026-10-22T09:00:00-05:00',
      kind: 'note',
    });
  });

  it('merges concurrent title edits by character', () => {
    const a = new Y.Doc();
    setTitle(a, 'Garden plan');
    const b = new Y.Doc();
    sync(a, b);

    setTitle(a, 'Spring garden plan');
    setTitle(b, 'Garden plan 2027');
    sync(a, b);

    expect(readTitle(a)).toBe('Spring garden plan 2027');
    expect(readTitle(b)).toBe(readTitle(a));
  });

  it('keeps the title on one line and skips no-op writes', () => {
    const doc = new Y.Doc();
    let updates = 0;
    doc.on('update', () => updates++);
    setTitle(doc, 'One\ntwo');
    setTitle(doc, 'One two');

    expect(readTitle(doc)).toBe('One two');
    expect(updates).toBe(1);
  });

  it('ignores identity attributes of the wrong type', () => {
    const doc = new Y.Doc();
    doc.get('meta').setAttr('kind', 'diary');
    doc.get('meta').setAttr('id', 42);
    expect(readIdentity(doc)).toEqual({});
  });

  it('formats local time with its offset', () => {
    expect(isoWithOffset(new Date(2026, 9, 22, 9, 5, 7))).toMatch(
      /^2026-10-22T09:05:07[+-]\d{2}:\d{2}$/,
    );
  });
});

describe('the notebook a note records (T43, A766)', () => {
  it('is set at creation, changed by a move, and a no-op when unchanged', () => {
    const doc = new Y.Doc();
    expect(readNoteNotebook(doc)).toBeNull();
    initNote(doc, {
      id: 'n1',
      created: '2026-10-22T09:00:00-05:00',
      kind: 'note',
      notebook: 'work',
    });
    expect(readNoteNotebook(doc)).toBe('work');
    expect(readIdentity(doc)).not.toHaveProperty('notebook');
    let changes = 0;
    doc.on('update', () => changes++);
    setNoteNotebook(doc, 'work');
    expect(changes).toBe(0);
    setNoteNotebook(doc, 'default');
    expect(changes).toBe(1);
    expect(readNoteNotebook(doc)).toBe('default');
  });

  it('merges as one value: the later move wins on both replicas', () => {
    const a = new Y.Doc();
    initNote(a, { id: 'n1', created: '2026-10-22T09:00:00-05:00', kind: 'note', notebook: 'work' });
    const b = new Y.Doc();
    sync(a, b);
    setNoteNotebook(a, 'default');
    setNoteNotebook(b, 'home');
    sync(a, b);
    expect(readNoteNotebook(a)).toBe(readNoteNotebook(b));
  });
});
