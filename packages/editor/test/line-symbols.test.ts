import { schema as coreSchema, parseMarkdown, serializeMarkdown } from '@penmoss/core';
import { DEFAULT_SYMBOLS, type LineSymbol } from '@penmoss/core/line-symbols';
import { NOTE_ROOT } from '@penmoss/sync-client';
import type { JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { describe, expect, it, vi } from 'vitest';
import { pastePlainText } from '../src/clipboard';
import { availableBlockItems } from '../src/extensions/block-items';
import { EDITOR_COMMANDS, symbolCommandTitle } from '../src/commands';
import {
  activeSymbols,
  openSymbolPicker,
  setLineSymbols,
  toggleSymbolIn,
  type SymbolSource,
} from '../src/extensions/line-symbols';
import type { CollabEditor } from '../src/collab';
import { codeBlock, openEditor, paragraph, press, select, type } from './support/editor';

const markdownOf = (collab: CollabEditor) =>
  serializeMarkdown({ frontmatter: null, doc: coreSchema.nodeFromJSON(collab.editor.getJSON()) });

const heading = (level: number, text: string): JSONContent => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const bullets = (...items: string[]): JSONContent => ({
  type: 'bulletList',
  content: items.map((text) => ({ type: 'listItem', content: [paragraph(text)] })),
});
/** A table: a header row, then body rows, each cell's text as given (cells are inline only, A9). */
const table = (header: string[], ...rows: string[][]): JSONContent => {
  const cells = (type: string, texts: string[]) =>
    texts.map((text) => ({ type, content: text ? [{ type: 'text', text }] : [] }));
  return {
    type: 'table',
    content: [
      { type: 'tableRow', content: cells('tableHeader', header) },
      ...rows.map((row) => ({ type: 'tableRow', content: cells('tableCell', row) })),
    ],
  };
};
const tasks = (...items: string[]): JSONContent => ({
  type: 'taskList',
  content: items.map((text) => ({
    type: 'taskItem',
    attrs: { checked: false },
    content: [paragraph(text)],
  })),
});

/** Each drawn line's glyphs, as the margin shows them. */
const drawn = (view: EditorView) =>
  [...view.dom.querySelectorAll<HTMLElement>('.pm-symbols')].map((margin) =>
    [...margin.querySelectorAll('.pm-symbol')].map((glyph) => glyph.textContent).join(''),
  );

/** The start of the `index`th textblock's content. */
function lineStart(view: EditorView, index: number): number {
  let seen = 0;
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (!node.isTextblock) return true;
    if (seen++ === index) found = pos + 1;
    return false;
  });
  if (found < 0) throw new Error(`No line ${index}`);
  return found;
}

const caret = (view: EditorView) => view.state.selection.head;
const command = (id: string) => EDITOR_COMMANDS.find((entry) => entry.id === id)!;
const texts = (view: EditorView) => {
  const out: string[] = [];
  view.state.doc.descendants((node) => {
    if (!node.isTextblock) return true;
    out.push(node.textContent);
    return false;
  });
  return out;
};

describe('the caret and the selection on a symbol line (T44, A745)', () => {
  it('never rests inside the symbols: a caret there moves to the text', () => {
    const { editor } = openEditor([paragraph('Before'), paragraph('★ ? Call the bank')]);
    const { view } = editor;
    const start = lineStart(view, 1);
    for (const at of [start, start + 1, start + 2, start + 3]) {
      select(view, at);
      expect(caret(view), `from ${at}`).toBe(start + 4);
    }
    select(view, start + 6);
    expect(caret(view)).toBe(start + 6);
  });

  it('keeps a range from the very start of the line, and moves an end inside the symbols', () => {
    const { editor } = openEditor([paragraph('★ ? Call the bank')]);
    const { view } = editor;
    const start = lineStart(view, 0);
    const end = start + '★ ? Call the bank'.length;
    select(view, start, end);
    expect([view.state.selection.from, view.state.selection.to]).toEqual([start, end]);
    select(view, start + 2, end);
    expect([view.state.selection.from, view.state.selection.to]).toEqual([start + 4, end]);
  });

  it('goes from the start of the text to the line before with ←, and extends with ⇧←', () => {
    const { editor } = openEditor([paragraph('Before'), paragraph('★ Call')]);
    const { view } = editor;
    const start = lineStart(view, 1);
    select(view, start + 2);
    expect(press(view, 'ArrowLeft')).toBe(true);
    expect(caret(view)).toBe(lineStart(view, 0) + 'Before'.length);
    select(view, start + 2);
    expect(press(view, 'ArrowLeft', { shiftKey: true })).toBe(true);
    expect(view.state.selection.anchor).toBe(start + 2);
    expect(view.state.selection.head).toBe(lineStart(view, 0) + 'Before'.length);
    // On the first line there is nowhere to go, and the caret stays at the text.
    const top = openEditor([paragraph('★ First')]).editor.view;
    select(top, lineStart(top, 0));
    expect(press(top, 'ArrowLeft')).toBe(true);
    expect(caret(top)).toBe(lineStart(top, 0) + 2);
    // Elsewhere on the line ← is the browser's.
    select(view, start + 5);
    expect(press(view, 'ArrowLeft')).toBe(false);
    // A range made backwards to the text's start collapses there, as ← does (review).
    select(view, start + 5, start + 2);
    expect(press(view, 'ArrowLeft')).toBe(false);
  });

  it('goes back with → on a right-to-left line (review)', () => {
    const { editor } = openEditor([paragraph('Before'), paragraph('★ שלום')]);
    const { view } = editor;
    const line = view.dom.querySelectorAll('p')[1]!;
    line.style.direction = 'rtl';
    const start = lineStart(view, 1);
    select(view, start + 2);
    expect(press(view, 'ArrowLeft')).toBe(false);
    expect(press(view, 'ArrowRight')).toBe(true);
    expect(caret(view)).toBe(lineStart(view, 0) + 'Before'.length);
  });

  it('removes the last symbol with Backspace at the start of the text, one at a time', () => {
    const collab = openEditor([paragraph('★ ! Send the form')]);
    const { view } = collab.editor;
    const start = lineStart(view, 0);
    select(view, start + 4);
    expect(press(view, 'Backspace')).toBe(true);
    expect(texts(view)).toEqual(['★ Send the form']);
    expect(caret(view)).toBe(start + 2);
    expect(press(view, 'Backspace')).toBe(true);
    expect(texts(view)).toEqual(['Send the form']);
    expect(caret(view)).toBe(start);
    // Now an ordinary line: Backspace is the keymaps'.
    expect(press(view, 'Backspace')).toBe(false);
  });

  it('takes a soft keyboard’s Backspace (beforeinput) the same way (review)', () => {
    const { editor } = openEditor([paragraph('★ ! Send')]);
    const { view } = editor;
    select(view, lineStart(view, 0) + 4);
    const event = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(texts(view)).toEqual(['★ Send']);
    // Elsewhere it is the browser's.
    select(view, lineStart(view, 0) + 5);
    const later = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });

  it('draws a line of only symbols, read back without its space, once the caret leaves it', () => {
    const { editor } = openEditor([paragraph('Above'), paragraph('★'), paragraph('Below')]);
    const { view } = editor;
    select(view, lineStart(view, 2));
    expect(drawn(view)).toEqual(['★']);
    // On the caret's line a last glyph with no space is text: typing on joins it, as written.
    select(view, lineStart(view, 1) + 1);
    expect(drawn(view)).toEqual([]);
    type(view, 'Call');
    expect(texts(view)[1]).toBe('★Call');
    select(view, lineStart(view, 2));
    expect(drawn(view)).toEqual([]);
  });

  it('never hides a glyph typed before a word, or before an embed or image (T44 review)', () => {
    const { editor } = openEditor([paragraph(''), paragraph('Below')]);
    const { view } = editor;
    select(view, lineStart(view, 0));
    type(view, '!');
    expect(drawn(view)).toEqual([]);
    type(view, 'Important');
    expect(texts(view)[0]).toBe('!Important');
    expect(drawn(view)).toEqual([]);
    select(view, lineStart(view, 1));
    expect(drawn(view)).toEqual([]);
  });

  it('draws a lone glyph left on a line once the caret moves on (A742)', () => {
    const { editor } = openEditor([paragraph(''), paragraph('Below')]);
    const { view } = editor;
    select(view, lineStart(view, 0));
    type(view, '?');
    expect(drawn(view)).toEqual([]);
    select(view, lineStart(view, 1));
    expect(drawn(view)).toEqual(['?']);
    expect(texts(view)[0]).toBe('?');
  });

  it('makes the new line above with Enter at the start of the text, symbols staying with it', () => {
    const { editor } = openEditor([paragraph('★ Call the bank')]);
    const { view } = editor;
    select(view, lineStart(view, 0) + 2);
    press(view, 'Enter');
    expect(texts(view)).toEqual(['', '★ Call the bank']);
    expect(caret(view)).toBe(lineStart(view, 1) + 2);
    // At the end of the text, Enter is an ordinary new line below, without symbols.
    select(view, lineStart(view, 1) + '★ Call the bank'.length);
    press(view, 'Enter');
    expect(texts(view)).toEqual(['', '★ Call the bank', '']);
  });

  it('does the same in a list item', () => {
    const { editor } = openEditor([bullets('? Ask', 'Other')]);
    const { view } = editor;
    select(view, lineStart(view, 0) + 2);
    press(view, 'Enter');
    // (The empty line after the list is the editor's trailing paragraph.)
    expect(texts(view)).toEqual(['', '? Ask', 'Other', '']);
    expect(caret(view)).toBe(lineStart(view, 1) + 2);
  });
});

describe('drawing symbols (T44, A741, A745)', () => {
  it('draws a known leading run in the margin, coloured, on paragraphs, items and headings', () => {
    const { editor } = openEditor([
      paragraph('★ Call the bank'),
      bullets('? Bullet'),
      tasks('! ★ Send the form'),
      heading(2, '? Open questions'),
      { type: 'blockquote', content: [paragraph('💡 Quoted')] },
    ]);
    const { view } = editor;
    expect(drawn(view)).toEqual(['★', '?', '!★', '?', '💡']);
    const star = view.dom.querySelector<HTMLElement>('.pm-symbol')!;
    expect(star.style.color).toBe('var(--pm-callout-warning)');
    expect(star.getAttribute('aria-hidden')).toBe('true');
    // The glyphs are read once before the line (A940); the drawn ones are hidden. The default
    // symbols keep their older names, read beside the glyph: "?" alone may be read as nothing.
    const labels = [...view.dom.querySelectorAll('.pm-symbols-label')].map((l) => l.textContent);
    expect(labels).toEqual([
      '★ Important: ',
      '? Question: ',
      '! Follow-up ★ Important: ',
      '? Question: ',
      '💡 Idea: ',
    ]);
    // The margin's tooltip names them by their glyphs too.
    expect(view.dom.querySelector<HTMLElement>('.pm-symbols')?.title).toBe('★: Click to Change');
    expect(view.dom.querySelector('.pm-symbol-run')?.textContent).toBe('★ ');
    // Only the run and the margin: nothing on the blocks, which a keystroke would map (review).
    expect(view.dom.querySelectorAll('[class*="pm-symbol-line"], .pm-has-symbols')).toHaveLength(0);
  });

  it('never draws in code or callouts, nor unknown glyphs or glyphs not at the start', () => {
    const { editor } = openEditor([
      codeBlock('★ not here'),
      paragraph('☆ unknown'),
      paragraph('Later ★ here'),
      paragraph('★★ two'),
      {
        type: 'callout',
        attrs: { type: 'note', title: '', foldable: false, collapsed: false },
        content: [paragraph('★ in a callout')],
      },
      table(['Later ★ header'], ['☆ cell']),
    ]);
    expect(drawn(editor.view)).toEqual([]);
  });

  it('draws what is typed, pasted or synced as text the same way (A741)', () => {
    const collab = openEditor([paragraph('')]);
    const { view } = collab.editor;
    select(view, 1);
    type(view, '★ Typed');
    expect(drawn(view)).toEqual(['★']);
    press(view, 'Enter');
    pastePlainText(view, '→ Pasted');
    expect(drawn(view)).toEqual(['★', '→']);
    expect(markdownOf(collab)).toBe('★ Typed\n\n→ Pasted\n');
  });

  it('never writes to the note, and a list change redraws without changing it', () => {
    const collab = openEditor([paragraph('★ ? Mixed'), paragraph('? Only')]);
    const { view } = collab.editor;
    const before = JSON.stringify(collab.replica.doc.get(NOTE_ROOT).toDeltaDeep().toJSON());
    expect(drawn(view)).toEqual(['★?', '?']);
    // "?" leaves the list: its lines show it as text again (A742).
    setLineSymbols(
      collab.editor,
      DEFAULT_SYMBOLS.filter((symbol) => symbol.glyph !== '?'),
    );
    expect(drawn(view)).toEqual(['★']);
    expect(texts(view)).toEqual(['★ ? Mixed', '? Only']);
    setLineSymbols(collab.editor, []);
    expect(drawn(view)).toEqual([]);
    expect(JSON.stringify(collab.replica.doc.get(NOTE_ROOT).toDeltaDeep().toJSON())).toBe(before);
  });

  it('follows a live source: Settings or another device changing the list', () => {
    let list: readonly LineSymbol[] = DEFAULT_SYMBOLS;
    const listeners = new Set<() => void>();
    const source: SymbolSource = {
      get: () => list,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const collab = openEditor([paragraph('✓ Done'), paragraph('★ Star')], { symbols: source });
    expect(drawn(collab.editor.view)).toEqual(['★']);
    list = [{ glyph: '✓', name: 'Done', colour: 'success' }];
    for (const listener of listeners) listener();
    expect(drawn(collab.editor.view)).toEqual(['✓']);
    collab.destroy();
    expect(listeners.size).toBe(0);
  });
});

describe('toggling symbols (T44, A740, A744)', () => {
  it('toggles a slot on the caret’s line with editor.symbolN, in list order', () => {
    const collab = openEditor([paragraph('Call the bank')]);
    const { editor } = collab;
    select(editor.view, 3);
    expect(command('editor.symbol5').run({ editor })).toBe(true);
    expect(texts(editor.view)).toEqual(['→ Call the bank']);
    expect(command('editor.symbol1').run({ editor })).toBe(true);
    expect(texts(editor.view)).toEqual(['★ → Call the bank']);
    expect(command('editor.symbol2').run({ editor })).toBe(true);
    expect(texts(editor.view)).toEqual(['★ ? → Call the bank']);
    // The caret stays in the text where it was.
    expect(caret(editor.view)).toBe(1 + '★ ? → Ca'.length);
    expect(command('editor.symbol1').run({ editor })).toBe(true);
    expect(texts(editor.view)).toEqual(['? → Call the bank']);
    expect(markdownOf(collab)).toBe('? → Call the bank\n');
  });

  it('adds to every line of a selection if any lacks it, else removes it from all', () => {
    const { editor } = openEditor([paragraph('★ One'), paragraph('Two'), heading(2, 'Three')]);
    const { view } = editor;
    select(view, lineStart(view, 0) + 3, lineStart(view, 2) + 3);
    expect(activeSymbols(view.state)).toEqual([]);
    expect(command('editor.symbol1').run({ editor })).toBe(true);
    expect(texts(view)).toEqual(['★ One', '★ Two', '★ Three', '']);
    expect(activeSymbols(view.state)).toEqual([0]);
    expect(command('editor.symbol1').run({ editor })).toBe(true);
    expect(texts(view)).toEqual(['One', 'Two', 'Three', '']);
  });

  it('leaves out a line the selection only reaches the start of (review)', () => {
    const { editor } = openEditor([paragraph('One'), paragraph('Two'), paragraph('Three')]);
    const { view } = editor;
    select(view, lineStart(view, 0), lineStart(view, 1));
    expect(command('editor.symbol1').run({ editor })).toBe(true);
    expect(texts(view).slice(0, 3)).toEqual(['★ One', 'Two', 'Three']);
  });

  it('drops a second copy that two devices added at once', () => {
    const { editor } = openEditor([paragraph('★ ★ Twice')]);
    const { view } = editor;
    select(view, lineStart(view, 0) + 6);
    expect(command('editor.symbol2').run({ editor })).toBe(true);
    expect(texts(view)[0]).toBe('★ ? Twice');
  });

  it('acts on a block selected with the drag handle, and not in code or a table', () => {
    const { editor } = openEditor([bullets('A', 'B'), codeBlock('x')]);
    const { view } = editor;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
    expect(command('editor.symbol3').run({ editor })).toBe(true);
    expect(texts(view)).toEqual(['! A', '! B', 'x', '']);
    select(view, lineStart(view, 2));
    expect(command('editor.symbol3').run({ editor })).toBe(false);
  });

  it('declines a slot the list does not fill, so its key keeps its meaning', () => {
    const { editor } = openEditor([paragraph('Text')]);
    select(editor.view, 2);
    expect(command('editor.symbol6').run({ editor })).toBe(false);
    expect(command('editor.symbol9').run({ editor })).toBe(false);
    expect(texts(editor.view)).toEqual(['Text']);
  });

  it('is one undo step of its own, with redo', () => {
    const collab = openEditor([paragraph('')]);
    const { view } = collab.editor;
    select(view, 1);
    type(view, 'Words');
    expect(toggleSymbolIn(view, 0)).toBe(true);
    expect(toggleSymbolIn(view, 2)).toBe(true);
    expect(texts(view)).toEqual(['★ ! Words']);
    expect(collab.undo()).toBe(true);
    expect(texts(view)).toEqual(['★ Words']);
    expect(collab.undo()).toBe(true);
    expect(texts(view)).toEqual(['Words']);
    expect(collab.redo()).toBe(true);
    expect(collab.redo()).toBe(true);
    expect(texts(view)).toEqual(['★ ! Words']);
  });

  it('keeps the symbols when a symbol line is copied (the selection holds their text)', () => {
    const { editor } = openEditor([paragraph('Before'), paragraph('★ Copied line')]);
    const { view } = editor;
    // A whole line from its start, as a triple click or ⇧↑ selects it.
    const start = lineStart(view, 1);
    select(view, start, start + '★ Copied line'.length);
    const slice = view.state.selection.content();
    expect(slice.content.textBetween(0, slice.content.size)).toBe('★ Copied line');
  });
});

describe('the symbol picker (T44, A746)', () => {
  const picker = () => document.querySelector<HTMLElement>('[data-testid="symbol-picker"]');
  const items = () => [...picker()!.querySelectorAll<HTMLElement>('[role^="menuitem"]')];

  it('lists every symbol, ticked where the line has it, and toggles from the keyboard', () => {
    const onEditSymbols = vi.fn();
    const { editor } = openEditor([paragraph('★ Call')], {
      onEditSymbols,
      symbolShortcut: (index) => `⌃${index + 1}`,
    });
    select(editor.view, 3);
    expect(command('editor.symbolPicker').run({ editor })).toBe(true);
    expect(picker()?.hidden).toBe(false);
    // Each named by its glyph (A940).
    expect(items().map((item) => item.dataset['label'])).toEqual([
      '★',
      '?',
      '!',
      '💡',
      '→',
      'Edit Symbols…',
    ]);
    expect(items()[0]!.querySelector('.pm-symbol-item-glyph')?.getAttribute('aria-hidden')).toBe(
      null,
    );
    expect(items().map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
      null,
    ]);
    expect(items()[1]!.querySelector('kbd')?.textContent).toBe('⌃2');
    expect(document.activeElement).toBe(items()[0]);
    const key = (name: string, code = name) =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, code, bubbles: true, cancelable: true }),
      );
    key('ArrowDown');
    expect(document.activeElement).toBe(items()[1]);
    key('Enter');
    expect(picker()?.hidden).toBe(true);
    expect(texts(editor.view)).toEqual(['★ ? Call']);
    // A digit toggles its slot; Esc closes; Edit symbols… opens Settings.
    openSymbolPicker(editor);
    // By the key's place: AZERTY's 1 key types "&".
    key('&', 'Digit1');
    expect(texts(editor.view)).toEqual(['? Call']);
    openSymbolPicker(editor);
    key('Escape');
    expect(picker()?.hidden).toBe(true);
    openSymbolPicker(editor);
    key('End');
    key('Enter');
    expect(onEditSymbols).toHaveBeenCalledTimes(1);
    expect(texts(editor.view)).toEqual(['? Call']);
  });

  it('opens from the slash menu’s Symbol and from a click on a line’s symbols', () => {
    const { editor } = openEditor([paragraph('Before'), paragraph('★ Call')]);
    const { view } = editor;
    select(view, 1 + 'Before'.length);
    press(view, 'Enter');
    type(view, '/symbol');
    const storage = editor.storage as unknown as {
      slashMenu: { menu: { options: { id: string }[] } | null };
    };
    expect(storage.slashMenu.menu?.options[0]?.id).toBe('symbol');
    press(view, 'Enter');
    expect(picker()?.hidden).toBe(false);
    expect(texts(view)).toEqual(['Before', '', '★ Call']);
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    const margin = view.dom.querySelector<HTMLElement>('.pm-symbols')!;
    margin.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    expect(picker()?.hidden).toBe(false);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.$head.parent.textContent).toBe('★ Call');
    expect(items()[0]!.getAttribute('aria-checked')).toBe('true');
  });
});

describe('symbols in table cells (T52 item 2)', () => {
  it('draws a cell’s leading glyphs before its text, in header and body cells', () => {
    const { editor } = openEditor([table(['★ Plan', 'Owner'], ['? Budget', '! 💡 Ryan'])]);
    const { view } = editor;
    expect(drawn(view)).toEqual(['★', '?', '!💡']);
    const margins = [...view.dom.querySelectorAll<HTMLElement>('.pm-symbols')];
    // Marked as a cell's, which the stylesheet keeps before the text rather than in the margin.
    expect(margins.every((margin) => margin.classList.contains('pm-symbols-cell'))).toBe(true);
    expect(margins[0]!.closest('th')).not.toBeNull();
    expect(margins[2]!.closest('td')).not.toBeNull();
    expect(margins[2]!.querySelector('.pm-symbols-label')?.textContent).toBe(
      '! Follow-up 💡 Idea: ',
    );
    // A paragraph's margin is not a cell's.
    const other = openEditor([paragraph('★ Line')]);
    expect(other.editor.view.dom.querySelector('.pm-symbols-cell')).toBeNull();
  });

  it('toggles symbols in a cell by key, command and picker, and keeps the markdown', () => {
    const collab = openEditor([table(['Task', 'Owner'], ['Budget', 'Ryan'])]);
    const { editor } = collab;
    const { view } = editor;
    select(view, lineStart(view, 2) + 3);
    expect(command('editor.symbol1').run({ editor })).toBe(true);
    expect(command('editor.symbol3').run({ editor })).toBe(true);
    expect(texts(view)).toEqual(['Task', 'Owner', '★ ! Budget', 'Ryan', '']);
    expect(drawn(view)).toEqual(['★!']);
    expect(activeSymbols(view.state)).toEqual([0, 2]);
    // GFM cells are inline only: the symbols are the cell's leading text.
    expect(markdownOf(collab)).toContain('| ★ ! Budget | Ryan |');
    // The picker opens there too.
    expect(command('editor.symbolPicker').run({ editor })).toBe(true);
    expect(document.querySelector('.pm-symbol-picker')?.hasAttribute('hidden')).toBe(false);
    // Again: removed.
    expect(command('editor.symbol1').run({ editor })).toBe(true);
    expect(texts(view)[2]).toBe('! Budget');
  });

  it('reads a cell’s symbols back from markdown, its bare last glyph included (A741)', () => {
    const parsed = parseMarkdown('| ★ Plan | ? |\n| --- | --- |\n| ! Ship | Done |\n');
    const collab = openEditor((parsed.doc.toJSON() as JSONContent).content);
    const { view } = collab.editor;
    expect(drawn(view)).toEqual(['★', '?', '!']);
    const markdown = markdownOf(collab);
    expect(markdown).toContain('| ★ Plan | ? |');
    expect(markdown).toContain('| ! Ship | Done |');
  });

  it('keeps the caret out of a cell’s symbols; Backspace at its text removes the last', () => {
    const { editor } = openEditor([table(['★ ? Plan'], ['Other'])]);
    const { view } = editor;
    const start = lineStart(view, 0);
    select(view, start);
    expect(caret(view)).toBe(start + 4);
    // Enter splits no cell (GFM cells are one line), so the caret is not moved into the run.
    press(view, 'Enter');
    expect(texts(view)[0]).toBe('★ ? Plan');
    expect(caret(view)).toBe(start + 4);
    press(view, 'Backspace');
    expect(texts(view)[0]).toBe('★ Plan');
    expect(caret(view)).toBe(start + 2);
  });

  it('offers Symbol in a cell’s slash menu', () => {
    const { editor } = openEditor([table(['Plan'], ['Other'])]);
    select(editor.view, lineStart(editor.view, 1) + 2);
    expect(availableBlockItems(editor).map((item) => item.id)).toContain('symbol');
  });
});

describe('the symbol commands’ titles (T51 item 12, A940)', () => {
  it('name each slot by its glyph, and leave an empty slot and other commands alone', () => {
    expect(EDITOR_COMMANDS.find((each) => each.id === 'editor.symbol1')?.title).toBe(
      'Toggle Symbol 1',
    );
    expect(symbolCommandTitle('editor.symbol1', DEFAULT_SYMBOLS)).toBe('Toggle Symbol ★');
    expect(symbolCommandTitle('editor.symbol4', DEFAULT_SYMBOLS)).toBe('Toggle Symbol 💡');
    expect(symbolCommandTitle('editor.symbol6', DEFAULT_SYMBOLS)).toBeUndefined();
    expect(symbolCommandTitle('editor.symbolPicker', DEFAULT_SYMBOLS)).toBeUndefined();
    expect(symbolCommandTitle('editor.bold', DEFAULT_SYMBOLS)).toBeUndefined();
  });
});
