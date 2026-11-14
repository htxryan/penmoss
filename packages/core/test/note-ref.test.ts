import { describe, expect, it } from 'vitest';
import {
  isShortNoteRef,
  matchNoteRef,
  notebookTag,
  noteRefNamer,
  parseNoteRef,
  shortNoteRef,
} from '../src/note-ref';

const NOTEBOOK = '01JQ7M1WQ3R4ZK3V8N2C5D6E7F';
const NOTE = '01M6VAE8YFZ99TCZV2SXF7SQ9W';
// Another note ending as NOTE does, made later.
const LATER = '01M6VB000000000000SXF7SQ9W';

describe('short note references (PEN-69)', () => {
  it('names a notebook by 4 Crockford base32 characters of its id’s hash, stable everywhere', () => {
    const tag = notebookTag(NOTEBOOK);
    expect(tag).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(notebookTag(NOTEBOOK)).toBe(tag);
    expect(notebookTag('01JQ7M1WQ3R4ZK3V8N2C5D6E7G')).not.toBe(tag);
    expect(notebookTag(` ${NOTEBOOK} `)).toBe(tag);
  });

  it('is the notebook’s tag and the note id’s last 8 characters', () => {
    expect(shortNoteRef(NOTEBOOK, NOTE)).toBe(`${notebookTag(NOTEBOOK)}-SXF7SQ9W`);
  });

  it('reads either form in any case, Crockford look-alikes as digits', () => {
    const tag = notebookTag(NOTEBOOK);
    expect(parseNoteRef(`${tag.toLowerCase()}-sxf7sq9w`)).toEqual({
      kind: 'short',
      notebook: tag,
      note: 'SXF7SQ9W',
    });
    expect(parseNoteRef('K7QD-9HTF2CXO')).toEqual({
      kind: 'short',
      notebook: 'K7QD',
      note: '9HTF2CX0',
    });
    expect(parseNoteRef(NOTE.toLowerCase())).toEqual({ kind: 'id', id: NOTE });
    expect(parseNoteRef(` ${NOTE} `)).toEqual({ kind: 'id', id: NOTE });
    expect(parseNoteRef('welcome-note')).toEqual({ kind: 'id', id: 'welcome-note' });
    expect(isShortNoteRef(`${tag}-${NOTE}`)).toBe(true);
    expect(isShortNoteRef('K7QD-9HTF2C')).toBe(false);
  });

  it('never names two notes: after a clash the later note’s reference is its whole id', () => {
    expect(LATER).toHaveLength(26);
    expect(LATER > NOTE).toBe(true);
    const tag = notebookTag(NOTEBOOK);
    const ids = [LATER, NOTE];
    expect(shortNoteRef(NOTEBOOK, NOTE, ids)).toBe(`${tag}-SXF7SQ9W`);
    expect(shortNoteRef(NOTEBOOK, LATER, ids)).toBe(`${tag}-${LATER}`);
    const named = noteRefNamer(NOTEBOOK, ids);
    expect(named(NOTE)).toBe(`${tag}-SXF7SQ9W`);
    expect(named(LATER)).toBe(`${tag}-${LATER}`);
    // Each reference resolves to its own note, whatever order the ids come in.
    for (const order of [ids, [...ids].reverse()]) {
      const short = parseNoteRef(named(NOTE));
      const long = parseNoteRef(named(LATER));
      expect(short.kind === 'short' && matchNoteRef(short.note, order)).toBe(NOTE);
      expect(long.kind === 'short' && matchNoteRef(long.note, order)).toBe(LATER);
    }
  });

  it('matches nothing for a note the notebook does not hold, and keeps non-ULID ids whole', () => {
    expect(matchNoteRef('ZZZZZZZZ', [NOTE])).toBeNull();
    expect(shortNoteRef(NOTEBOOK, 'welcome')).toBe('welcome');
    expect(noteRefNamer(NOTEBOOK, [])('welcome')).toBe('welcome');
  });
});
