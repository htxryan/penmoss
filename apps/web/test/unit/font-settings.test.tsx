// @vitest-environment happy-dom
import { FONT_PRESET_LABELS, FONT_PRESETS } from '@penmoss/core/fonts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FontSettings } from '../../src/theme/FontSettings';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';

// T51 item 16 (A944): Settings → Appearance → Fonts writes font.interface, font.note and
// font.noteSize through the workspace's settings, as the other synced settings do.

let root: Root | null = null;
let host: HTMLDivElement;
let settings: Record<string, unknown>;
let writes: Array<[string, unknown]>;

const workspace = {
  settings: () => ({ ...settings }),
  setSetting: (key: string, value: unknown) => {
    writes.push([key, value]);
    if (value === undefined) delete settings[key];
    else settings[key] = value;
    render();
  },
} as unknown as Workspace;

function render() {
  act(() =>
    root!.render(
      <WorkspaceContext.Provider value={workspace}>
        <FontSettings />
      </WorkspaceContext.Provider>,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  settings = {};
  writes = [];
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
const setValue = (element: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(() => {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });

describe('Settings → Appearance → Fonts', () => {
  it('offers every preset, each in its own font, and Custom…, in the shared select', () => {
    render();
    const select = $<HTMLSelectElement>('[data-testid="interface-font"] select');
    expect(select.className).toBe('pm-select');
    const options = [...select.options];
    expect(options.map((option) => option.textContent)).toEqual([
      ...FONT_PRESETS.map((preset) => FONT_PRESET_LABELS[preset]),
      'Custom…',
    ]);
    expect(options.find((option) => option.value === 'serif')!.style.fontFamily).toContain(
      'ui-serif',
    );
    expect(select.value).toBe('theme');
    expect($('[data-testid="note-font"] .font-sample').textContent).toContain('quick brown fox');
  });

  it('stores a preset, and the theme’s own as no setting', () => {
    render();
    const select = $<HTMLSelectElement>('[data-testid="note-font"] select');
    setValue(select, 'serif');
    expect(writes.at(-1)).toEqual(['font.note', 'serif']);
    expect(select.value).toBe('serif');
    setValue(select, 'theme');
    expect(writes.at(-1)).toEqual(['font.note', undefined]);
  });

  it('takes a custom family once it is a name, and says why when it is not', () => {
    render();
    const select = $<HTMLSelectElement>('[data-testid="interface-font"] select');
    setValue(select, 'custom');
    expect(writes).toEqual([]);
    const field = $<HTMLInputElement>('[data-testid="interface-font-custom"]');
    setValue(field, 'Avenir; Next');
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect($('.font-problem').textContent).toBe(
      'Font name may hold only letters, digits, spaces, . _ and -.',
    );
    expect(writes).toEqual([]);
    setValue(field, ' Avenir Next ');
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(writes).toEqual([['font.interface', 'custom:Avenir Next']]);
    expect(select.value).toBe('custom');
  });

  it('steps the note size within 12–28 px and resets it', () => {
    settings['font.noteSize'] = 27;
    render();
    expect($('[data-testid="note-size-value"]').textContent).toBe('27 px');
    act(() => $<HTMLButtonElement>('[aria-label="Larger"]').click());
    expect(writes.at(-1)).toEqual(['font.noteSize', 28]);
    expect($<HTMLButtonElement>('[aria-label="Larger"]').disabled).toBe(true);
    act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].at(-1)!.click());
    expect(writes.at(-1)).toEqual(['font.noteSize', undefined]);
    expect($('[data-testid="note-size-value"]').textContent).toBe('16 px');
    // The sample line is drawn at the size.
    expect($<HTMLElement>('[data-testid="note-size-setting"] .font-sample').style.fontSize).toBe(
      '16px',
    );
  });
});
