// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplaySettings } from '../../src/shell/DisplaySettings';
import { TooltipLayer } from '../../src/shell/Tooltip';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';

// PEN-70 (A1247): tooltips wait as long as Settings → Display → Show Tooltips After says
// (1000 ms unset, never on hover with Never); keyboard focus still shows one at once.

let root: Root | null = null;
let host: HTMLDivElement;
let settings: Record<string, unknown>;
let writes: Array<[string, unknown]>;
let state: { loaded: boolean };
const listeners = new Set<() => void>();

const notify = () => {
  state = { ...state };
  for (const listener of listeners) listener();
};

const workspace = {
  settings: () => ({ ...settings }),
  setSetting: (key: string, value: unknown) => {
    writes.push([key, value]);
    settings[key] = value;
    notify();
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState: () => state,
} as unknown as Workspace;

/** Settings changed elsewhere (another device, by sync). */
const synced = (key: string, value: unknown) =>
  act(() => {
    settings[key] = value;
    notify();
  });

function render(children: React.ReactNode) {
  act(() =>
    root!.render(
      <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>,
    ),
  );
}

let first: HTMLButtonElement;
let second: HTMLButtonElement;

function renderLayer() {
  render(<TooltipLayer />);
  first = document.createElement('button');
  first.dataset['tip'] = 'Search';
  second = document.createElement('button');
  second.dataset['tip'] = 'New Note';
  host.parentElement!.append(first, second);
}

const tooltip = () => document.querySelector('[data-testid="tooltip"]');
const hover = (element: Element) =>
  act(() => {
    element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  });
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  settings = {};
  writes = [];
  state = { loaded: true };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  listeners.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the tooltip layer (PEN-70)', () => {
  it('shows a hovered control’s tooltip after 1000 ms when unset, and not before (AC1)', () => {
    renderLayer();
    hover(first);
    wait(999);
    expect(tooltip()).toBeNull();
    wait(1);
    expect(tooltip()?.textContent).toBe('Search');
  });

  it('shows nothing when the pointer leaves before the delay (AC2)', () => {
    renderLayer();
    hover(first);
    wait(900);
    hover(document.body);
    wait(1600);
    expect(tooltip()).toBeNull();
  });

  it('uses each chosen delay, and a change applies to the next hover (AC4)', () => {
    renderLayer();
    for (const delay of [500, 1500, 2000]) {
      synced('tooltip.delay', delay);
      hover(document.body);
      hover(first);
      wait(delay - 1);
      expect(tooltip(), String(delay)).toBeNull();
      wait(1);
      expect(tooltip()?.textContent, String(delay)).toBe('Search');
    }
  });

  it('reads an unknown value as 1000 ms (AC9)', () => {
    settings['tooltip.delay'] = 400;
    renderLayer();
    hover(first);
    wait(999);
    expect(tooltip()).toBeNull();
    wait(1);
    expect(tooltip()).not.toBeNull();
  });

  it('shows no tooltip on hover with Never (AC5)', () => {
    settings['tooltip.delay'] = 'never';
    renderLayer();
    hover(first);
    wait(10_000);
    expect(tooltip()).toBeNull();
  });

  it('waits the full delay again on the next control, the shown one hidden (AC7)', () => {
    renderLayer();
    hover(first);
    wait(1000);
    expect(tooltip()?.textContent).toBe('Search');
    hover(second);
    expect(tooltip()).toBeNull();
    wait(999);
    expect(tooltip()).toBeNull();
    wait(1);
    expect(tooltip()?.textContent).toBe('New Note');
  });

  for (const delay of ['never', 2000]) {
    it(`shows a tooltip at once on keyboard focus with ${delay} (AC6)`, () => {
      settings['tooltip.delay'] = delay;
      renderLayer();
      // Focus from the keyboard (happy-dom has no :focus-visible of its own).
      vi.spyOn(first, 'matches').mockImplementation((selector) => selector === ':focus-visible');
      act(() => first.focus());
      expect(tooltip()?.textContent).toBe('Search');
    });
  }
});

describe('Settings → Display → Show Tooltips After (PEN-70)', () => {
  const select = () => document.querySelector<HTMLSelectElement>('[data-testid="tooltip-delay"]')!;

  it('offers the choices after the title bar’s buttons, 1 Second (Default) when unset (AC3)', () => {
    render(<DisplaySettings />);
    expect([...select().options].map((option) => option.textContent)).toEqual([
      '0.5 Seconds',
      '1 Second (Default)',
      '1.5 Seconds',
      '2 Seconds',
      'Never',
    ]);
    expect(select().selectedOptions[0]!.textContent).toBe('1 Second (Default)');
    expect(select().className).toContain('pm-select');
    expect(select().labels[0]!.textContent).toContain('Show Tooltips After');
    // Right after "Buttons in the note's title bar".
    const noteBar = document.querySelector('[data-testid="note-bar-settings"]')!;
    const field = select().closest('.settings-field')!;
    expect(noteBar.nextElementSibling!.nextElementSibling).toBe(field);
  });

  it('shows 1 Second (Default) for a value it does not know (AC9)', () => {
    settings['tooltip.delay'] = 'soon';
    render(<DisplaySettings />);
    expect(select().value).toBe('1000');
  });

  it('writes tooltip.delay when a choice is picked (AC4)', () => {
    render(<DisplaySettings />);
    const pick = (value: string) =>
      act(() => {
        select().value = value;
        select().dispatchEvent(new Event('change', { bubbles: true }));
      });
    pick('2000');
    pick('never');
    expect(writes).toEqual([
      ['tooltip.delay', 2000],
      ['tooltip.delay', 'never'],
    ]);
    expect(select().value).toBe('never');
  });

  it('is disabled until this device’s settings are read (AC8)', () => {
    state = { loaded: false };
    render(<DisplaySettings />);
    expect(select().disabled).toBe(true);
    act(() => {
      state = { loaded: true };
      notify();
    });
    expect(select().disabled).toBe(false);
  });
});
