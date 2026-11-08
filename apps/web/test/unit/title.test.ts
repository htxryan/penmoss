import { readTitle, setTitle } from '@penmoss/sync-client/note';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { describe, expect, it } from 'vitest';
import { bindTitleField, mapPosition, pastedTitle, type TitleField } from '../../src/notes/title';

/** An <input> stand-in: value, selection and input listeners. */
function fakeField(): TitleField & { type(value: string, caret?: number): void } {
  const listeners = new Set<() => void>();
  const field = {
    value: '',
    selectionStart: 0 as number | null,
    selectionEnd: 0 as number | null,
    setSelectionRange(start: number, end: number) {
      field.selectionStart = start;
      field.selectionEnd = end;
    },
    addEventListener: (_type: 'input', listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: 'input', listener: () => void) => void listeners.delete(listener),
    type(value: string, caret = value.length) {
      field.value = value;
      field.setSelectionRange(caret, caret);
      for (const listener of listeners) listener();
    },
  };
  return field;
}

function exchange(
  a: ReturnType<typeof createYjs14Replica>,
  b: ReturnType<typeof createYjs14Replica>,
) {
  b.applyUpdate(a.encodeStateAsUpdate(b.encodeStateVector()), 'remote');
  a.applyUpdate(b.encodeStateAsUpdate(a.encodeStateVector()), 'remote');
}

describe('mapPosition', () => {
  it('keeps positions before a change and shifts those after it', () => {
    expect(mapPosition('hello world', 'hello big world', 3)).toBe(3);
    expect(mapPosition('hello world', 'hello big world', 8)).toBe(12);
    expect(mapPosition('hello world', 'world', 8)).toBe(2);
  });

  it('moves positions inside a replaced range to its end', () => {
    expect(mapPosition('abcdef', 'abXYef', 3)).toBe(4);
  });
});

describe('bindTitleField', () => {
  it('shows the stored title and writes typing to the document', () => {
    const replica = createYjs14Replica();
    setTitle(replica.doc, 'Draft');
    const field = fakeField();
    const unbind = bindTitleField(field, replica);
    expect(field.value).toBe('Draft');

    field.type('Draft plan');
    expect(readTitle(replica.doc)).toBe('Draft plan');

    unbind();
    field.type('ignored');
    expect(readTitle(replica.doc)).toBe('Draft plan');
  });

  it('keeps text typed before the note loaded when the note has no title yet', () => {
    const replica = createYjs14Replica();
    const field = fakeField();
    field.value = 'Quick th';
    bindTitleField(field, replica);
    expect(readTitle(replica.doc)).toBe('Quick th');
    expect(field.value).toBe('Quick th');

    const titled = createYjs14Replica();
    setTitle(titled.doc, 'Stored');
    const other = fakeField();
    other.value = 'stray';
    bindTitleField(other, titled);
    expect(other.value).toBe('Stored');
    expect(readTitle(titled.doc)).toBe('Stored');
  });

  it('merges a concurrent remote edit and keeps the caret on the same text', () => {
    const mine = createYjs14Replica();
    const theirs = createYjs14Replica();
    setTitle(mine.doc, 'Trip notes');
    exchange(mine, theirs);
    const field = fakeField();
    bindTitleField(field, mine);

    field.type('Trip notes!', 11); // caret at the end
    setTitle(theirs.doc, 'Paris Trip notes');
    exchange(mine, theirs);

    expect(field.value).toBe('Paris Trip notes!');
    expect(readTitle(theirs.doc)).toBe('Paris Trip notes!');
    expect(field.selectionStart).toBe(17);
  });
});

describe('pastedTitle', () => {
  it('keeps a pasted title on one line, line breaks as spaces (T15)', () => {
    expect(pastedTitle('Trip planning')).toBe('Trip planning');
    expect(pastedTitle('# Trip\r\n\n  planning\n')).toBe('# Trip planning');
    expect(pastedTitle(' and more')).toBe(' and more');
    expect(pastedTitle('a\tb')).toBe('a\tb');
  });

  it('drops control characters, which show as boxes and break file names (T39)', () => {
    expect(pastedTitle('Bell\u0007 and \u0000null\u001b[0m')).toBe('Bell and null[0m');
    expect(pastedTitle('Tab\tstays\u007f')).toBe('Tab\tstays');
  });

  it('drops C1 controls and bidi overrides, and breaks at Unicode line separators (T39 review)', () => {
    expect(pastedTitle('Next\u0085line\u009b')).toBe('Nextline');
    expect(pastedTitle('\u202eevil\u202c and \u2066isolated\u2069')).toBe('evil and isolated');
    expect(pastedTitle('One\u2028two\u2029three')).toBe('One two three');
  });
});
