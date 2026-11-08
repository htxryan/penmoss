/**
 * How many of a line's symbols are drawn (T52 item 3). A margin is only as wide as the note's
 * gutter, less the room the block's drag handle takes left of them, and a full-width note's has
 * room for one glyph, so a line with more spilled out of it, over the sidebar's edge or under
 * the handle. Now a line shows as many as fit, at least one;
 * past that, the first ones and a "+N" chip (or, where one slot is all there is, the first
 * symbol with a count badge on its corner). Hovering the margin, or tapping its chip, shows
 * them all in a small popover below it; from the keyboard, the picker (`editor.symbolPicker`)
 * ticks every symbol the line has. The text column never moves: the margin is still outside
 * it, and only fewer glyphs are drawn there.
 *
 * Where the symbols sit before the text instead (a phone, the Android page, a table cell),
 * they take at most `INLINE_CAP` slots, so a line's text still starts near its edge.
 *
 * Every symbol keeps its spoken name: the widget's label still names them all, and the chip
 * and popover are hidden from screen readers.
 */
import { MAX_SYMBOLS } from '@penmoss/core/line-symbols';
import type { EditorView } from '@tiptap/pm/view';

/** One glyph's slot, in the widget's em: `.pm-symbol` is 1.1em at least, and an emoji wider. */
const SLOT_EM = 1.25;
/** The gap between slots (`.pm-symbols`' gap) and the widget's own padding, in its em. */
const GAP_EM = 0.05;
const PADDING_EM = 0.2;
/** The room kept between the margin's symbols and the text (`.pm-symbols`' 0.3rem) and the gutter's edge. */
const TEXT_GAP_REM = 0.3;
const EDGE_PX = 2;
/**
 * The block's drag handle goes left of a line's symbols, 24 px before them (drag-handle.ts), so
 * the margin leaves it that room and the handle never covers a glyph (T52). A full-width note's
 * 3rem gutter then holds one slot: the first symbol with a count badge.
 */
export const HANDLE_PX = 24;

/**
 * Sent on the window when the note's layout moves its text column without any width the fitter
 * watches changing: the side panel shown or hidden, the panel's mode changed (T52 item 6). In a
 * wide window the column keeps its capped width and only moves, so no ResizeObserver sees it.
 */
export const NOTE_LAYOUT_EVENT = 'penmoss:note-layout';

/** Tells every editor's symbol margins the note's layout changed (see `NOTE_LAYOUT_EVENT`). */
export function noteLayoutChanged(win: Window = window): void {
  win.dispatchEvent(new Event(NOTE_LAYOUT_EVENT));
}

/** At most this many slots before a line's text, where there is no margin. */
export const INLINE_CAP = 3;

/** How many slots fit `width` px of gutter at a font size of `fontPx`: at least one. */
export function slotsFitting(width: number, fontPx: number): number {
  if (!(fontPx > 0) || !Number.isFinite(width)) return MAX_SYMBOLS;
  const slots = Math.floor((width / fontPx - PADDING_EM + GAP_EM) / (SLOT_EM + GAP_EM));
  return Math.max(1, Math.min(MAX_SYMBOLS, slots));
}

/**
 * Draws at most `cap` of a margin's symbols (at least one). Past that, the first `cap - 1`
 * stay and a chip counts the rest; with a cap of one the count is a badge on the first symbol.
 * The popover holds every symbol, in order and coloured. Idempotent.
 */
export function fitSymbols(element: HTMLElement, cap: number): void {
  const limit = Math.max(1, Math.floor(cap));
  if (element.dataset['cap'] === String(limit)) return;
  element.dataset['cap'] = String(limit);
  const glyphs = [...element.querySelectorAll<HTMLElement>(':scope > .pm-symbol')];
  const overflowing = glyphs.length > limit;
  const shown = overflowing ? Math.max(1, limit - 1) : glyphs.length;
  glyphs.forEach((glyph, index) => {
    glyph.hidden = index >= shown;
  });
  element.classList.toggle('is-overflowing', overflowing);
  element.classList.toggle('is-badge', overflowing && limit === 1);
  let more = element.querySelector<HTMLElement>(':scope > .pm-symbols-more');
  let popover = element.querySelector<HTMLElement>(':scope > .pm-symbols-popover');
  if (!overflowing) {
    more?.remove();
    popover?.remove();
    element.classList.remove('is-open');
    return;
  }
  const doc = element.ownerDocument;
  if (!more) {
    more = doc.createElement('span');
    more.className = 'pm-symbols-more';
    more.setAttribute('aria-hidden', 'true');
    glyphs[glyphs.length - 1]!.after(more);
  }
  more.textContent = `+${glyphs.length - shown}`;
  if (!popover) {
    popover = doc.createElement('span');
    popover.className = 'pm-symbols-popover';
    popover.setAttribute('aria-hidden', 'true');
    more.after(popover);
  }
  popover.replaceChildren(
    ...glyphs.map((glyph) => {
      const copy = doc.createElement('span');
      copy.className = 'pm-symbols-popover-glyph';
      copy.style.color = glyph.style.color;
      copy.textContent = glyph.textContent;
      return copy;
    }),
  );
}

/** Whether the margin's symbols show their popover from a tap (touch has no hover). */
export function toggleSymbolPopover(element: HTMLElement, open?: boolean): void {
  if (!element.classList.contains('is-overflowing')) open = false;
  const opened = element.classList.toggle('is-open', open);
  if (!opened) return;
  // The next press anywhere else closes it.
  const doc = element.ownerDocument;
  const close = (event: Event) => {
    if (event.target instanceof Node && element.contains(event.target)) return;
    element.classList.remove('is-open');
    doc.removeEventListener('pointerdown', close, true);
  };
  doc.addEventListener('pointerdown', close, true);
}

/** The nearest ancestor that clips or scrolls sideways: the margin cannot draw past its edge. */
export function clipOf(element: HTMLElement): HTMLElement | null {
  const win = element.ownerDocument.defaultView;
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = win?.getComputedStyle(node).overflowX;
    if (overflow && overflow !== 'visible') return node;
  }
  return null;
}

/**
 * Fits an editor's symbol margins to its gutter: each new margin as it is drawn, and every one
 * when the editor or the pane around it changes size (full width, the sidebar, the window).
 * The cap is worked out once per kind of line (a paragraph, each heading level), whose font
 * sizes the glyphs, until the next resize: nothing is measured per keystroke or per line.
 */
export class SymbolFitter {
  /** Margins drawn since the view last updated. */
  readonly drawn = new Set<HTMLElement>();
  private view: EditorView | null = null;
  /** The gutter's width in px, left of the text column (null: not measured yet). */
  private gutter: number | null = null;
  /** The cap for each kind of line, by its element's name (`P`, `H2`), until the next resize. */
  private readonly caps = new Map<string, number>();
  private observer: ResizeObserver | null = null;
  /** Each observed element's width when last seen: only a change of width moves the gutter. */
  private readonly widths = new WeakMap<Element, number>();
  private frame = 0;

  /** Starts fitting `view`'s margins (a plugin view's constructor). */
  attach(view: EditorView): void {
    this.view = view;
    const win = view.dom.ownerDocument.defaultView;
    if (win && typeof win.ResizeObserver === 'function') {
      // The editor grows taller with nearly every Enter, and with a line that wraps: that is
      // no resize of the gutter, so it never refits (a refit reads layout and touches every
      // margin, which a keystroke in a long note must not pay for).
      this.observer = new win.ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const width = entry.contentRect.width;
          if (this.widths.get(entry.target) !== width) changed = true;
          this.widths.set(entry.target, width);
        }
        if (changed) this.schedule();
      });
      this.observer.observe(view.dom);
      const clip = clipOf(view.dom);
      if (clip) this.observer.observe(clip);
    }
    win?.addEventListener('resize', this.schedule);
    win?.addEventListener(NOTE_LAYOUT_EVENT, this.schedule);
    this.refit();
  }

  /** Fits the margins drawn since the last update (a plugin view's `update`). */
  update(): void {
    if (this.drawn.size === 0) return;
    const drawn = [...this.drawn];
    this.drawn.clear();
    for (const element of drawn) if (element.isConnected) this.fit(element);
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    const win = this.view?.dom.ownerDocument.defaultView;
    win?.removeEventListener('resize', this.schedule);
    win?.removeEventListener(NOTE_LAYOUT_EVENT, this.schedule);
    if (this.frame) win?.cancelAnimationFrame(this.frame);
    this.drawn.clear();
    this.caps.clear();
    this.view = null;
  }

  private readonly schedule = () => {
    const win = this.view?.dom.ownerDocument.defaultView;
    if (!win || this.frame) return;
    this.frame = win.requestAnimationFrame(() => {
      this.frame = 0;
      this.refit();
    });
  };

  /** Measures the gutter again and fits every margin to it. */
  refit(): void {
    const { view } = this;
    if (!view) return;
    this.gutter = this.measure(view);
    this.caps.clear();
    this.drawn.clear();
    for (const element of view.dom.querySelectorAll<HTMLElement>('.pm-symbols')) {
      delete element.dataset['cap'];
      this.fit(element);
    }
  }

  private measure(view: EditorView): number {
    const doc = view.dom.ownerDocument;
    const clip = clipOf(view.dom);
    const left = clip ? clip.getBoundingClientRect().left : 0;
    const rem = parseFloat(doc.defaultView?.getComputedStyle(doc.documentElement).fontSize ?? '');
    const gap = TEXT_GAP_REM * (rem > 0 ? rem : 16) + EDGE_PX;
    return view.dom.getBoundingClientRect().left - left - gap;
  }

  private fit(element: HTMLElement): void {
    const { view } = this;
    if (!view || element.classList.contains('pm-symbols-cell')) {
      fitSymbols(element, INLINE_CAP);
      return;
    }
    const kind = element.parentElement?.nodeName ?? '';
    let cap = this.caps.get(kind);
    if (cap === undefined) {
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      // The stylesheet puts the margin outside the text (absolute) or before it (a phone).
      if (style?.position === 'absolute') {
        this.gutter ??= this.measure(view);
        cap = slotsFitting(this.gutter - HANDLE_PX, parseFloat(style.fontSize));
      } else cap = INLINE_CAP;
      this.caps.set(kind, cap);
    }
    fitSymbols(element, cap);
  }
}
