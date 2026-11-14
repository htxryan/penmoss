// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { CommandsContext } from '../../src/commands/hooks';
import type {
  DesktopMenu,
  MacWindow,
  MacWindowState,
  MenuCommandEvent,
  PenmossDesktop,
} from '../../src/desktop/bridge';
import { DesktopIntegration } from '../../src/desktop/DesktopIntegration';
import { KeepOnTopButton } from '../../src/desktop/KeepOnTopButton';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macWindowStore, startTitleBar } from '../../src/desktop/mac-window';
import { menuOf } from '../../src/desktop/menu';
import {
  NO_DRAG_CONTROLS,
  NO_DRAG_SURFACES,
  TITLE_BAR_ROWS,
  UNDER_ROWS,
} from '../../src/desktop/no-drag';

// T46 (D38, A720) and T47 (D39, A722, A723) in the page: keep on top's menu tick, pin button
// and command kept in step by the main process's state event, and the compact title bar's
// layout switch and the lists of what drags. The Electron suite checks them in the app.

let sent: Array<readonly DesktopMenu[]>;
let root: Root;
let host: HTMLElement;
let center: CommandCenter;
let menuCommand: ((event: MenuCommandEvent) => void) | null;

/** The main process as the page sees it: pinning answers with, and sends, the new state. */
function fakeMac(titleBar: MacWindow['titleBar'] = 'compact') {
  let state: MacWindowState = { keepOnTop: false, fullScreen: false };
  const listeners = new Set<(state: MacWindowState) => void>();
  const emit = (next: Partial<MacWindowState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener(state);
  };
  const mac = {
    titleBar,
    state: vi.fn(() => Promise.resolve(state)),
    onState: (listener: (state: MacWindowState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setKeepOnTop: vi.fn((keepOnTop: boolean) => {
      emit({ keepOnTop });
      return Promise.resolve(state);
    }),
    setCompactTitleBar: vi.fn(() => Promise.resolve({ compact: true, reopened: false })),
  } satisfies MacWindow;
  return { mac, emit };
}

function install(mac: MacWindow | undefined) {
  const bridge = {
    platform: 'darwin',
    version: '0.0.0',
    window: 'note',
    menu: {
      set: (menus: readonly DesktopMenu[]) => sent.push(menus),
      onCommand: (listener: (event: MenuCommandEvent) => void) => {
        menuCommand = listener;
        return () => {
          menuCommand = null;
        };
      },
    },
    onOpenPath: () => () => undefined,
    clipboard: { write: () => Promise.resolve(true) },
    ...(mac ? { macWindow: mac } : {}),
  } as unknown as PenmossDesktop;
  Object.assign(window, { penmossDesktop: bridge });
  return bridge;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent = [];
  menuCommand = null;
  center = new CommandCenter(COMMANDS, memoryBindings());
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'penmossDesktop');
  delete document.documentElement.dataset['titlebar'];
  document.body.replaceChildren();
});

async function show(): Promise<void> {
  act(() => {
    root.render(
      <CommandsContext.Provider value={center}>
        <DesktopIntegration />
        <KeepOnTopButton />
      </CommandsContext.Provider>,
    );
  });
  await settle();
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const menuItem = (id: string) =>
  sent
    .at(-1)
    ?.flatMap((menu) => menu.groups.flat())
    .find((entry) => entry.id === id);

const pin = () => host.querySelector<HTMLButtonElement>('[data-testid="keep-on-top"]');

describe('keep on top in the page (T46, A720)', () => {
  it('is in the View menu, ticked for this window, as the pin button shows it', async () => {
    const { mac } = fakeMac();
    install(mac);
    await show();
    expect(menuOf(COMMANDS.find((command) => command.id === 'window.keepOnTop')!)).toBe('View');
    expect(menuItem('window.keepOnTop')).toMatchObject({ title: 'Keep on Top', checked: false });
    expect(pin()?.getAttribute('aria-pressed')).toBe('false');
    expect(pin()?.dataset['command']).toBe('window.keepOnTop');
  });

  it('keeps the tick, the button and the command in step, whichever is used', async () => {
    const { mac } = fakeMac();
    install(mac);
    await show();
    // The pin button.
    act(() => pin()!.click());
    await settle();
    expect(mac.setKeepOnTop).toHaveBeenLastCalledWith(true);
    expect(pin()?.getAttribute('aria-pressed')).toBe('true');
    expect(menuItem('window.keepOnTop')?.checked).toBe(true);
    // View → Keep on top.
    act(() => menuCommand!({ id: 'window.keepOnTop', accelerator: null }));
    await settle();
    expect(mac.setKeepOnTop).toHaveBeenLastCalledWith(false);
    expect(pin()?.getAttribute('aria-pressed')).toBe('false');
    expect(menuItem('window.keepOnTop')?.checked).toBe(false);
    // The command (the palette, a key someone bound).
    act(() => void center.run('window.keepOnTop', { source: 'palette' }));
    await settle();
    expect(mac.setKeepOnTop).toHaveBeenLastCalledWith(true);
    expect(menuItem('window.keepOnTop')?.checked).toBe(true);
  });

  it('follows the window when something else pins or unpins it', async () => {
    const { mac, emit } = fakeMac();
    install(mac);
    await show();
    act(() => emit({ keepOnTop: true }));
    await settle();
    expect(pin()?.getAttribute('aria-pressed')).toBe('true');
    expect(menuItem('window.keepOnTop')?.checked).toBe(true);
  });

  it('is not offered where the window cannot do it: a browser, or a Mac app before T46', async () => {
    install(undefined);
    await show();
    expect(pin()).toBeNull();
    expect(center.available('window.keepOnTop')).toBe(false);
    // Left out of the menus, not greyed out.
    expect(sent.length).toBeGreaterThan(0);
    expect(menuItem('window.keepOnTop')).toBeUndefined();
  });
});

describe('the compact title bar in the page (T47, A722, A723)', () => {
  it('leaves room for the lights in a compact window, and none in full screen', () => {
    const { mac, emit } = fakeMac('compact');
    const store = macWindowStore(install(mac))!;
    const stop = startTitleBar(document.documentElement, store);
    expect(document.documentElement.dataset['titlebar']).toBe('compact');
    act(() => emit({ fullScreen: true }));
    expect(document.documentElement.dataset['titlebar']).toBeUndefined();
    act(() => emit({ fullScreen: false }));
    expect(document.documentElement.dataset['titlebar']).toBe('compact');
    stop();
    expect(document.documentElement.dataset['titlebar']).toBeUndefined();
  });

  it('changes nothing with the native title bar, in a browser or the capture window', () => {
    const { mac } = fakeMac('native');
    startTitleBar(document.documentElement, macWindowStore(install(mac)));
    expect(document.documentElement.dataset['titlebar']).toBeUndefined();
    startTitleBar(document.documentElement, null);
    expect(document.documentElement.dataset['titlebar']).toBeUndefined();
  });

  /** The selectors of the compact rule in styles.css that sets `value`. */
  function cssList(value: 'drag' | 'no-drag'): string[][] {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/styles.css'),
      'utf8',
    );
    const rules = [
      ...css.matchAll(
        /:root\[data-titlebar='compact'\]\s*:is\(([^{]*)\)\s*\{\s*-webkit-app-region: ([a-z-]+);/g,
      ),
    ];
    return rules
      .filter((rule) => rule[2] === value)
      .map((rule) =>
        rule[1]!
          .split(/,\s*(?![^()]*\))/)
          .map((selector) => selector.trim().replaceAll("'", '"'))
          .filter(Boolean),
      );
  }

  it('makes exactly the rows drag, and every control and floating surface not (A723)', () => {
    expect(cssList('drag')).toEqual([[...TITLE_BAR_ROWS]]);
    expect(cssList('no-drag')).toEqual([[...NO_DRAG_SURFACES], [...NO_DRAG_CONTROLS]]);
    // The roles a control can take are covered.
    for (const role of ['switch', 'tab', 'checkbox', 'combobox', 'slider']) {
      expect(NO_DRAG_CONTROLS).toContain(`[role="${role}"]`);
    }
    // A focusable element is a control; one only focusable from script (tabindex -1, a pane) is not.
    expect(NO_DRAG_CONTROLS).toContain('[tabindex]:not([tabindex="-1"])');
  });

  it('gives what scrolls under a row no region, but its floating surfaces (A1123)', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/styles.css'),
      'utf8',
    );
    const rule =
      /:root\[data-titlebar='compact'\]\s*:is\(([^)]*)\)\s*:is\(([^{]*?)\):not\(([^{]*)\)\s*\{\s*-webkit-app-region: unset;/.exec(
        css,
      );
    expect(rule).not.toBeNull();
    const list = (text: string) =>
      text
        .split(/,\s*(?![^()]*\))/)
        .map((selector) => selector.trim().replaceAll("'", '"'))
        .filter(Boolean);
    expect(list(rule![1]!)).toEqual([...UNDER_ROWS]);
    expect(list(rule![2]!)).toEqual([...NO_DRAG_CONTROLS]);
    expect(list(rule![3]!)).toEqual([...NO_DRAG_SURFACES]);
    // The editor's floating toolbars and menus are surfaces.
    expect(NO_DRAG_SURFACES).toContain('[role="toolbar"]');
    expect(NO_DRAG_SURFACES).toContain('.pm-slash-menu');
  });
});
