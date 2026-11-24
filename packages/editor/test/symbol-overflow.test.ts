/**
 * More symbols than the gutter holds (T52 item 3, A1680): the gutter has room for three, so
 * a line with more shows the first two and a "+N" chip (fitSymbols also draws a badge when one
 * slot is all there is), every symbol in a popover that hovering or a tap on the chip shows, and
 * every spoken name kept.
 */
import { GUTTER_SLOTS } from '@penmoss/core/line-symbols';
import type { JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { describe, expect, it } from 'vitest';
import { fitSymbols } from '../src/extensions/symbol-overflow';
import { openEditor, paragraph } from './support/editor';

/** A margin as the editor draws it: a glyph per symbol, then the spoken label. */
function margin(glyphs: string[]): HTMLElement {
  const element = document.createElement('span');
  element.className = 'pm-symbols';
  for (const glyph of glyphs) {
    const span = document.createElement('span');
    span.className = 'pm-symbol';
    span.style.color = 'var(--pm-accent)';
    span.textContent = glyph;
    element.append(span);
  }
  const label = document.createElement('span');
  label.className = 'pm-symbols-label';
  label.textContent = 'All of them: ';
  element.append(label);
  document.body.append(element);
  return element;
}

const shown = (element: HTMLElement) =>
  [...element.querySelectorAll<HTMLElement>(':scope > .pm-symbol')]
    .filter((glyph) => !glyph.hidden)
    .map((glyph) => glyph.textContent)
    .join('');
const chip = (element: HTMLElement) =>
  element.querySelector(':scope > .pm-symbols-more')?.textContent ?? null;
const popover = (element: HTMLElement) =>
  [...element.querySelectorAll('.pm-symbols-popover-glyph')].map((g) => g.textContent).join('');

function press(target: Element, pointerType: string) {
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  target.dispatchEvent(event);
  return event;
}

describe('a margin with more symbols than fit (T52 item 3)', () => {
  it('shows them all, and nothing more, when they fit', () => {
    const element = margin(['!', '💡', '→']);
    fitSymbols(element, 3);
    expect(shown(element)).toBe('!💡→');
    expect(chip(element)).toBeNull();
    expect(element.querySelector('.pm-symbols-popover')).toBeNull();
    expect(element.classList.contains('is-overflowing')).toBe(false);
  });

  it('shows the first ones and a "+N" chip, every symbol in the popover, the label kept', () => {
    const element = margin(['!', '💡', '→', '★']);
    fitSymbols(element, 2);
    expect(shown(element)).toBe('!');
    expect(chip(element)).toBe('+3');
    expect(popover(element)).toBe('!💡→★');
    expect(element.classList.contains('is-overflowing')).toBe(true);
    expect(element.classList.contains('is-badge')).toBe(false);
    // Coloured as in the margin; the chip and popover are not read (the label names them all).
    const first = element.querySelector<HTMLElement>('.pm-symbols-popover-glyph')!;
    expect(first.style.color).toBe('var(--pm-accent)');
    expect(element.querySelector('.pm-symbols-more')?.getAttribute('aria-hidden')).toBe('true');
    expect(element.querySelector('.pm-symbols-popover')?.getAttribute('aria-hidden')).toBe('true');
    expect(element.querySelector('.pm-symbols-label')?.textContent).toBe('All of them: ');
    // The chip follows the glyphs, before the label.
    expect(element.querySelector('.pm-symbols-more')?.nextElementSibling?.className).toBe(
      'pm-symbols-popover',
    );

    fitSymbols(element, 3);
    expect(shown(element)).toBe('!💡');
    expect(chip(element)).toBe('+2');
    fitSymbols(element, 9);
    expect(shown(element)).toBe('!💡→★');
    expect(chip(element)).toBeNull();
    expect(element.querySelector('.pm-symbols-popover')).toBeNull();
  });

  it('keeps one symbol with a count badge where only one fits', () => {
    const element = margin(['!', '💡', '→']);
    fitSymbols(element, 1);
    expect(shown(element)).toBe('!');
    expect(chip(element)).toBe('+2');
    expect(element.classList.contains('is-badge')).toBe(true);
    fitSymbols(element, 0);
    expect(shown(element)).toBe('!');
  });

  it('opens the popover from a tap on the chip, and closes it on a press elsewhere', () => {
    const collab = openEditor([paragraph('! 💡 → ★ Lots of symbols')]);
    const drawn = collab.editor.view.dom.querySelector<HTMLElement>('.pm-symbols')!;
    // No stylesheet here: the margin sits before the text, three slots at most.
    expect(shown(drawn)).toBe('!💡');
    expect(chip(drawn)).toBe('+2');
    const more = drawn.querySelector('.pm-symbols-more')!;
    const tap = press(more, 'touch');
    expect(tap.defaultPrevented).toBe(true);
    expect(drawn.classList.contains('is-open')).toBe(true);
    press(document.body, 'touch');
    expect(drawn.classList.contains('is-open')).toBe(false);
    // A mouse's press is left to hover, and its click opens the picker as before.
    press(more, 'mouse');
    expect(drawn.classList.contains('is-open')).toBe(false);
  });
});

describe('an editor’s margins in its gutter (T52 item 3, A1680)', () => {
  const content: JSONContent[] = [
    paragraph('! 💡 → Three symbols'),
    paragraph('★ One symbol'),
    paragraph('★ ? ! 💡 → Five symbols'),
  ];
  const lines = (view: EditorView) =>
    [...view.dom.querySelectorAll<HTMLElement>('.pm-symbols')].map(
      (element) => `${shown(element)}${chip(element) ?? ''}`,
    );

  it('shows three slots at most, past that two and a chip, the label naming every one', () => {
    const { editor } = openEditor(content);
    const { view } = editor;
    expect(GUTTER_SLOTS).toBe(3);
    expect(lines(view)).toEqual(['!💡→', '★', '★?+3']);
    expect(view.dom.querySelectorAll('.pm-symbols-label')[2]?.textContent).toBe(
      '★ Important ? Question ! Follow-up 💡 Idea → Next: ',
    );
    // At any width: nothing is measured, so a window's size never changes what a line shows.
    expect(view.dom.querySelector('.pm-symbols.is-badge')).toBeNull();
  });
});
