/**
 * Line symbols (T44, D36): a leading run of known glyphs on a paragraph, list or checklist
 * item, heading or table cell (`★ ? Call the bank`) is drawn in the left margin, coloured,
 * outside the text column (in a cell, before its text: T52 item 2). The glyphs stay plain text
 * (A741): typing, pasting, agents and the codec all agree, and changing the list never changes
 * a note. Only decorations change.
 *
 * Drawing (A745): the run's text is hidden and a widget just after it, `contenteditable`
 * false, shows the glyphs in the margin (or before the text where there is no margin, a
 * phone or a table cell), as many as fit with a "+N" chip for the rest (T52 item 3,
 * `symbol-overflow.ts`). The caret never stops inside the run: a selection that lands there
 * is moved to the line's text, ← and Backspace at the start of the text go to the line before
 * and remove the last symbol, and Enter there makes the new line above, the symbols staying
 * with the text (not in a cell, which is one line). Screen readers hear each symbol's name
 * before the line.
 *
 * Toggles (A740, A744): `toggleLineSymbol(index)` adds or removes the symbol in that slot on
 * every block in the selection, in one transaction (one undo step): added at its place by
 * list order when any block lacks it, otherwise removed. The list is a synced setting (A743)
 * that the app hands in as a `SymbolSource`, so a change on another device redraws every
 * open note.
 */
import {
  DEFAULT_SYMBOLS,
  symbolColourVar,
  symbolEdits,
  symbolRun,
  symbolSpokenName,
  type LineSymbol,
  type SymbolRun,
} from '@penmoss/core/line-symbols';
import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { AttrStep, ReplaceAroundStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { dispatchMove } from './block-move';
import { SymbolFitter, toggleSymbolPopover } from './symbol-overflow';
import { SymbolPicker } from './symbol-picker';

/** Where the editor reads the person's symbols, and hears when they change (Settings, sync). */
export interface SymbolSource {
  get(): readonly LineSymbol[];
  subscribe(listener: () => void): () => void;
}

/** A fixed list as a source (tests, an editor outside the app). */
export const fixedSymbols = (symbols: readonly LineSymbol[]): SymbolSource => ({
  get: () => symbols,
  subscribe: () => () => {},
});

export interface LineSymbolsOptions {
  /** The person's symbols (default: the built-in list). */
  readonly symbols: SymbolSource | undefined;
  /** Opens Settings → Symbols ("Edit symbols…" in the picker); absent, the picker has no such item. */
  readonly onEditSymbols: (() => void) | undefined;
  /** A slot's shortcut as shown on keycaps (`⌃1`), for the picker; absent, none is shown. */
  readonly shortcutOf: ((index: number) => string | null) | undefined;
}

export interface LineSymbolsStorage {
  picker: SymbolPicker | null;
  /** Stops following the source. */
  off: (() => void) | null;
  readonly options: LineSymbolsOptions;
}

interface PluginState {
  readonly symbols: readonly LineSymbol[];
  /** Where the caret's line starts (-1: none); its bare last glyph is not drawn (A741). */
  readonly caretLine: number;
  readonly decorations: DecorationSet;
}

type Meta = { readonly symbols: readonly LineSymbol[] } | { readonly raw: true };

export const lineSymbolsKey = new PluginKey<PluginState>('penmossLineSymbols');

/**
 * Reads where the browser has the caret now, if ProseMirror has not yet (A745). The browser
 * reports a caret moved by a key (an arrow, Home) a moment later, in `selectionchange`; a key
 * pressed meanwhile would act on the old selection, and a Backspace left to the browser would
 * delete the margin's widget with the symbols. ProseMirror's own observer reads it, as it does
 * before handling a key of its own.
 */
export function readDOMSelection(view: EditorView, event?: KeyboardEvent): void {
  // Never for a key ProseMirror made up itself (T44 review B1): Chrome on Android and Safari on
  // iOS let the browser split a line on Enter, and ProseMirror's observer, while it reads that
  // change, sends an Enter of its own; reading the DOM again inside that read would take the
  // half-split selection. Nor while composing or for a soft keyboard's key (keyCode 229), when
  // ProseMirror leaves the DOM to the input method.
  if (event && (!event.isTrusted || event.keyCode === 229)) return;
  if (view.composing) return;
  const observer = (view as unknown as { domObserver?: { forceFlush?(): void; flush?(): void } })
    .domObserver;
  observer?.forceFlush?.();
  observer?.flush?.();
}

/** A selection put inside a run on purpose (Enter splitting the line at its start). */
const isRaw = (tr: Transaction) => {
  const meta = tr.getMeta(lineSymbolsKey) as Meta | undefined;
  return meta !== undefined && 'raw' in meta;
};

/** Blocks whose lines never carry symbols (D36: not code or callouts). */
const NO_SYMBOLS = new Set(['codeBlock', 'callout', 'blockMath', 'rawMarkdown']);
/**
 * Textblocks that may (a list or checklist item's line is its paragraph). A table cell is a
 * textblock of its own, inline only as GFM's are (A9), so its symbols are its text's leading
 * glyphs, `| ★ Ship it |` (T52 item 2).
 */
const SYMBOL_BLOCKS = new Set(['paragraph', 'heading', 'tableCell', 'tableHeader']);

/** Whether a textblock is a table cell, where symbols sit before the text (T52 item 2). */
const isCell = (block: PMNode) => block.type.spec.tableRole !== undefined;

/** What drawing a margin needs: the picker for a click, and the fitter that sizes it. */
interface Drawing {
  readonly open: (view: EditorView, pos: number) => void;
  readonly fitter: SymbolFitter;
}

/** Longest leading text a run is read from: nine symbols of the longest glyph, and more. */
const LEADING_TEXT_CHARS = 400;

/** The text at the start of a textblock, up to its first inline node that is not text. */
function leadingText(block: PMNode): string {
  let text = '';
  for (let index = 0; index < block.childCount; index++) {
    const child = block.child(index);
    // Something follows that is not text (a picture, a break), or more text: the line does not
    // end here, so a last glyph without its space is not a symbol (T44 review).
    if (!child.isText || text.length >= LEADING_TEXT_CHARS) return `${text}\ufffc`;
    text += child.text ?? '';
  }
  return text;
}

/** Whether the textblock at `$pos`'s parent may carry symbols. */
function symbolLine($pos: ResolvedPos): boolean {
  if (!SYMBOL_BLOCKS.has($pos.parent.type.name)) return false;
  for (let depth = $pos.depth - 1; depth > 0; depth--) {
    if (NO_SYMBOLS.has($pos.node(depth).type.name)) return false;
  }
  return true;
}

/** Where the textblock holding the selection's head starts, or -1. */
function caretLineOf(state: EditorState): number {
  const { $head } = state.selection;
  return $head.parent.isTextblock && $head.depth > 0 ? $head.before() : -1;
}

/**
 * The symbol run of the textblock around `$pos`, or null when it has none or may not. `$pos`
 * is a selection end, so a last glyph with no space after it is text here, as it is drawn on
 * the caret's line (A741).
 */
export function runAt($pos: ResolvedPos, symbols: readonly LineSymbol[]): SymbolRun | null {
  if (!$pos.parent.isTextblock || !symbolLine($pos)) return null;
  const run = symbolRun(leadingText($pos.parent), symbols, false);
  return run.end > 0 ? run : null;
}

/** The person's symbols in an editor's state. */
export function lineSymbolsOf(state: EditorState): readonly LineSymbol[] {
  return lineSymbolsKey.getState(state)?.symbols ?? DEFAULT_SYMBOLS;
}

/** A run's symbols as they are named (T51 item 12, A940): by their glyphs. */
const glyphs = (run: SymbolRun, symbols: readonly LineSymbol[]) =>
  run.tokens.map((token) => symbols[token.index]!.glyph);

/** The margin's DOM for a run: the glyphs, coloured, and read once for screen readers. */
function gutter(
  run: SymbolRun,
  symbols: readonly LineSymbol[],
  view: EditorView,
  getPos: () => number | undefined,
  draw: Drawing,
  cell: boolean,
): HTMLElement {
  const doc = view.dom.ownerDocument;
  const element = doc.createElement('span');
  element.className = cell ? 'pm-symbols pm-symbols-cell' : 'pm-symbols';
  element.contentEditable = 'false';
  element.dataset['testid'] = 'line-symbols';
  const labels = glyphs(run, symbols);
  element.title = `${labels.join(' ')}: Click to Change`;
  for (const token of run.tokens) {
    const symbol = symbols[token.index]!;
    const glyph = doc.createElement('span');
    glyph.className = 'pm-symbol';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.dataset['symbol'] = String(token.index + 1);
    glyph.style.color = symbolColourVar(symbol.colour);
    glyph.textContent = symbol.glyph;
    element.append(glyph);
  }
  // Read before the line (A745, A940): "★ !: Send the form", with an older symbol's name too
  // ("★ Important ! Follow-up: …"), as punctuation alone may be read as nothing (T51 review).
  const spoken = doc.createElement('span');
  spoken.className = 'pm-symbols-label';
  spoken.textContent = `${run.tokens.map((token) => symbolSpokenName(symbols[token.index]!)).join(' ')}: `;
  element.append(spoken);
  // A tap on the "+N" chip shows every symbol (T52 item 3): touch has no hover. Cancelling the
  // press keeps the browser from sending the mouse events that open the picker.
  element.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || !(event.target instanceof Element)) return;
    if (!event.target.closest('.pm-symbols-more')) return;
    event.preventDefault();
    toggleSymbolPopover(element);
  });
  // A click opens the picker for this line; the editor keeps its focus until then.
  element.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    toggleSymbolPopover(element, false);
    const pos = getPos();
    if (pos !== undefined) draw.open(view, pos);
  });
  draw.fitter.drawn.add(element);
  return element;
}

/**
 * The decorations of one line (a paragraph or heading where symbols may go): its run hidden
 * and the margin's widget after it. Nothing on the block itself, so mapping the set through a
 * keystroke never touches every symbol line (T44 review: a node decoration per line lives in
 * its parent's set and is mapped on every change there).
 */
function decorateLine(
  doc: PMNode,
  block: PMNode,
  pos: number,
  symbols: readonly LineSymbol[],
  draw: Drawing,
  out: Decoration[],
  caretLine: number,
): void {
  if (!SYMBOL_BLOCKS.has(block.type.name) || !symbolLine(doc.resolve(pos + 1))) return;
  // A glyph with no space after it, ending the line, is drawn only once the caret has left the
  // line: typing `!` then a word, or `![[`, never hides the `!` (A741, A742).
  const run = symbolRun(leadingText(block), symbols, pos !== caretLine);
  if (run.end === 0) return;
  const start = pos + 1;
  const end = start + run.end;
  const cell = isCell(block);
  out.push(
    Decoration.inline(start, end, { class: 'pm-symbol-run' }),
    Decoration.widget(end, (view, getPos) => gutter(run, symbols, view, getPos, draw, cell), {
      side: -1,
      marks: [],
      ignoreSelection: true,
      stopEvent: () => true,
      key: `symbols:${run.tokens
        .map((token) => {
          const symbol = symbols[token.index]!;
          return `${symbol.glyph}|${symbol.name}|${symbol.colour}`;
        })
        .join('/')}`,
    }),
  );
}

function decorateAll(
  doc: PMNode,
  symbols: readonly LineSymbol[],
  draw: Drawing,
  caretLine: number,
): DecorationSet {
  const out: Decoration[] = [];
  if (symbols.length > 0) {
    doc.descendants((node, pos) => {
      if (NO_SYMBOLS.has(node.type.name)) return false;
      if (!node.isTextblock) return true;
      decorateLine(doc, node, pos, symbols, draw, out, caretLine);
      return false;
    });
  }
  return DecorationSet.create(doc, out);
}

/**
 * The textblocks a transaction may have changed the run of: those its steps touched, the
 * ones just beside each change (a split or join), and, for a step that wraps or lifts content
 * (into or out of a callout), every line it moved. Typing in one item of a long list finds
 * that item only.
 */
function changedLines(doc: PMNode, tr: Transaction): Map<number, PMNode> {
  let ranges: Array<[number, number]> = [];
  tr.steps.forEach((step, index) => {
    const map = tr.mapping.maps[index] ?? step.getMap();
    ranges = ranges.map(([from, to]) => [map.map(from, -1), map.map(to, 1)]);
    if (step instanceof ReplaceAroundStep) {
      ranges.push([map.map(step.from, -1), map.map(step.to, 1)]);
    } else if (step instanceof AttrStep) ranges.push([step.pos, step.pos + 1]);
    else map.forEach((_oldStart, _oldEnd, from, to) => ranges.push([from, to]));
  });
  const found = new Map<number, PMNode>();
  const size = doc.content.size;
  for (const [from, to] of ranges) {
    const a = Math.max(0, Math.min(from - 1, size));
    const b = Math.min(size, Math.max(to + 1, a + 1));
    if (a >= b) continue;
    doc.nodesBetween(a, b, (node, pos) => {
      if (!node.isTextblock) return true;
      found.set(pos, node);
      return false;
    });
  }
  return found;
}

/**
 * A selection end inside a run, moved to the line's text (A745). The very start of the line
 * stays for a range (a whole line selected, symbols and all); a caret always goes to the text.
 */
function outsideRun(
  doc: PMNode,
  pos: number,
  symbols: readonly LineSymbol[],
  caret: boolean,
): number {
  const $pos = doc.resolve(pos);
  const run = runAt($pos, symbols);
  if (!run) return pos;
  const offset = $pos.parentOffset;
  if (offset >= run.end || (!caret && offset === 0)) return pos;
  return $pos.start() + run.end;
}

/** Where ← from the start of a line's text goes: the end of the line before (null: none). */
function lineBefore(state: EditorState, $head: ResolvedPos): number | null {
  const before = Selection.findFrom(state.doc.resolve($head.before()), -1, true);
  return before ? before.head : null;
}

/** Backspace at the start of a symbol line's text: the last symbol goes, glyph and space (A745). */
function removeLastSymbol(view: EditorView, start: number, run: SymbolRun): void {
  const last = run.tokens[run.tokens.length - 1]!;
  view.dispatch(view.state.tr.delete(start + last.from, start + last.to).scrollIntoView());
}

/** The arrow key that moves back through the line's text: ← in left-to-right text, → in RTL. */
function backwardKey(view: EditorView, $head: ResolvedPos): string {
  const line = $head.depth > 0 ? view.nodeDOM($head.before()) : null;
  const element = line instanceof HTMLElement ? line : view.dom;
  const rtl = element.ownerDocument.defaultView?.getComputedStyle(element).direction === 'rtl';
  return rtl ? 'ArrowRight' : 'ArrowLeft';
}

/** The caret at the start of a symbol line's text, with that line's run; else null. */
function atTextStart(state: EditorState): { $head: ResolvedPos; run: SymbolRun } | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;
  const { $head } = selection;
  const run = runAt($head, lineSymbolsOf(state));
  if (!run || $head.parentOffset !== run.end) return null;
  return { $head, run };
}

/** The textblocks a toggle acts on: every line in the selection that may carry symbols. */
export function symbolLines(state: EditorState): Array<{ pos: number; node: PMNode }> {
  const { selection, doc } = state;
  const lines: Array<{ pos: number; node: PMNode }> = [];
  const take = (node: PMNode, pos: number) => {
    if (node.isTextblock && symbolLine(doc.resolve(pos + 1))) lines.push({ pos, node });
  };
  if (selection instanceof NodeSelection && !selection.node.isInline) {
    const { node, from } = selection;
    if (node.isTextblock) take(node, from);
    else
      node.descendants((child, offset) => {
        if (NO_SYMBOLS.has(child.type.name)) return false;
        if (child.isTextblock) take(child, from + 1 + offset);
        return !child.isTextblock;
      });
    return lines;
  }
  for (const range of selection.ranges) {
    const { $from, $to } = range;
    doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (NO_SYMBOLS.has(node.type.name)) return false;
      if (!node.isTextblock) return true;
      // A selection that ends at the very start of a line (a triple click, ⇧↓ to the next
      // line) leaves that line out, as other editors do (T44 review).
      if ($to.pos > $from.pos && pos + 1 === $to.pos && $to.parentOffset === 0) return false;
      take(node, pos);
      return false;
    });
  }
  return lines;
}

/** The symbol slots every line in the selection has (the picker's ticks, the phone's sheet). */
export function activeSymbols(state: EditorState): number[] {
  const lines = symbolLines(state);
  const symbols = lineSymbolsOf(state);
  if (lines.length === 0) return [];
  const runs = lines.map(({ node }) => symbolRun(leadingText(node), symbols));
  return symbols
    .map((_, index) => index)
    .filter((index) => runs.every((run) => run.tokens.some((token) => token.index === index)));
}

/** Whether a symbol can go on the selection's lines (it holds a paragraph, item or heading). */
export const canHaveSymbols = (state: EditorState): boolean => symbolLines(state).length > 0;

/**
 * Toggles the symbol in slot `index` (0-based) on every line in the selection (A740, A744):
 * added at its place by list order if any line lacks it, otherwise removed from each. Other
 * symbols are untouched. One transaction, so one undo step. False when the slot is empty or
 * the selection holds no line that may carry a symbol.
 */
export function toggleLineSymbol(index: number) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const symbols = lineSymbolsOf(state);
    if (!symbols[index]) return false;
    const lines = symbolLines(state);
    if (lines.length === 0) return false;
    const texts = lines.map(({ node }) => leadingText(node));
    const runs = texts.map((text) => symbolRun(text, symbols));
    const add = runs.some((run) => !run.tokens.some((token) => token.index === index));
    if (!dispatch) return true;
    const tr = state.tr;
    // Last line first, so earlier positions hold.
    for (let line = lines.length - 1; line >= 0; line--) {
      const start = lines[line]!.pos + 1;
      for (const edit of symbolEdits(runs[line]!, symbols, index, add, texts[line])) {
        if (edit.insert) tr.insert(start + edit.from, state.schema.text(edit.insert));
        else tr.delete(start + edit.from, start + edit.to);
      }
    }
    if (!tr.docChanged) return true;
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Runs a toggle on a view as its own undo step (A744), as moving a block is: typing just before
 * or after it is not undone with it.
 */
export function toggleSymbolIn(view: EditorView, index: number, fromKey = false): boolean {
  // A key's selection is the browser's (it may have just moved it); a menu's or the palette's
  // is the editor's, which a refocus must not replace with wherever the browser put the caret.
  if (fromKey && view.hasFocus()) readDOMSelection(view);
  return toggleLineSymbol(index)(view.state, (tr) => dispatchMove(view, tr));
}

/** Hands an editor a new list of symbols (Settings or sync changed it): every line redraws. */
export function setLineSymbols(editor: Editor, symbols: readonly LineSymbol[]): void {
  if (editor.isDestroyed) return;
  const meta: Meta = { symbols };
  editor.view.dispatch(editor.state.tr.setMeta(lineSymbolsKey, meta));
}

/** The storage of an editor's line symbols extension, if it has one. */
const storageOf = (editor: Editor): LineSymbolsStorage | undefined =>
  (editor.storage as unknown as { lineSymbols?: LineSymbolsStorage }).lineSymbols;

/**
 * Opens the symbol picker at the caret's line (A746): every symbol, ticked when every line in
 * the selection has it, and "Edit symbols…". False when no line here may carry one.
 */
export function openSymbolPicker(editor: Editor, fromKey = false): boolean {
  const storage = storageOf(editor);
  if (fromKey && editor.view.hasFocus()) readDOMSelection(editor.view);
  if (!storage || !canHaveSymbols(editor.state)) return false;
  storage.picker ??= new SymbolPicker(editor, {
    symbols: () => lineSymbolsOf(editor.state),
    active: () => activeSymbols(editor.state),
    toggle: (index) => {
      if (!editor.view.hasFocus()) editor.view.focus();
      toggleSymbolIn(editor.view, index);
    },
    onEditSymbols: storage.options.onEditSymbols,
    shortcutOf: storage.options.shortcutOf,
  });
  storage.picker.open();
  return true;
}

/** Closes the symbol picker if it is open (Back on Android, A747); whether it was. */
export function closeSymbolPicker(editor: Editor): boolean {
  const picker = storageOf(editor)?.picker;
  if (!picker?.isOpen) return false;
  picker.close();
  return true;
}

/** Whether the editor's symbol picker is open. */
export const symbolPickerOpen = (editor: Editor): boolean =>
  storageOf(editor)?.picker?.isOpen ?? false;

export const LineSymbols = Extension.create<LineSymbolsOptions, LineSymbolsStorage>({
  name: 'lineSymbols',
  // Ahead of the keymaps (Backspace, Enter and ← at the start of a symbol line), behind the
  // slash menu, which takes Enter and the arrows while it is open.
  priority: 999,

  addOptions() {
    return { symbols: undefined, onEditSymbols: undefined, shortcutOf: undefined };
  },

  addStorage() {
    return { picker: null, off: null, options: this.options };
  },

  onBeforeCreate() {
    // A new list from Settings or another device redraws every line (A743). Once per editor,
    // here rather than in a plugin view, which can outlive a view the editor replaced (and
    // before `create`, which TipTap emits a task later).
    const { editor } = this;
    const source = this.options.symbols;
    const storage = storageOf(editor);
    if (storage && source)
      storage.off = source.subscribe(() => setLineSymbols(editor, source.get()));
  },

  onDestroy() {
    const storage = storageOf(this.editor);
    storage?.off?.();
    storage?.picker?.destroy();
    if (storage) {
      storage.picker = null;
      storage.off = null;
    }
  },

  addProseMirrorPlugins() {
    const { editor, options } = this;
    const source = options.symbols;
    /** Opens the picker for the line whose margin was clicked (the caret goes to its text). */
    const open = (view: EditorView, widgetPos: number) => {
      const { state } = view;
      const $pos = state.doc.resolve(Math.min(widgetPos, state.doc.content.size));
      if (
        !(state.selection instanceof TextSelection) ||
        state.selection.$head.parent !== $pos.parent
      )
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, widgetPos)));
      if (!view.hasFocus()) view.focus();
      openSymbolPicker(editor);
    };
    const draw: Drawing = { open, fitter: new SymbolFitter() };
    return [
      new Plugin<PluginState>({
        key: lineSymbolsKey,
        state: {
          init: (_config, state) => {
            const symbols = source?.get() ?? DEFAULT_SYMBOLS;
            const caretLine = caretLineOf(state);
            const decorations = decorateAll(state.doc, symbols, draw, caretLine);
            return { symbols, caretLine, decorations };
          },
          apply: (tr, previous, _old, state) => {
            const meta = tr.getMeta(lineSymbolsKey) as Meta | undefined;
            const caretLine = caretLineOf(state);
            if (meta && 'symbols' in meta) {
              return {
                symbols: meta.symbols,
                caretLine,
                decorations: decorateAll(state.doc, meta.symbols, draw, caretLine),
              };
            }
            if (!tr.docChanged && caretLine === previous.caretLine) return previous;
            const { symbols } = previous;
            let set = tr.docChanged
              ? previous.decorations.map(tr.mapping, state.doc)
              : previous.decorations;
            if (symbols.length === 0) return { symbols, caretLine, decorations: set };
            const lines = tr.docChanged ? changedLines(state.doc, tr) : new Map<number, PMNode>();
            // The caret's old and new lines: a bare last glyph shows or hides as it moves (A741).
            const before = previous.caretLine < 0 ? -1 : tr.mapping.map(previous.caretLine, 1);
            if (before !== caretLine) {
              for (const pos of [before, caretLine]) {
                const line = pos < 0 ? null : state.doc.nodeAt(pos);
                if (line?.isTextblock) lines.set(pos, line);
              }
            }
            const added: Decoration[] = [];
            for (const [pos, line] of lines) {
              // Only this line's own: `find` also returns a neighbour's that touches it.
              const end = pos + line.nodeSize;
              const stale = set.find(pos, end).filter((deco) => deco.from > pos && deco.to < end);
              if (stale.length) set = set.remove(stale);
              decorateLine(state.doc, line, pos, symbols, draw, added, caretLine);
            }
            if (added.length) set = set.add(state.doc, added);
            return { symbols, caretLine, decorations: set };
          },
        },
        // Fits each margin to the gutter as it is drawn, and all of them on a resize (T52).
        view: (view) => {
          draw.fitter.attach(view);
          return { update: () => draw.fitter.update(), destroy: () => draw.fitter.destroy() };
        },
        // The caret never rests inside a run (A745). Only the selection moves, so the binding's
        // repair guard leaves this plugin alone (yjs14.ts).
        selectionOnly: true,
        appendTransaction: (transactions, _old, state) => {
          if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
          if (transactions.some(isRaw)) return null;
          const { selection } = state;
          if (!(selection instanceof TextSelection)) return null;
          const symbols = lineSymbolsOf(state);
          if (symbols.length === 0) return null;
          const caret = selection.empty;
          const anchor = outsideRun(state.doc, selection.anchor, symbols, caret);
          const head = caret ? anchor : outsideRun(state.doc, selection.head, symbols, false);
          if (anchor === selection.anchor && head === selection.head) return null;
          return state.tr.setSelection(TextSelection.create(state.doc, anchor, head));
        },
        props: {
          decorations: (state) => lineSymbolsKey.getState(state)?.decorations,
          handleDOMEvents: {
            // A soft keyboard's Backspace (Gboard sends keyCode 229 and then this): at the start
            // of a symbol line's text the browser would reach into the hidden run or do nothing
            // (ProseMirror then retries 50 ms later, closing and reopening the keyboard), so it
            // is handled here, as the key is (T44 review).
            beforeinput: (view, event) => {
              if (event.inputType !== 'deleteContentBackward' || view.composing) return false;
              const found = view.state.selection.empty ? atTextStart(view.state) : null;
              if (!found) return false;
              event.preventDefault();
              removeLastSymbol(view, found.$head.start(), found.run);
              return true;
            },
          },
          handleKeyDown: (view, event) => {
            if (event.isComposing || view.composing) return false;
            if (!['Backspace', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key))
              return false;
            readDOMSelection(view, event);
            const found = atTextStart(view.state);
            if (!found) return false;
            const { $head, run } = found;
            const { state } = view;
            const start = $head.start();
            if (event.key === 'Backspace' && state.selection.empty) {
              removeLastSymbol(view, start, run);
              return true;
            }
            if (event.key === backwardKey(view, $head) && !event.metaKey) {
              // A range collapses to its start, as ← always does (T44 review).
              if (!state.selection.empty && !event.shiftKey) return false;
              // Over the run, to the end of the line before (or nowhere, at the top).
              const target = lineBefore(state, $head);
              if (target === null) return true;
              const anchor = event.shiftKey ? state.selection.anchor : target;
              view.dispatch(
                state.tr
                  .setSelection(TextSelection.create(state.doc, anchor, target))
                  .scrollIntoView(),
              );
              return true;
            }
            if (
              event.key === 'Enter' &&
              state.selection.empty &&
              !event.shiftKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              $head.parentOffset < $head.parent.content.size &&
              !isCell($head.parent)
            ) {
              // The new line goes above and the symbols stay with the text: the line splits at
              // its very start, which the keymaps after this one do from here.
              const meta: Meta = { raw: true };
              view.dispatch(
                state.tr
                  .setSelection(TextSelection.create(state.doc, start))
                  .setMeta(lineSymbolsKey, meta),
              );
              return false;
            }
            return false;
          },
        },
      }),
    ];
  },
});
