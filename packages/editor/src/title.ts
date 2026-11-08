/**
 * Binds the single-line title field to the note's `title` text (A16). Typing
 * writes the smallest edit through `setTitle`, so a concurrent edit to
 * another part of the title merges; a remote change rewrites the field and
 * keeps the caret on the same characters.
 */
import { readTitle, setTitle } from '@penmoss/sync-client/note';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';

/** The part of an `<input>` the binding uses (a fake in unit tests). */
export interface TitleField {
  value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
  addEventListener(type: 'input', listener: () => void): void;
  removeEventListener(type: 'input', listener: () => void): void;
}

/** Origin of title edits made in this field. */
export const TITLE_ORIGIN = Symbol('penmoss-title-field');

/** Where `position` in `previous` ends up once the text becomes `next`. */
export function mapPosition(previous: string, next: string, position: number): number {
  const max = Math.min(previous.length, next.length);
  let start = 0;
  while (start < max && previous[start] === next[start]) start++;
  let end = 0;
  while (end < max - start && previous[previous.length - 1 - end] === next[next.length - 1 - end]) {
    end++;
  }
  if (position <= start) return position;
  if (position >= previous.length - end) return position + next.length - previous.length;
  // Inside the replaced range: move to its end.
  return next.length - end;
}

/**
 * Binds `field` to the replica's title. Text typed before the binding (while
 * a new note was still being stored) becomes the title when the note has none.
 */
export function bindTitleField(field: TitleField, replica: Yjs14Replica): () => void {
  const { doc } = replica;
  const stored = readTitle(doc);
  if (field.value && !stored) setTitle(doc, field.value, TITLE_ORIGIN);
  else field.value = stored;
  const onInput = () => setTitle(doc, field.value, TITLE_ORIGIN);
  field.addEventListener('input', onInput);
  const offUpdate = replica.onUpdate((_update, origin) => {
    if (origin === TITLE_ORIGIN) return;
    const next = readTitle(doc);
    const previous = field.value;
    if (next === previous) return;
    const { selectionStart, selectionEnd } = field;
    field.value = next;
    if (selectionStart !== null && selectionEnd !== null) {
      field.setSelectionRange(
        mapPosition(previous, next, selectionStart),
        mapPosition(previous, next, selectionEnd),
      );
    }
  });
  return () => {
    field.removeEventListener('input', onInput);
    offUpdate();
  };
}

/**
 * Whether a character is dropped from a title (T39): C0 and C1 control
 * characters other than tab and line breaks, which show as boxes, and the
 * bidi embedding, override and isolate controls, which can make a title read
 * in a different order than it was written. Tabs are kept.
 */
function dropped(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Without dropped characters; the Unicode line and paragraph separators as line feeds. */
function withoutControls(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code === 0x2028 || code === 0x2029) out += '\n';
    else if (!dropped(code)) out += char;
  }
  return out;
}

/**
 * Pasted text as a title: one line, its line breaks as spaces (browsers
 * differ: Chrome turns them into spaces, Firefox drops them and joins words),
 * without control characters.
 */
export function pastedTitle(text: string): string {
  return withoutControls(text)
    .replace(/^[\r\n]+|[\r\n]+$/g, '')
    .replace(/[^\S\r\n]*[\r\n]+\s*/g, ' ');
}

/**
 * The title field's text kept to one line, as typed (T39 review): dictation's
 * "new line", autocorrect, a text replacement or a clipboard suggestion can
 * insert a line break without Enter or a paste. Each run of line breaks
 * becomes one space and control characters are dropped, as in `pastedTitle`;
 * text that has none comes back unchanged, so the caret stays put.
 */
export function oneLineTitle(text: string): string {
  return withoutControls(text).replace(/[\r\n]+/g, ' ');
}
