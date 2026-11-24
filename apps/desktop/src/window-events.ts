/**
 * `app window` from the Mac's main process (PEN-174): which window, its size in CSS pixels
 * rounded to 10, and whether it is in full screen or maximised. Recorded when the window is
 * shown, 500 ms after the last resize, maximise, unmaximise or page zoom, and at once as it
 * enters or leaves full screen (which also drops a settle still waiting). A record that matches
 * the window's last one is dropped. Moving a window records nothing: `move` is never listened to.
 *
 * Only Electron's window methods are used, through `WatchedWindow`, so a test passes a fake.
 */
import {
  lengthOf,
  sizeClassOf,
  type Props,
  type SizeClass,
  type WindowName,
} from '@penmoss/core/analytics';

/** How long a window's size must hold before it is recorded. */
export const WINDOW_SETTLE_MS = 500;

/** The BrowserWindow methods and events this reads. */
export interface WatchedWindow {
  getContentSize(): number[];
  isFullScreen(): boolean;
  isMaximized(): boolean;
  isDestroyed(): boolean;
  on(event: WindowEventName, listener: () => void): unknown;
  readonly webContents: {
    getZoomFactor(): number;
    isDestroyed(): boolean;
    on(event: 'zoom-changed', listener: () => void): unknown;
  };
}

export type WindowEventName =
  | 'show'
  | 'resize'
  | 'maximize'
  | 'unmaximize'
  | 'enter-full-screen'
  | 'leave-full-screen'
  | 'closed';

/** Records one `app window`: its props, and the size class its width falls in. */
type RecordWindow = (props: Props, sizeClass: SizeClass) => void;

export interface Timers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * The window's props now: its content area divided by the page's zoom (CSS pixels, as the page
 * measures them), rounded to 10. Nothing about its place, its screen or the screen's scale.
 */
export function windowProps(window: WatchedWindow, name: WindowName): Props & { width: number } {
  const [contentWidth = 0, contentHeight = 0] = window.getContentSize();
  const zoom = window.webContents.isDestroyed() ? 1 : window.webContents.getZoomFactor();
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    window: name,
    width: lengthOf(contentWidth / scale),
    height: lengthOf(contentHeight / scale),
    fullScreen: window.isFullScreen(),
    maximised: window.isMaximized(),
  };
}

/** Starts recording `window`'s size and state as `name` (main, note or capture). */
export function watchWindowEvents(
  window: WatchedWindow,
  name: WindowName,
  record: RecordWindow,
  options: {
    readonly timers?: Timers;
    /** False once the window is closing (A1577): leaving full screen to hide is not recorded. */
    readonly active?: () => boolean;
  } = {},
): void {
  const timers = options.timers ?? realTimers;
  const active = options.active ?? (() => true);
  let last: string | null = null;
  let pending: unknown = null;
  let shown = false;
  const cancel = () => {
    if (pending !== null) timers.clearTimeout(pending);
    pending = null;
  };
  const now = () => {
    cancel();
    if (window.isDestroyed() || !active()) return;
    const props = windowProps(window, name);
    const key = JSON.stringify(props);
    if (key === last) return;
    last = key;
    record(props, sizeClassOf(props.width));
  };
  const settle = () => {
    // Before its first show, the window's first record is that show's.
    if (!shown) return;
    cancel();
    pending = timers.setTimeout(() => {
      pending = null;
      now();
    }, WINDOW_SETTLE_MS);
  };
  window.on('show', () => {
    shown = true;
    now();
  });
  window.on('resize', settle);
  window.on('maximize', settle);
  window.on('unmaximize', settle);
  window.webContents.on('zoom-changed', settle);
  window.on('enter-full-screen', () => {
    if (shown) now();
  });
  window.on('leave-full-screen', () => {
    if (shown) now();
  });
  window.on('closed', cancel);
}
