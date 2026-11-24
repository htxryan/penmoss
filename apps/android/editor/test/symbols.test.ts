/**
 * Line symbols on the phone (T44, A747): the page draws them with the web's editor, from the
 * list the app sends (`symbols`); the bar's symbol sheet toggles one (`symbol`) as one undo
 * step; the bar's state says which the selection has; the picker a hardware keyboard opens
 * closes with Back, and its Edit symbols… asks the app for Settings → Symbols.
 */
import { NOTE_ROOT } from '@penmoss/model/replica';
import { initNote } from '@penmoss/model/note';
import { createYjs14Replica } from '@penmoss/model/yjs14';
import { openSymbolPicker } from '@penmoss/editor';
import type { JSONContent } from '@tiptap/core';
import { undoCommand } from '@y/prosemirror';
import * as Y from '@y/y';
import { toBase64 } from 'lib0/buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { select } from '../../../../packages/editor/test/support/editor';
import { EditorHost } from '../src/host';
import type { FromEditor, ToEditor } from '../src/protocol';

const NOTE = '01JD2Z7Q8R4T6Y8W0E2R4T6YB1';

const hosts: EditorHost[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) host.close();
  document.body.replaceChildren();
});

function opened(content: JSONContent[]) {
  const root = document.createElement('main');
  root.hidden = true;
  const title = document.createElement('textarea');
  const body = document.createElement('div');
  const unsupported = document.createElement('pre');
  root.append(title, body, unsupported);
  document.body.append(root);
  const sent: FromEditor[] = [];
  const host = new EditorHost({ root, title, body, unsupported }, (message) => sent.push(message));
  hosts.push(host);
  const server = createYjs14Replica();
  initNote(server.doc, { id: NOTE, created: '2026-10-23T10:00:00-05:00', kind: 'note' }, 'Lines');
  server.doc.transact(() => {
    const paragraph = new Y.Node('paragraph');
    server.doc.get(NOTE_ROOT).push([paragraph]);
  });
  host.handle({
    v: 1,
    type: 'open',
    noteId: NOTE,
    synced: [{ id: '1', update: toBase64(server.encodeStateAsUpdate()) }],
    pending: [],
    editable: true,
  });
  const { editor } = host.editor!;
  editor.commands.setContent({ type: 'doc', content });
  return { host, sent, body, editor };
}

const paragraph = (value: string): JSONContent => ({
  type: 'paragraph',
  content: [{ type: 'text', text: value }],
});
const heading = (value: string): JSONContent => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text: value }],
});
const message = (body: Record<string, unknown>): ToEditor =>
  ({ v: 1, noteId: NOTE, ...body }) as unknown as ToEditor;
const states = (sent: FromEditor[]) =>
  sent.filter((each): each is Extract<FromEditor, { type: 'state' }> => each.type === 'state');
function lines(host: EditorHost): string[] {
  const out: string[] = [];
  host.editor!.editor.state.doc.forEach((node) => {
    if (node.textContent) out.push(node.textContent);
  });
  return out;
}

/** The document position of `needle`'s first character. */
function at(host: EditorHost, needle: string): number {
  let found = -1;
  host.editor!.editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(needle))
      found = pos + node.text.indexOf(needle);
    return found < 0;
  });
  if (found < 0) throw new Error(`no text "${needle}"`);
  return found;
}

describe('line symbols on the phone (T44, A747)', () => {
  // By default ⌃1 is the Checkbox (A1632); the glyphs ★ ? ! 💡 → are slots 2–6.
  it('toggles a symbol on every selected line as one undo step, and says which they have', () => {
    vi.useFakeTimers();
    const { host, sent, editor } = opened([paragraph('Call the bank'), paragraph('Pay rent')]);
    select(editor.view, at(host, 'Call'), at(host, 'rent') + 4);
    vi.runOnlyPendingTimers();
    expect(states(sent).at(-1)).toMatchObject({ symbols: [], canSymbol: true });

    host.handle(message({ type: 'symbol', index: 1 }));
    expect(lines(host)).toEqual(['★ Call the bank', '★ Pay rent']);
    host.handle(message({ type: 'symbol', index: 3 }));
    expect(lines(host)).toEqual(['★ ! Call the bank', '★ ! Pay rent']);
    vi.runOnlyPendingTimers();
    expect(states(sent).at(-1)).toMatchObject({ symbols: [1, 3], canSymbol: true });

    // Again: every line has it, so it goes from all of them.
    host.handle(message({ type: 'symbol', index: 1 }));
    expect(lines(host)).toEqual(['! Call the bank', '! Pay rent']);
    // Each toggle is its own undo step.
    undoCommand(editor.state, editor.view.dispatch);
    expect(lines(host)).toEqual(['★ ! Call the bank', '★ ! Pay rent']);
  });

  it('says a line in a code block cannot take one, and does nothing there', () => {
    vi.useFakeTimers();
    const { host, sent, editor } = opened([
      { type: 'codeBlock', content: [{ type: 'text', text: 'let x = 1;' }] },
    ]);
    select(editor.view, at(host, 'let') + 1);
    vi.runOnlyPendingTimers();
    expect(states(sent).at(-1)).toMatchObject({ symbols: [], canSymbol: false });
    host.handle(message({ type: 'symbol', index: 1 }));
    expect(lines(host)).toEqual(['let x = 1;']);
  });

  it('takes symbols in a table cell, drawn before its text (T52 item 2)', () => {
    vi.useFakeTimers();
    const cell = (type: string, text: string): JSONContent => ({
      type,
      content: [{ type: 'text', text }],
    });
    const { host, sent, body, editor } = opened([
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', 'Plan')] },
          { type: 'tableRow', content: [cell('tableCell', 'Budget')] },
        ],
      },
    ]);
    select(editor.view, at(host, 'Budget') + 2);
    vi.runOnlyPendingTimers();
    expect(states(sent).at(-1)).toMatchObject({ symbols: [], canSymbol: true });
    host.handle(message({ type: 'symbol', index: 4 }));
    vi.runOnlyPendingTimers();
    expect(states(sent).at(-1)).toMatchObject({ symbols: [4], canSymbol: true });
    expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '|')).toMatch(
      /^Plan\|💡 Budget/,
    );
    const drawn = body.querySelector('td .pm-symbols');
    expect(drawn?.classList.contains('pm-symbols-cell')).toBe(true);
  });

  it('shows three symbols at most in the gutter, then a "+N" chip (T52 item 3, A1680)', () => {
    const { body } = opened([paragraph('★ ? ! 💡 → Everything')]);
    const drawn = body.querySelector<HTMLElement>('.pm-symbols')!;
    const shown = [...drawn.querySelectorAll<HTMLElement>(':scope > .pm-symbol')].filter(
      (glyph) => !glyph.hidden,
    );
    expect(shown.map((glyph) => glyph.textContent)).toEqual(['★', '?']);
    expect(drawn.querySelector('.pm-symbols-more')?.textContent).toBe('+3');
    expect(drawn.querySelector('.pm-symbols-popover')?.textContent).toBe('★?!💡→');
    // Every symbol is still named for TalkBack.
    expect(drawn.querySelector('.pm-symbols-label')?.textContent).toBe(
      '★ Important ? Question ! Follow-up 💡 Idea → Next: ',
    );
  });

  it('stacks a box and Strikethrough on a numbered item, its number kept (A1678, A1679)', () => {
    vi.useFakeTimers();
    const item = (text: string): JSONContent => ({ type: 'listItem', content: [paragraph(text)] });
    const { host, sent, editor, body } = opened([
      { type: 'orderedList', attrs: { start: 1 }, content: [item('★ First'), item('Second')] },
    ]);
    const prose = body.querySelector<HTMLElement>('.ProseMirror')!;
    select(editor.view, at(host, 'First') + 2);
    // The Checkbox (slot 1) and Strikethrough (slot 7) by default.
    host.handle(message({ type: 'symbol', index: 0 }));
    host.handle(message({ type: 'symbol', index: 6 }));
    expect(lines(host)).toEqual(['☐ ★ ⊘ FirstSecond']);
    const list = editor.state.doc.firstChild!;
    expect(list.type.name).toBe('orderedList');
    expect(list.childCount).toBe(2);
    expect(body.querySelector('.pm-symbol-struck')?.textContent).toBe('First');
    vi.runOnlyPendingTimers();
    expect(states(sent).at(-1)).toMatchObject({ symbols: [0, 1, 6] });
    // The gutter has room for the three, as on the Mac (A1680).
    expect(prose.getAttribute('data-symbol-slots')).toBe('3');
    // ⌃1 again ticks the box, keeping the number.
    host.handle(message({ type: 'symbol', index: 0 }));
    expect(lines(host)).toEqual(['☑ ★ ⊘ FirstSecond']);
    expect(editor.state.doc.firstChild!.type.name).toBe('orderedList');
  });

  it('keeps no gutter in a note without symbols (A1680)', () => {
    const { body } = opened([paragraph('Just words')]);
    expect(body.querySelector('.ProseMirror')!.hasAttribute('data-symbol-slots')).toBe(false);
  });

  it('draws the list the app sends, and redraws when it changes, the note untouched', () => {
    const { host, body } = opened([paragraph('✓ Done already'), paragraph('★ Important')]);
    expect(body.querySelectorAll('.pm-symbols')).toHaveLength(1);
    host.handle({
      v: 1,
      type: 'symbols',
      symbols: [{ glyph: '✓', name: 'Done', colour: 'success' }],
    });
    const drawn = [...body.querySelectorAll('.pm-symbols')];
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.textContent).toContain('✓');
    // ★ is not in the list any more: it shows as text, and the note's text is as it was.
    expect(lines(host)).toEqual(['✓ Done already', '★ Important']);
    host.handle({ v: 1, type: 'symbols', symbols: [] });
    expect(body.querySelectorAll('.pm-symbols')).toHaveLength(0);
  });

  it('closes the picker with Back, and its Edit symbols… opens Settings → Symbols', () => {
    vi.useFakeTimers();
    const { host, sent, editor } = opened([paragraph('Call the bank')]);
    host.keys.set({ 'editor.symbol1': ['Alt+Shift+1'] }, []);
    select(editor.view, at(host, 'Call'));
    expect(openSymbolPicker(editor)).toBe(true);
    const picker = document.querySelector<HTMLElement>('[data-testid="symbol-picker"]')!;
    expect(picker.hidden).toBe(false);
    // The slot's shortcut, as this keyboard has it.
    expect(picker.querySelector('[data-slot="0"] kbd')?.textContent).toBe('Alt+Shift+1');
    select(editor.view, at(host, 'Call') + 1);
    vi.runOnlyPendingTimers();
    expect(states(sent).at(-1)).toMatchObject({ menu: true });
    host.handle(message({ type: 'dismiss' }));
    expect(picker.hidden).toBe(true);
    vi.runOnlyPendingTimers();
    expect(states(sent).at(-1)).toMatchObject({ menu: false });

    openSymbolPicker(editor);
    picker.querySelector<HTMLElement>('[data-edit]')!.click();
    expect(sent.at(-1)).toEqual({ v: 1, type: 'command', noteId: NOTE, id: 'app.symbols' });
  });

  it('finds a linked heading with or without its symbols (A748)', () => {
    const { host, body } = opened([paragraph('Intro'), heading('? Open questions')]);
    const target = body.querySelector('h2')!;
    target.scrollIntoView = vi.fn();
    host.handle(message({ type: 'showHeading', heading: 'Open questions' }));
    expect(target.classList.contains('pm-heading-target')).toBe(true);
  });
});
