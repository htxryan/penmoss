// @vitest-environment happy-dom
import { SYMBOL_GLYPH_PRESETS, glyphProblem } from '@penmoss/core/line-symbols';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlyphPicker } from '../../src/notes/GlyphPicker';
import { ColourPicker, type ColourSwatch } from '../../src/shell/ColourPicker';
import { hsvToHex } from '../../src/shell/colour';

// T51 items 9 and 10 (A939): the glyph picker and the colour picker of Settings → Symbols.

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

const $ = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
const key = (target: Element, name: string, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key: name, bubbles: true, ...init }));
  });

/**
 * Frames that run only when `run` is called: a page so loaded that the panel's first frame comes
 * after a click and some typing in it (symbols.spec.ts's T44 colour check, once under load).
 */
function lateFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
  return { run: () => act(() => frames.splice(0).forEach((frame) => frame(0))) };
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the glyph picker (item 9; the icon picker’s Characters since A1568)', () => {
  function render(onChoose = vi.fn(() => null as string | null)) {
    act(() =>
      root!.render(
        <GlyphPicker
          glyph="★"
          label="Glyph ★"
          colour="var(--pm-accent)"
          takenBy={(glyph) => (glyph === '?' ? 'Already symbol 2' : null)}
          problemOf={(glyph) => glyphProblem(glyph)}
          onChoose={onChoose}
          disabled={false}
          testId="symbol-glyph-1"
        />,
      ),
    );
    return onChoose;
  }

  const cell = (glyph: string) =>
    $(`[data-testid="symbol-glyph-1-picker-cell"][data-value="${glyph}"]`);
  const search = () => $<HTMLInputElement>('[data-testid="symbol-glyph-1-picker-search"]');
  /** Opens the picker and waits for its chunk and the Characters. */
  async function open() {
    act(() => $('[data-testid="symbol-glyph-1"]').click());
    await vi.waitFor(() => expect(host.querySelector('[data-value="★"]')).not.toBeNull(), {
      timeout: 5_000,
    });
  }
  const type = (text: string) =>
    act(() => {
      const field = search();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });

  it('shows the glyph and opens the Characters, the old presets first, the current one marked', async () => {
    render();
    const button = $('[data-testid="symbol-glyph-1"]');
    expect(button.textContent).toBe('★');
    expect(button.getAttribute('aria-label')).toBe('Glyph ★');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await open();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const dialog = $('[role="dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Characters only: a line symbol is text, so there is no Icons tab here.
    expect(host.querySelector('[role="tab"]')).toBeNull();
    expect(document.activeElement).toBe(search());
    const shown = [...host.querySelectorAll<HTMLElement>('[role="option"]')].map(
      (option) => option.dataset['value'],
    );
    expect(shown.slice(0, 8)).toEqual(SYMBOL_GLYPH_PRESETS.slice(0, 8));
    expect(cell('★').getAttribute('aria-current')).toBe('true');
    expect(cell('★').getAttribute('aria-selected')).toBe('true');
    expect(cell('★').getAttribute('aria-label')).toBe('Star');
  });

  it('marks a character another symbol uses and refuses it', async () => {
    const onChoose = render();
    await open();
    const taken = cell('?');
    expect(taken.getAttribute('aria-disabled')).toBe('true');
    expect(taken.getAttribute('aria-label')).toBe('Question Mark, Already symbol 2');
    act(() => taken.click());
    expect(onChoose).not.toHaveBeenCalled();
    expect($('[data-testid="symbol-glyph-1-picker-problem"]').textContent).toBe('Already symbol 2');
  });

  it('chooses a character and closes, focus back on the button', async () => {
    const onChoose = render();
    await open();
    act(() => cell('⚑').click());
    expect(onChoose).toHaveBeenCalledWith('⚑');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe($('[data-testid="symbol-glyph-1"]'));
  });

  it('finds by name or keyword, moves with the arrow keys, picks with Return', async () => {
    const onChoose = render();
    await open();
    type('bulb');
    expect(host.querySelector('[role="option"]')!.getAttribute('data-value')).toBe('💡');
    type('arrow');
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    key(search(), 'ArrowRight');
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    expect(search().getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    key(search(), 'Enter');
    expect(onChoose).toHaveBeenCalledWith(options[1]!.dataset['value']);
  });

  it('closes on Escape without a change, focus back on the button', async () => {
    const onChoose = render();
    await open();
    key(search(), 'Escape');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(onChoose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe($('[data-testid="symbol-glyph-1"]'));
  });

  it('takes a pasted glyph that is not in the list, and says why one cannot be', async () => {
    const onChoose = render();
    await open();
    type('#');
    expect($('[data-testid="symbol-glyph-1-picker-problem"]').textContent).toBe(glyphProblem('#'));
    expect(host.querySelector('[data-value="#"]')).toBeNull();
    // ⸙ is no preset and no emoji: offered as it is.
    type('⸙');
    const own = cell('⸙');
    expect(own.getAttribute('aria-label')).toBe('Use ⸙');
    key(search(), 'Enter');
    expect(onChoose).toHaveBeenCalledWith('⸙');
  });

  it('finds nothing for a word nothing has', async () => {
    render();
    await open();
    type('zzqqxx');
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect($('[data-testid="symbol-glyph-1-picker-empty"]').textContent).toBe(
      'No characters match “zzqqxx”.',
    );
  });
});

describe('the colour picker (item 10)', () => {
  const swatches: ColourSwatch[] = [
    { value: 'accent', label: 'Accent', css: 'var(--pm-accent)' },
    { value: 'danger', label: 'Red', css: 'var(--pm-danger)' },
  ];

  function render(value: string, onChange = vi.fn()) {
    act(() =>
      root!.render(
        <ColourPicker
          label="Colour of ★"
          value={value}
          valueLabel={value === 'accent' ? 'Accent' : value.toUpperCase()}
          css={value}
          swatches={swatches}
          onChange={onChange}
          testId="symbol-colour-1"
        />,
      ),
    );
    act(() => $('[data-testid="symbol-colour-1"]').click());
    return onChange;
  }

  it('offers the theme’s colours as swatches, the chosen one checked', () => {
    const onChange = render('accent');
    expect($('[data-testid="symbol-colour-1"]').getAttribute('aria-label')).toBe(
      'Colour of ★: Accent',
    );
    const radios = [...host.querySelectorAll('[role="radio"]')];
    expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual(['Accent', 'Red']);
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
    act(() => (radios[1] as HTMLElement).click());
    expect(onChange).toHaveBeenCalledWith('danger');
  });

  it('takes a hex colour, normalised, and says when it is not one', () => {
    const onChange = render('#3366cc');
    const hex = $<HTMLInputElement>('[data-testid="symbol-colour-1-hex"]');
    expect(hex.value).toBe('#3366CC');
    const type = (text: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(hex, text);
        hex.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type('#12');
    key(hex, 'Enter');
    expect($('.colour-problem').textContent).toBe('Use #RGB, #RRGGBB or #RRGGBBAA.');
    expect(onChange).not.toHaveBeenCalled();
    type('#F80');
    key(hex, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith('#ff8800');
    type('#FF880080');
    key(hex, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith('#ff880080');
  });

  it('turns the hue and saturation on the wheel from the keyboard', () => {
    const onChange = render('#ff0000');
    const wheel = $('[data-testid="symbol-colour-1-wheel"]');
    expect(wheel.getAttribute('role')).toBe('slider');
    expect(wheel.getAttribute('aria-valuetext')).toBe('Hue 0°, saturation 100%');
    key(wheel, 'ArrowRight', { shiftKey: true });
    expect(wheel.getAttribute('aria-valuetext')).toBe('Hue 10°, saturation 100%');
    // Given out when the key is let go: red turned 10° towards orange.
    expect(onChange).toHaveBeenLastCalledWith(hsvToHex({ h: 10, s: 1, v: 1, a: 1 }));
    key(wheel, 'ArrowDown', { shiftKey: true });
    expect(wheel.getAttribute('aria-valuetext')).toBe('Hue 10°, saturation 90%');
  });

  it('changes the opacity with its slider, as #rrggbbaa', () => {
    const onChange = render('#3366cc');
    const alpha = $<HTMLInputElement>('[data-testid="symbol-colour-1-alpha"]');
    expect(alpha.value).toBe('100');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(alpha, '50');
      alpha.dispatchEvent(new Event('input', { bubbles: true }));
    });
    key(alpha, 'ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('#3366cc80');
  });

  it('focuses the chosen swatch once drawn, but never takes focus from the hex field', () => {
    const frames = lateFrames();
    const onChange = render('danger');
    const hex = $<HTMLInputElement>('[data-testid="symbol-colour-1-hex"]');
    act(() => hex.focus());
    frames.run();
    expect(document.activeElement).toBe(hex);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        hex,
        '#3366CC80',
      );
      hex.dispatchEvent(new Event('input', { bubbles: true }));
    });
    key(hex, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith('#3366cc80');
    // Opened with focus outside it: the chosen swatch takes it.
    key(hex, 'Escape');
    act(() => $('[data-testid="symbol-colour-1"]').click());
    frames.run();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Red');
  });

  it('closes on Escape and on a press outside', () => {
    render('accent');
    key($('[role="radio"]'), 'Escape');
    expect(host.querySelector('.colour-popover')).toBeNull();
    act(() => $('[data-testid="symbol-colour-1"]').click());
    expect(host.querySelector('.colour-popover')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(host.querySelector('.colour-popover')).toBeNull();
  });

  it('keeps a hex typed but not entered when a press outside closes it (T51 review)', () => {
    const onChange = render('#3366cc');
    const hex = $<HTMLInputElement>('[data-testid="symbol-colour-1-hex"]');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(hex, '#F80');
      hex.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(host.querySelector('.colour-popover')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith('#ff8800');
  });
});
