/**
 * The Mac app's window behaviours (T46, T47): keep on top and the compact title bar. The main
 * process applies them (main.ts); this module holds what can be decided and checked without a
 * window.
 *
 * - **Keep on top (T46, D38, A720, A721):** a pinned main or note window floats above other
 *   apps' windows and follows across Spaces, but never over a full-screen app. Only the main
 *   window remembers it (`window-state.json`); note windows start unpinned.
 * - **Compact title bar (T47, D39, A722–A724):** `hiddenInset`, the traffic lights centred on
 *   the app's own first row, which drags like a title bar (double-clicking it is Chromium's own, A723).
 *   A per-Mac setting (preferences.json), on by default.
 *
 * Both are the Mac app's only. Off a Mac the windows keep the native frame and the page shows
 * neither, except for the Playwright suite under xvfb (`PENMOSS_TEST_MAC_WINDOW=1`, unpackaged
 * builds only, A725): the page then lays out and behaves as on a Mac, while the window keeps
 * Linux's frame, so the tests check the logic and the geometry.
 */

/** How a window's top looks: the app's own row with the lights in it, or macOS's title bar. */
export type TitleBarStyle = 'compact' | 'native';

/**
 * The first row the lights sit in: the sidebar header, the note's top bar, a note window's top
 * bar (48 px, `--pm-titlebar-row` in the web app's styles).
 */
export const TITLE_BAR_ROW = 48;

/**
 * Where macOS draws the three buttons in a compact window, in the window's own points:
 * `trafficLightPosition` is the first button's top-left corner; each button is 14 px wide, in a
 * 16 px tall row, 23 px from the last on macOS 26 (20 px before it), so the three span 60 px
 * (measured on macOS 26's own window captures, T52). Centred on the 48 px row.
 */
export const TRAFFIC_LIGHTS = { x: 16, y: 16, width: 60, height: 16 } as const;

/**
 * How much of the first row the page leaves to the lights (`--pm-titlebar-inset`): the lights
 * and 12 px after them, a little more than the 9 px between them, so whatever follows in the row
 * (Back and Forward, the note's crumbs) does not crowd the green button (T52).
 */
export const TITLE_BAR_INSET = 88;

/** Whether this app has the Mac's window behaviours: on a Mac, or the suite standing in for one. */
export function macWindowsOn(platform: NodeJS.Platform, testOverride: boolean): boolean {
  return platform === 'darwin' || testOverride;
}

/**
 * The style new windows open with: compact unless the Mac's setting turned it off (A724);
 * null when the app has no Mac window behaviours (the page then shows none).
 */
export function titleBarStyle(
  macWindows: boolean,
  compactSetting: boolean | undefined,
): TitleBarStyle | null {
  if (!macWindows) return null;
  return compactSetting === false ? 'native' : 'compact';
}

/**
 * The BrowserWindow options for `style` (A722). Only a Mac gets `hiddenInset`: elsewhere the
 * window keeps its native frame whatever the page lays out.
 */
export function titleBarOptions(
  style: TitleBarStyle | null,
  platform: NodeJS.Platform,
): {
  titleBarStyle?: 'hiddenInset';
  trafficLightPosition?: { x: number; y: number };
} {
  if (style !== 'compact' || platform !== 'darwin') return {};
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: TRAFFIC_LIGHTS.x, y: TRAFFIC_LIGHTS.y },
  };
}

/** The parts of a BrowserWindow that keep on top touches (a plain object in tests). */
export interface PinnableWindow {
  setAlwaysOnTop(flag: boolean, level?: 'floating'): void;
  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
  ): void;
}

/**
 * Pins or unpins a window (A720): above other apps' windows at the `floating` level, on every
 * Space. `skipTransformProcessType` stops Electron hiding the window and the Dock icon on each
 * call, and leaving out `visibleOnFullScreen` keeps it off full-screen apps.
 */
export function setKeepOnTop(window: PinnableWindow, on: boolean): void {
  if (on) window.setAlwaysOnTop(true, 'floating');
  else window.setAlwaysOnTop(false);
  window.setVisibleOnAllWorkspaces(on, { skipTransformProcessType: true });
}

/**
 * The capture window is a panel on a Mac (T30, A915): only a panel, or a window of an app with
 * no Dock icon, can show over a full-screen app. A plain window there takes you back to the
 * desktop's Space instead.
 */
export function captureWindowOptions(platform: NodeJS.Platform): { type?: 'panel' } {
  return platform === 'darwin' ? { type: 'panel' } : {};
}

/**
 * The capture window's place (T30, A915): on every Space and over a full-screen app, so the
 * hotkey finds it wherever you are. `skipTransformProcessType` keeps Penmoss a regular app:
 * without it, `visibleOnFullScreen` makes Electron hide the Dock icon, turning the whole app into
 * a UIElement for good, and on macOS 26 it then never becomes the active app, so its menu bar
 * draws but takes no clicks.
 */
export function showOnEverySpace(window: PinnableWindow): void {
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
}

/** What the page hears about its own window (the `windowState` event, A720, A722). */
export interface MacWindowState {
  readonly keepOnTop: boolean;
  readonly fullScreen: boolean;
}

/** The value a page sent for keep on top, checked (it comes over IPC). */
export function parseKeepOnTop(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** How storing a window's notes before it reopens went (A724). */
export type StoreResult = 'saved' | 'failed' | 'timeout' | 'gone';

/**
 * Whether the windows may reopen after their pages were asked to store everything (A724): only
 * when every page that could answer said it stored its notes. A page that failed or did not
 * answer in time keeps its window, so nothing typed there is lost; a crashed or closed one has
 * nothing left to store.
 */
export function mayReopen(results: readonly StoreResult[]): boolean {
  return results.every((result) => result === 'saved' || result === 'gone');
}
