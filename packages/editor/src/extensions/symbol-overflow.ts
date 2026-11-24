/**
 * How many of a line's symbols are drawn (T52 item 3, A1680). The note's symbol gutter has
 * room for its widest stack up to three slots (`gutterSlots`, `line-symbols.ts`), so a line with
 * three or fewer shows them all; one with more shows the first two and a "+N" chip. A table
 * cell, whose symbols sit before its text, takes the same three. Hovering the margin, or tapping
 * its chip, shows them all in a small popover below it; from the keyboard, the picker
 * (`editor.symbolPicker`) ticks every symbol the line has.
 *
 * Every symbol keeps its spoken name: the widget's label still names them all, and the chip
 * and popover are hidden from screen readers.
 */

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
