/**
 * More symbols than the margin holds (T52 item 3): as many as fit, at least one, then a "+N"
 * chip (or a badge when one slot is all there is), every symbol in a popover that hovering or
 * a tap on the chip shows, and every spoken name kept.
 */
import type { JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INLINE_CAP,
  NOTE_LAYOUT_EVENT,
  HANDLE_PX,
  SymbolFitter,
  noteLayoutChanged,
  fitSymbols,
  slotsFitting,
} from '../src/extensions/symbol-overflow';
import { openEditor, paragraph } from './support/editor';

afterEach(() => {
  document.head.querySelectorAll('style[data-test]').forEach((style) => style.remove());
});

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

describe('how many symbols the gutter holds (T52 item 3)', () => {
  it('counts the slots that fit, at least one and at most nine', () => {
    // A full-width note's 3rem gutter, less the gap to the text: two 14.4 px glyphs.
    expect(slotsFitting(48 - 4.8 - 2, 14.4)).toBe(2);
    expect(slotsFitting(200, 14.4)).toBe(9);
    expect(slotsFitting(120, 14.4)).toBe(6);
    expect(slotsFitting(10, 14.4)).toBe(1);
    expect(slotsFitting(-30, 14.4)).toBe(1);
    // Not measurable (no layout): everything shows.
    expect(slotsFitting(Number.NaN, 14.4)).toBe(9);
    expect(slotsFitting(100, Number.NaN)).toBe(9);
  });
});

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

describe('fitting an editor’s margins to its gutter (T52 item 3)', () => {
  const content: JSONContent[] = [
    paragraph('! 💡 → Three symbols'),
    paragraph('★ One symbol'),
    paragraph('★ ? ! 💡 → Five symbols'),
  ];
  const lines = (view: EditorView) =>
    [...view.dom.querySelectorAll<HTMLElement>('.pm-symbols')].map(
      (element) => `${shown(element)}${chip(element) ?? ''}`,
    );

  it('caps symbols before the text at three slots, the label naming every one', () => {
    const { editor } = openEditor(content);
    const { view } = editor;
    expect(INLINE_CAP).toBe(3);
    expect(lines(view)).toEqual(['!💡→', '★', '★?+3']);
    expect(view.dom.querySelectorAll('.pm-symbols-label')[2]?.textContent).toBe(
      '★ Important ? Question ! Follow-up 💡 Idea → Next: ',
    );
  });

  it('fits the margin to the gutter, and refits when the gutter changes', () => {
    const style = document.createElement('style');
    style.dataset['test'] = '';
    style.textContent = '.pm-symbols { position: absolute; font-size: 14.4px; }';
    document.head.append(style);
    const { editor } = openEditor([paragraph('')]);
    const { view } = editor;
    // A full-width note: the text column starts 48 px into the page.
    let left = 48;
    vi.spyOn(view.dom, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(left, 0, 600, 400),
    );
    const fitter = new SymbolFitter();
    fitter.attach(view);
    editor.commands.setContent({ type: 'doc', content });
    for (const element of view.dom.querySelectorAll<HTMLElement>('.pm-symbols'))
      fitter.drawn.add(element);
    fitter.update();
    // Less the drag handle's room left of them (T52): one slot, the first symbol with a badge.
    const badge = () => view.dom.querySelector('.pm-symbols')?.classList.contains('is-badge');
    expect(lines(view)).toEqual(['!+2', '★', '★+4']);
    expect(badge()).toBe(true);
    // A little wider: two slots, the first symbol and a "+N" chip, the handle still clear.
    left = 48 + HANDLE_PX + 8;
    fitter.refit();
    expect(lines(view)).toEqual(['!+2', '★', '★+4']);
    expect(badge()).toBe(false);
    // The sidebar closes: a wide gutter shows them all.
    left = 300;
    fitter.refit();
    expect(lines(view)).toEqual(['!💡→', '★', '★?!💡→']);
    // A very narrow one: the first symbol and a badge.
    left = 20;
    fitter.refit();
    expect(lines(view)).toEqual(['!+2', '★', '★+4']);
    expect(badge()).toBe(true);
    fitter.destroy();
  });

  it('refits when the note’s layout moves the text column at the same width (the side panel)', () => {
    expect(NOTE_LAYOUT_EVENT).toBe('penmoss:note-layout');
    const style = document.createElement('style');
    style.dataset['test'] = '';
    style.textContent = '.pm-symbols { position: absolute; font-size: 14.4px; }';
    document.head.append(style);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { editor } = openEditor(content);
    const { view } = editor;
    // A wide window, the panel hidden: the capped column sits well inside the pane.
    let left = 300;
    vi.spyOn(view.dom, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(left, 0, 600, 400),
    );
    const fitter = new SymbolFitter();
    fitter.attach(view);
    expect(lines(view)).toEqual(['!💡→', '★', '★?!💡→']);
    // The side panel shows: the column moves left at the same width, the gutter is 3rem.
    left = 48;
    noteLayoutChanged();
    for (const frame of frames.splice(0)) frame(0);
    expect(lines(view)).toEqual(['!+2', '★', '★+4']);
    // Once destroyed, a later change asks nothing of it.
    fitter.destroy();
    const refit = vi.spyOn(fitter, 'refit');
    noteLayoutChanged();
    for (const frame of frames.splice(0)) frame(0);
    expect(refit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('refits when the editor gets wider or narrower, never when it only gets taller', () => {
    // jsdom has no ResizeObserver: one whose notices the test sends.
    let notify: ResizeObserverCallback = () => undefined;
    class FakeObserver {
      constructor(callback: ResizeObserverCallback) {
        notify = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeObserver);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    try {
      const { editor } = openEditor(content);
      const { view } = editor;
      const fitter = new SymbolFitter();
      const refit = vi.spyOn(fitter, 'refit');
      fitter.attach(view);
      refit.mockClear();
      const resize = (width: number, height: number) => {
        const entry = { target: view.dom, contentRect: new DOMRect(0, 0, width, height) };
        notify([entry as unknown as ResizeObserverEntry], {} as ResizeObserver);
        for (const frame of frames.splice(0)) frame(0);
      };
      resize(600, 400);
      expect(refit).toHaveBeenCalledTimes(1);
      // Enter, a wrapped line: taller only.
      resize(600, 424);
      resize(600, 448);
      expect(refit).toHaveBeenCalledTimes(1);
      // Full width, or the sidebar: a new width.
      resize(900, 448);
      expect(refit).toHaveBeenCalledTimes(2);
      fitter.destroy();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
