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

describe('the glyph picker (item 9)', () => {
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

  it('shows the glyph and opens a grid of presets, the current one pressed', () => {
    render();
    const button = $('[data-testid="symbol-glyph-1"]');
    expect(button.textContent).toBe('★');
    expect(button.getAttribute('aria-label')).toBe('Glyph ★');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const options = [...host.querySelectorAll<HTMLButtonElement>('.glyph-option')];
    expect(options.map((option) => option.textContent)).toEqual([...SYMBOL_GLYPH_PRESETS]);
    expect($('[data-glyph="★"]').getAttribute('aria-pressed')).toBe('true');
    // Only the current one is in the tab order; arrows move across the grid.
    expect(options.filter((option) => option.tabIndex === 0)).toHaveLength(1);
  });

  it('marks a preset another symbol uses and refuses it', () => {
    const onChoose = render();
    act(() => $('[data-testid="symbol-glyph-1"]').click());
    const taken = $('[data-glyph="?"]');
    expect(taken.getAttribute('aria-disabled')).toBe('true');
    expect(taken.getAttribute('aria-label')).toBe('?, Already symbol 2');
    act(() => taken.click());
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('chooses a preset and closes', () => {
    const onChoose = render();
    act(() => $('[data-testid="symbol-glyph-1"]').click());
    act(() => $('[data-glyph="⚑"]').click());
    expect(onChoose).toHaveBeenCalledWith('⚑');
    expect(host.querySelector('.glyph-popover')).toBeNull();
  });

  it('moves with the arrow keys and closes on Escape', () => {
    render();
    act(() => $('[data-testid="symbol-glyph-1"]').click());
    const star = $('[data-glyph="★"]');
    act(() => star.focus());
    key(star, 'ArrowRight');
    expect(document.activeElement?.getAttribute('data-glyph')).toBe(SYMBOL_GLYPH_PRESETS[1]);
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement?.getAttribute('data-glyph')).toBe(SYMBOL_GLYPH_PRESETS[8]);
    key(document.activeElement!, 'Escape');
    expect(host.querySelector('.glyph-popover')).toBeNull();
    expect(document.activeElement).toBe($('[data-testid="symbol-glyph-1"]'));
  });

  it('takes a pasted glyph, and says why one cannot be', () => {
    const onChoose = render();
    act(() => $('[data-testid="symbol-glyph-1"]').click());
    const field = $<HTMLInputElement>('[data-testid="symbol-glyph-1-custom"]');
    const type = (text: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          field,
          text,
        );
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type('ab');
    act(() => $('[data-testid="symbol-glyph-1-use"]').click());
    expect($('.glyph-problem').textContent).toBe(glyphProblem('ab'));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(onChoose).not.toHaveBeenCalled();
    type('🦊');
    act(() => $('[data-testid="symbol-glyph-1-use"]').click());
    expect(onChoose).toHaveBeenCalledWith('🦊');
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
