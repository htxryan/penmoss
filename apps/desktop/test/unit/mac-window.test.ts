import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { desktopConfig } from '../../src/config';
import { loadPreferences, savePreferences } from '../../src/hotkey';
import {
  captureWindowOptions,
  macWindowsOn,
  mayReopen,
  parseKeepOnTop,
  setKeepOnTop,
  showOnEverySpace,
  TITLE_BAR_INSET,
  TITLE_BAR_ROW,
  titleBarOptions,
  titleBarStyle,
  TRAFFIC_LIGHTS,
  type PinnableWindow,
} from '../../src/mac-window';
import { menuTemplate, parseMenus, type MenuModel } from '../../src/menu';
import {
  loadWindowState,
  parseWindowState,
  saveWindowState,
  type WindowState,
} from '../../src/window-state';

// T46 (D38, A720, A721) and T47 (D39, A722–A725): the Mac's window behaviours that do not need
// a window. The Electron suite (test/e2e/mac-window.spec.ts) checks them in the app.

const dirs: string[] = [];
const dir = () => {
  const made = mkdtempSync(join(tmpdir(), 'penmoss-mac-window-'));
  dirs.push(made);
  return made;
};
afterAll(() => {
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});

/** A window that records what keep on top asked of it. */
function fakeWindow() {
  const calls: unknown[][] = [];
  let onTop = false;
  const window: PinnableWindow & { isAlwaysOnTop(): boolean } = {
    setAlwaysOnTop: (...args) => {
      calls.push(['setAlwaysOnTop', ...args]);
      onTop = args[0];
    },
    setVisibleOnAllWorkspaces: (...args) => calls.push(['setVisibleOnAllWorkspaces', ...args]),
    isAlwaysOnTop: () => onTop,
  };
  return { window, calls };
}

describe('keep on top (T46, A720)', () => {
  it('floats a pinned window above other apps, on every Space, but not over full screen', () => {
    const { window, calls } = fakeWindow();
    setKeepOnTop(window, true);
    expect(window.isAlwaysOnTop()).toBe(true);
    expect(calls).toEqual([
      ['setAlwaysOnTop', true, 'floating'],
      // Without skipTransformProcessType Electron hides the window and the Dock icon each time;
      // without visibleOnFullScreen it stays off full-screen apps.
      ['setVisibleOnAllWorkspaces', true, { skipTransformProcessType: true }],
    ]);
  });

  it('puts an unpinned window back in the normal order, on its own Space', () => {
    const { window, calls } = fakeWindow();
    setKeepOnTop(window, true);
    setKeepOnTop(window, false);
    expect(window.isAlwaysOnTop()).toBe(false);
    expect(calls.slice(2)).toEqual([
      ['setAlwaysOnTop', false],
      ['setVisibleOnAllWorkspaces', false, { skipTransformProcessType: true }],
    ]);
  });

  it('shows the capture window on every Space and over full screen, keeping the app regular (A915)', () => {
    const { window, calls } = fakeWindow();
    showOnEverySpace(window);
    expect(calls).toEqual([
      // Without skipTransformProcessType, visibleOnFullScreen turns the app into a UIElement:
      // no Dock icon, and a menu bar that takes no clicks.
      [
        'setVisibleOnAllWorkspaces',
        true,
        { visibleOnFullScreen: true, skipTransformProcessType: true },
      ],
    ]);
  });

  it('makes the capture window a panel on a Mac, which can show over full screen (A915)', () => {
    expect(captureWindowOptions('darwin')).toEqual({ type: 'panel' });
    expect(captureWindowOptions('linux')).toEqual({});
  });

  it('leaves every Space change to this module, which never transforms the app (A915)', () => {
    const src = fileURLToPath(new URL('../../src', import.meta.url));
    const callers = readdirSync(src)
      .filter((file) => file.endsWith('.ts') && file !== 'mac-window.ts')
      .filter((file) =>
        readFileSync(join(src, file), 'utf8').includes('setVisibleOnAllWorkspaces('),
      );
    expect(callers).toEqual([]);
    const own = readFileSync(join(src, 'mac-window.ts'), 'utf8');
    const calls = own.match(/window\.setVisibleOnAllWorkspaces\([^;]*\);/g) ?? [];
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toContain('skipTransformProcessType: true');
  });

  it('takes only a true or false from a page', () => {
    expect(parseKeepOnTop(true)).toBe(true);
    expect(parseKeepOnTop(false)).toBe(false);
    for (const value of ['true', 1, null, undefined, {}]) expect(parseKeepOnTop(value)).toBeNull();
  });

  it('keeps the main window’s pin in window-state.json (A721)', () => {
    const file = join(dir(), 'window-state.json');
    const state: WindowState = {
      x: 40,
      y: 30,
      width: 1100,
      height: 760,
      maximized: false,
      fullScreen: false,
      keepOnTop: true,
    };
    saveWindowState(file, state);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ keepOnTop: true });
    expect(loadWindowState(file)).toEqual(state);
    saveWindowState(file, { ...state, keepOnTop: false });
    expect(loadWindowState(file).keepOnTop).toBe(false);
  });

  it('reads an older window-state.json, or a malformed pin, as unpinned', () => {
    expect(parseWindowState({ width: 1000, height: 700 }).keepOnTop).toBe(false);
    expect(parseWindowState({ width: 1000, height: 700, keepOnTop: 'yes' }).keepOnTop).toBe(false);
  });
});

describe('the compact title bar (T47, A722, A724, A725)', () => {
  it('is the Mac’s, and the suite’s stand-in for one in an unpackaged build', () => {
    expect(macWindowsOn('darwin', false)).toBe(true);
    expect(macWindowsOn('linux', false)).toBe(false);
    expect(macWindowsOn('win32', false)).toBe(false);
    expect(macWindowsOn('linux', true)).toBe(true);
    const env = { PENMOSS_TEST_MAC_WINDOW: '1' };
    expect(desktopConfig({ env, packaged: false, appPath: '/src/desktop' }).testMacWindow).toBe(
      true,
    );
    // Nothing in a packaged app's environment turns it on.
    expect(desktopConfig({ env, packaged: true, appPath: '/A/app.asar' }).testMacWindow).toBe(
      false,
    );
    expect(desktopConfig({ env: {}, packaged: false, appPath: '/src/desktop' }).testMacWindow).toBe(
      false,
    );
  });

  it('is on by default, and off only when this Mac’s setting says so', () => {
    expect(titleBarStyle(true, undefined)).toBe('compact');
    expect(titleBarStyle(true, true)).toBe('compact');
    expect(titleBarStyle(true, false)).toBe('native');
    // Without the Mac's window behaviours the page shows neither.
    expect(titleBarStyle(false, undefined)).toBeNull();
    expect(titleBarStyle(false, false)).toBeNull();
  });

  it('insets the lights on a Mac only: elsewhere the window keeps its native frame', () => {
    expect(titleBarOptions('compact', 'darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
    });
    expect(titleBarOptions('native', 'darwin')).toEqual({});
    expect(titleBarOptions(null, 'darwin')).toEqual({});
    expect(titleBarOptions('compact', 'linux')).toEqual({});
    expect(titleBarOptions('compact', 'win32')).toEqual({});
  });

  it('centres the lights on the first row, inside the room the page leaves', () => {
    expect(TRAFFIC_LIGHTS.y * 2 + TRAFFIC_LIGHTS.height).toBe(TITLE_BAR_ROW);
    expect(TRAFFIC_LIGHTS.x + TRAFFIC_LIGHTS.width).toBeLessThan(TITLE_BAR_INSET);
    // macOS 26's lights span 60 px (T52); what follows them keeps more room than the 9 px
    // between them, so it does not crowd the green button.
    expect(TRAFFIC_LIGHTS.width).toBe(60);
    expect(TITLE_BAR_INSET - (TRAFFIC_LIGHTS.x + TRAFFIC_LIGHTS.width)).toBeGreaterThanOrEqual(12);
    // The page's CSS says the same (styles.css).
    const css = readFileSync(new URL('../../../web/src/styles.css', import.meta.url), 'utf8');
    expect(css).toContain(`--pm-titlebar-inset: ${TITLE_BAR_INSET}px;`);
    expect(css).toContain(`--pm-titlebar-row: ${TITLE_BAR_ROW}px;`);
  });

  it('keeps this Mac’s choice in preferences.json, beside the hotkey and the theme', () => {
    const file = join(dir(), 'preferences.json');
    savePreferences(file, { captureHotkey: 'Control+Alt+Command+N', compactTitleBar: false });
    expect(loadPreferences(file)).toEqual({
      captureHotkey: 'Control+Alt+Command+N',
      compactTitleBar: false,
    });
    savePreferences(file, { compactTitleBar: true });
    expect(loadPreferences(file).compactTitleBar).toBe(true);
    savePreferences(file, {});
    expect(loadPreferences(file).compactTitleBar).toBeUndefined();
  });
});

describe('reopening the windows for a new title bar (T47, A724)', () => {
  it('goes ahead only when every page stored its notes', () => {
    expect(mayReopen(['saved', 'saved'])).toBe(true);
    // A crashed or closed page has nothing left to store.
    expect(mayReopen(['saved', 'gone'])).toBe(true);
    expect(mayReopen([])).toBe(true);
  });

  it('stops when a page failed to store, or did not answer in time', () => {
    expect(mayReopen(['saved', 'failed'])).toBe(false);
    expect(mayReopen(['timeout', 'saved'])).toBe(false);
  });
});

describe('View → Keep on top in the menus (T46, A720)', () => {
  const menus: MenuModel[] = [
    {
      label: 'View',
      groups: [
        [
          { id: 'window.keepOnTop', title: 'Keep on top', keys: [], checked: true },
          { id: 'theme.toggleDark', title: 'Toggle dark mode', keys: [] },
        ],
      ],
    },
  ];
  const view = (model: MenuModel[]) =>
    menuTemplate(model, {
      platform: 'darwin',
      appName: 'Penmoss',
      devTools: false,
      onCommand: () => undefined,
    }).find((menu) => menu.label === 'View')!.submenu as Electron.MenuItemConstructorOptions[];

  it('is a checkbox ticked as the page says; other items stay plain', () => {
    const items = view(menus);
    expect(items[0]).toMatchObject({ id: 'window.keepOnTop', type: 'checkbox', checked: true });
    expect(items[1]!.type).toBeUndefined();
    const unticked = view([
      {
        label: 'View',
        groups: [[{ id: 'window.keepOnTop', title: 'Keep on top', keys: [], checked: false }]],
      },
    ]);
    expect(unticked[0]).toMatchObject({ type: 'checkbox', checked: false });
  });

  it('takes a tick from the page only as true or false', () => {
    expect(parseMenus(menus)).toEqual(menus);
    const bad = [
      { label: 'View', groups: [[{ id: 'window.keepOnTop', title: 'K', keys: [], checked: 1 }]] },
    ];
    expect(parseMenus(bad)).toBeNull();
  });
});
