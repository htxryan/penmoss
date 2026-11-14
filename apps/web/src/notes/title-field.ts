/**
 * The note's title is a one-line text, shown in a `<textarea>` so that a long
 * title wraps instead of being cut off at the column's edge (T39). The field
 * grows with its text: CSS `field-sizing: content` where the browser has it,
 * otherwise by setting its height here whenever its text or width changes.
 */
import { oneLineTitle, type TitleField } from './title';

/** The parts of a `<textarea>` the title needs (a fake in unit tests). */
export interface GrowingField {
  value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  readonly scrollHeight: number;
  readonly style: { height: string };
  setSelectionRange(start: number, end: number): void;
  addEventListener(type: 'input', listener: () => void): void;
  removeEventListener(type: 'input', listener: () => void): void;
}

/** Whether the browser sizes a field to its content by itself (`field-sizing`). */
export function sizesItself(): boolean {
  return typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content') === true;
}

/** Fits the field's height to its text, unless the browser does it already. */
export function fitHeight(field: GrowingField, native = sizesItself()): void {
  if (native) return;
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

/**
 * Takes line breaks and control characters out of what was just typed
 * (T39 review). Enter, paste and drop are handled before they reach the
 * field, but dictation, autocorrect, a text replacement or a keyboard's
 * clipboard chip can insert a line break as plain input. The caret stays on
 * the same characters.
 */
export function keepOneLine(field: GrowingField): void {
  const typed = field.value;
  const clean = oneLineTitle(typed);
  if (clean === typed) return;
  const { selectionStart, selectionEnd } = field;
  field.value = clean;
  if (selectionStart === null || selectionEnd === null) return;
  field.setSelectionRange(
    oneLineTitle(typed.slice(0, selectionStart)).length,
    oneLineTitle(typed.slice(0, selectionEnd)).length,
  );
}

/**
 * The title binding's view of the field: text written into it (the note's
 * title on opening, another device's rename) fits the field's height too,
 * and the field is kept to one line before the binding reads what was typed.
 */
export function growingTitle(field: GrowingField, native = sizesItself()): TitleField {
  /** The binding's input listeners, each run after `keepOneLine`. */
  const wrapped = new Map<() => void, () => void>();
  return {
    get value() {
      return field.value;
    },
    set value(next: string) {
      field.value = next;
      fitHeight(field, native);
    },
    get selectionStart() {
      return field.selectionStart;
    },
    get selectionEnd() {
      return field.selectionEnd;
    },
    setSelectionRange: (start, end) => field.setSelectionRange(start, end),
    addEventListener: (type, listener) => {
      const run = () => {
        keepOneLine(field);
        listener();
      };
      wrapped.set(listener, run);
      field.addEventListener(type, run);
    },
    removeEventListener: (type, listener) => {
      const run = wrapped.get(listener);
      if (!run) return;
      wrapped.delete(listener);
      field.removeEventListener(type, run);
    },
  };
}

/** Line breaks typed, dropped or inserted into the title: none belong in it. */
export function isLineBreak(inputType: string): boolean {
  return inputType === 'insertLineBreak' || inputType === 'insertParagraph';
}

/** Enter pressed in the title before the note's body opened (A1179): the title then, and where. */
export interface QueuedEnter {
  readonly title: string;
  /** The caret; null when text was selected (what is typed next replaces it). */
  readonly at: number | null;
}

/** Enter in `field` now, kept until the body opens. */
export function queueEnter(
  field: Pick<GrowingField, 'value' | 'selectionStart' | 'selectionEnd'>,
): QueuedEnter {
  const { value, selectionStart, selectionEnd } = field;
  const collapsed = selectionStart !== null && selectionStart === selectionEnd;
  return { title: value, at: collapsed ? selectionStart : null };
}

/**
 * What was typed in the title after a queued Enter: the text the title gained at the caret, which
 * belongs at the start of the body. Null when the title changed any other way (a deletion, a
 * selection replaced): the title then stays as it is.
 */
export function typedAfterEnter(queued: QueuedEnter, now: string): string | null {
  const { title, at } = queued;
  if (at === null || now.length < title.length) return null;
  const head = title.slice(0, at);
  const tail = title.slice(at);
  if (!now.startsWith(head) || !now.endsWith(tail)) return null;
  return now.slice(at, now.length - tail.length);
}

/**
 * Whether the caret is on the title's last line as wrapped (PEN-135): ArrowDown there goes to the
 * note's first line, and on a line above it moves down in the title as usual. Measured on a hidden
 * copy of the field: the text up to the end of the caret's word (cut at the caret, a word could
 * fit on a line it does not) is as tall as the whole text when nothing wraps below the caret.
 */
export function caretOnLastLine(field: HTMLTextAreaElement): boolean {
  const { value } = field;
  const caret = field.selectionEnd ?? value.length;
  const wordEnd = caret + (/^\S*/.exec(value.slice(caret))?.[0].length ?? 0);
  if (value.slice(wordEnd).trim() === '') return true;
  const copy = field.cloneNode(false) as HTMLTextAreaElement;
  copy.removeAttribute('id');
  copy.removeAttribute('data-testid');
  copy.setAttribute('aria-hidden', 'true');
  copy.tabIndex = -1;
  Object.assign(copy.style, {
    position: 'absolute',
    visibility: 'hidden',
    boxSizing: 'border-box',
    width: `${field.getBoundingClientRect().width}px`,
    height: '0',
    fieldSizing: 'fixed',
  });
  field.after(copy);
  try {
    copy.value = value.slice(0, wordEnd);
    const upToCaret = copy.scrollHeight;
    copy.value = value;
    return upToCaret >= copy.scrollHeight;
  } finally {
    copy.remove();
  }
}
