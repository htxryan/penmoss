import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { readTitle, setTitle } from '@penmoss/sync-client/note';
import { describe, expect, it } from 'vitest';
import { bindTitleField } from '../../src/notes/title';
import {
  fitHeight,
  growingTitle,
  isLineBreak,
  queueEnter,
  typedAfterEnter,
  type GrowingField,
} from '../../src/notes/title-field';

/** A <textarea> stand-in whose content height is one 40 px line per 30 characters. */
function fakeTextarea(): GrowingField & { heights: string[]; input(): void; listening(): number } {
  const heights: string[] = [];
  const listeners = new Set<() => void>();
  const field = {
    value: '',
    selectionStart: 0 as number | null,
    selectionEnd: 0 as number | null,
    heights,
    style: {
      set height(value: string) {
        heights.push(value);
      },
      get height() {
        return heights.at(-1) ?? '';
      },
    },
    get scrollHeight() {
      return Math.max(1, Math.ceil(field.value.length / 30)) * 40;
    },
    setSelectionRange(start: number, end: number) {
      field.selectionStart = start;
      field.selectionEnd = end;
    },
    addEventListener: (_type: 'input', listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: 'input', listener: () => void) => void listeners.delete(listener),
    /** The browser's input event, after the text changed. */
    input: () => listeners.forEach((listener) => listener()),
    listening: () => listeners.size,
  };
  return field;
}

describe('the growing title field (T39)', () => {
  it('fits its height to the text where the browser does not', () => {
    const field = fakeTextarea();
    field.value = 'x'.repeat(75);
    fitHeight(field, false);
    // Reset first, so a shorter title shrinks the field again.
    expect(field.heights).toEqual(['auto', '120px']);
  });

  it('leaves the height to CSS where the browser sizes fields itself', () => {
    const field = fakeTextarea();
    field.value = 'x'.repeat(75);
    fitHeight(field, true);
    expect(field.heights).toEqual([]);
  });

  it('grows when the note opens and when another device renames it', () => {
    const field = fakeTextarea();
    const replica = createYjs14Replica();
    setTitle(replica.doc, 'Short');
    const unbind = bindTitleField(growingTitle(field, false), replica);
    expect(field.value).toBe('Short');
    expect(field.style.height).toBe('40px');

    setTitle(replica.doc, 'A much longer title that wraps over three lines of the column');
    expect(field.style.height).toBe('120px');
    unbind();
  });

  it('passes the caret through to the field', () => {
    const field = fakeTextarea();
    const title = growingTitle(field, false);
    title.value = 'Garden plan';
    title.setSelectionRange(2, 4);
    expect([title.selectionStart, title.selectionEnd]).toEqual([2, 4]);
  });

  it('knows the input types that would break the title onto a new line', () => {
    expect(isLineBreak('insertLineBreak')).toBe(true);
    expect(isLineBreak('insertParagraph')).toBe(true);
    expect(isLineBreak('insertText')).toBe(false);
    expect(isLineBreak('insertFromPaste')).toBe(false);
  });
});

describe('the title kept to one line as typed (T39 review)', () => {
  /** Text inserted at the caret as plain input, as dictation or a text replacement does. */
  const insert = (field: ReturnType<typeof fakeTextarea>, text: string) => {
    const at = field.selectionStart ?? field.value.length;
    field.value = field.value.slice(0, at) + text + field.value.slice(at);
    field.setSelectionRange(at + text.length, at + text.length);
    field.input();
  };

  it('turns a line break typed without Enter into a space, before the title is stored', () => {
    const field = fakeTextarea();
    const replica = createYjs14Replica();
    const unbind = bindTitleField(growingTitle(field, false), replica);
    insert(field, 'Shopping');
    insert(field, '\nlist');
    expect(field.value).toBe('Shopping list');
    expect(readTitle(replica.doc)).toBe('Shopping list');
    expect([field.selectionStart, field.selectionEnd]).toEqual([13, 13]);

    // In the middle, with a run of breaks and a Unicode line separator: one space each.
    field.setSelectionRange(8, 8);
    insert(field, '\r\n\n,\u2028and');
    expect(field.value).toBe('Shopping , and list');
    expect(readTitle(replica.doc)).toBe('Shopping , and list');
    expect(field.selectionStart).toBe(14);

    unbind();
    expect(field.listening()).toBe(0);
  });

  it('drops control and bidi override characters as they are typed', () => {
    const field = fakeTextarea();
    const replica = createYjs14Replica();
    const unbind = bindTitleField(growingTitle(field, false), replica);
    insert(field, 'Plan\u0007\u202e b\u0085');
    expect(field.value).toBe('Plan b');
    expect(readTitle(replica.doc)).toBe('Plan b');
    expect(field.selectionStart).toBe(6);
    unbind();
  });

  it('leaves ordinary typing, tabs included, as it is', () => {
    const field = fakeTextarea();
    const replica = createYjs14Replica();
    const unbind = bindTitleField(growingTitle(field, false), replica);
    insert(field, 'Café\tnotes ✓');
    expect(field.value).toBe('Café\tnotes ✓');
    expect(readTitle(replica.doc)).toBe('Café\tnotes ✓');
    unbind();
  });
});

describe('an Enter queued before the body opens (A1179)', () => {
  const at = (value: string, start: number, end = start) =>
    queueEnter({ value, selectionStart: start, selectionEnd: end });

  it('gives what was typed after it, at the end or inside the title', () => {
    expect(typedAfterEnter(at('Groceries', 9), 'GroceriesMilk and eggs')).toBe('Milk and eggs');
    expect(typedAfterEnter(at('Grocery list', 7), 'Grocerymilk list')).toBe('milk');
    expect(typedAfterEnter(at('Groceries', 9), 'Groceries')).toBe('');
  });

  it('gives nothing when the title changed any other way', () => {
    expect(typedAfterEnter(at('Groceries', 9), 'Grocerie')).toBeNull();
    expect(typedAfterEnter(at('Groceries', 4), 'Grocmilkries!')).toBeNull();
    // Text was selected: typing replaced it, so nothing is known to follow the Enter.
    expect(typedAfterEnter(at('Groceries', 0, 9), 'Milk')).toBeNull();
  });
});
