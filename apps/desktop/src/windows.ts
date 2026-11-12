/**
 * The Mac app's windows (T45, A712; amends A224): one main window and any number of note
 * windows, each a page of the bundled app. This registry is the only way the main process
 * finds a window: which one an IPC message came from, which one is in front for the menu bar
 * and menu commands, and each window's own menus.
 *
 * - **Main window:** the sidebar and every page; its size and place are kept between
 *   launches (window-state.ts). Closing it leaves the note windows open; the Dock icon,
 *   Window → Penmoss or any page a note window cannot show makes it again.
 * - **Minimized windows:** with no window visible, the Dock icon restores the one minimized
 *   last (PEN-67), even when the main window is closed; the others stay minimized.
 * - **Note windows:** `/window/notes/<id>`, one note with no sidebar. They open 720×800,
 *   cascading from the window in front, are never saved in `window-state.json`, and are not
 *   restored after a relaunch.
 *
 * The capture window is not in it: it never gets menus, menu commands or the main and note
 * windows' IPC (A503).
 */
import { isUlid } from '@penmoss/core/ids';
import type { MenuModel } from './menu';
import { appPath } from './security';
import type { Rect } from './window-state';

export type WindowKind = 'main' | 'note';

/** A note window's size, and how far each one steps from the window in front (A712). */
export const NOTE_WINDOW = { width: 720, height: 800, step: 24 } as const;

const NOTE_WINDOW_PATH = /^\/window\/notes\/([^/?#]+)\/?(\?.*)?$/;

/**
 * The in-app path of a note window (`/window/notes/<ULID>`, with its query) an app URL asks
 * for, or null for any other URL.
 */
export function noteWindowPath(url: string): string | null {
  const path = appPath(url);
  if (!path) return null;
  const match = NOTE_WINDOW_PATH.exec(path);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return isUlid(id) ? path : null;
}

/**
 * Where a new note window opens: a step right of and below the window in front, on that
 * window's display; back at the display's corner when the step would leave it.
 */
export function cascadeBounds(from: Rect | null, area: Rect): Rect {
  const width = Math.min(NOTE_WINDOW.width, area.width);
  const height = Math.min(NOTE_WINDOW.height, area.height);
  const corner = { x: area.x + NOTE_WINDOW.step, y: area.y + NOTE_WINDOW.step };
  if (!from) {
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    };
  }
  let x = from.x + NOTE_WINDOW.step;
  let y = from.y + NOTE_WINDOW.step;
  if (x + width > area.x + area.width || x < area.x) {
    x = Math.min(corner.x, area.x + area.width - width);
  }
  if (y + height > area.y + area.height || y < area.y) {
    y = Math.min(corner.y, area.y + area.height - height);
  }
  return { x, y, width, height };
}

interface Entry {
  readonly kind: WindowKind;
  /** The menus this window's page sent last (A222), shown while it is in front. */
  menus: readonly MenuModel[] | null;
}

/**
 * The main and note windows, by their web contents. `W` is a BrowserWindow in the app and a
 * plain object in tests.
 */
export class WindowRegistry<
  W extends { readonly webContents: object; isDestroyed?(): boolean; isMinimized?(): boolean },
> {
  private readonly entries = new Map<W, Entry>();
  /** Windows in the order they last came to the front, most recent last. */
  private order: W[] = [];
  /** Minimized windows in the order they were minimized, most recent last (PEN-67). */
  private minimizedOrder: W[] = [];

  add(window: W, kind: WindowKind): void {
    if (kind === 'main' && this.main && this.main !== window) {
      throw new Error('There is one main window');
    }
    this.entries.set(window, { kind, menus: null });
    this.order.push(window);
  }

  remove(window: W): void {
    this.entries.delete(window);
    this.order = this.order.filter((other) => other !== window);
    this.minimizedOrder = this.minimizedOrder.filter((other) => other !== window);
  }

  /** The window whose page sent an IPC message, or null (the capture window, anything else). */
  windowOf(contents: unknown): W | null {
    for (const window of this.entries.keys()) {
      if (window.isDestroyed?.() !== true && window.webContents === contents) return window;
    }
    return null;
  }

  kindOf(contents: unknown): WindowKind | null {
    const window = this.windowOf(contents);
    return window ? this.entries.get(window)!.kind : null;
  }

  /** The main window; one destroyed but not yet removed (its `closed` still to come) is not. */
  get main(): W | null {
    for (const [window, entry] of this.entries) {
      if (entry.kind === 'main' && window.isDestroyed?.() !== true) return window;
    }
    return null;
  }

  notes(): W[] {
    return [...this.entries].filter(([, entry]) => entry.kind === 'note').map(([w]) => w);
  }

  /** Every main and note window. */
  all(): W[] {
    return [...this.entries.keys()];
  }

  /** `window` came to the front (its `focus` event). */
  focused(window: W): void {
    if (!this.entries.has(window)) return;
    this.order = [...this.order.filter((other) => other !== window), window];
  }

  /** `window` was minimized (its `minimize` event). */
  minimized(window: W): void {
    if (!this.entries.has(window)) return;
    this.minimizedOrder = [...this.minimizedOrder.filter((other) => other !== window), window];
  }

  /** `window` is no longer minimized (its `restore` event). */
  restored(window: W): void {
    this.minimizedOrder = this.minimizedOrder.filter((other) => other !== window);
  }

  /**
   * The window minimized last that is still minimized and not destroyed, or null (PEN-67):
   * the one the Dock icon brings back when no window is visible.
   */
  lastMinimized(): W | null {
    for (let i = this.minimizedOrder.length - 1; i >= 0; i--) {
      const window = this.minimizedOrder[i]!;
      if (window.isDestroyed?.() === true) continue;
      if (window.isMinimized?.() === false) continue;
      return window;
    }
    return null;
  }

  /**
   * The window menu commands go to (A712): the one last in front, else the main window, else
   * the newest note window; null when there is none (the main window is then made again).
   */
  get active(): W | null {
    return this.order.at(-1) ?? this.main ?? this.notes().at(-1) ?? null;
  }

  /**
   * Keeps `menus` as `window`'s. True when the menu bar should show them now: the window is
   * the active one.
   */
  setMenus(window: W, menus: readonly MenuModel[]): boolean {
    const entry = this.entries.get(window);
    if (!entry) return false;
    entry.menus = menus;
    return this.active === window;
  }

  /** The menus `window`'s page sent last (null before it sent any). */
  menusOf(window: W): readonly MenuModel[] | null {
    return this.entries.get(window)?.menus ?? null;
  }
}

/** At most this many record ids in one `stored` message (as the page sends, A711). */
export const MAX_STORED_IDS = 100;

/**
 * The records a page says it stored (T45, A711), checked: they come over IPC. Undefined when
 * the message names none or is off, and the other windows then read everything.
 */
export function parseStoredIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STORED_IDS) {
    return undefined;
  }
  const ok = value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64);
  return ok ? (value as string[]) : undefined;
}

/** At most this many note windows open at once, and this many opened a second (A712). */
export const MAX_NOTE_WINDOWS = 20;
export const NOTE_WINDOWS_PER_SECOND = 4;

/**
 * Whether a page may open another note window now: a runaway script calling `window.open`
 * in a loop gets a few, never hundreds. A person opening windows one by one never meets it.
 */
export class NoteWindowGate {
  private recent: number[] = [];

  allows(open: number, now: number): boolean {
    if (open >= MAX_NOTE_WINDOWS) return false;
    this.recent = this.recent.filter((at) => now - at < 1000);
    if (this.recent.length >= NOTE_WINDOWS_PER_SECOND) return false;
    this.recent.push(now);
    return true;
  }
}
