import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventProblem, type Props, type SizeClass } from '@penmoss/core/analytics';
import {
  WINDOW_SETTLE_MS,
  watchWindowEvents,
  windowProps,
  type WatchedWindow,
  type WindowEventName,
} from '../../src/window-events';

// PEN-174: `app window` from the Mac's main process.

/** A BrowserWindow as the watcher sees one: its size, zoom and state are set by the test. */
function fakeWindow(start: { width: number; height: number; zoom?: number }) {
  const listeners = new Map<string, Array<() => void>>();
  const state = {
    width: start.width,
    height: start.height,
    zoom: start.zoom ?? 1,
    fullScreen: false,
    maximised: false,
    destroyed: false,
  };
  const on = (event: string, listener: () => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  const window: WatchedWindow & { readonly state: typeof state; emit(event: string): void } = {
    state,
    getContentSize: () => [state.width, state.height],
    isFullScreen: () => state.fullScreen,
    isMaximized: () => state.maximised,
    isDestroyed: () => state.destroyed,
    on: (event: WindowEventName, listener: () => void) => on(event, listener),
    webContents: {
      getZoomFactor: () => state.zoom,
      isDestroyed: () => state.destroyed,
      on: (event: 'zoom-changed', listener: () => void) => on(event, listener),
    },
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
  return { window, listeners };
}

function watch(start: { width: number; height: number; zoom?: number }, active = () => true) {
  const { window, listeners } = fakeWindow(start);
  const recorded: Array<{ props: Props; sizeClass: SizeClass }> = [];
  watchWindowEvents(window, 'main', (props, sizeClass) => recorded.push({ props, sizeClass }), {
    active,
  });
  return { window, listeners, recorded };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('app window on the Mac (PEN-174)', () => {
  it('records the window as it is shown: its size in CSS px rounded to 10, full screen and maximised', () => {
    const { window, recorded } = watch({ width: 1443, height: 897 });
    expect(recorded).toEqual([]);
    window.emit('show');
    expect(recorded).toEqual([
      {
        props: { window: 'main', width: 1440, height: 900, fullScreen: false, maximised: false },
        sizeClass: 'expanded',
      },
    ]);
  });

  it('records what core’s check accepts', () => {
    const { window, recorded } = watch({ width: 1443, height: 897 });
    window.emit('show');
    const event = {
      session: '0123456789abcdef',
      seq: 0,
      at: 1,
      client: 'mac',
      actor: 'person',
      version: '1.4.0',
      channel: 'stable',
      os: 'macos',
      osVersion: '26.1',
      sizeClass: recorded[0]!.sizeClass,
      kind: 'app',
      name: 'window',
      props: recorded[0]!.props,
    };
    expect(eventProblem(event)).toBeNull();
  });

  it('records one event 500 ms after the last of several resizes', () => {
    const { window, recorded } = watch({ width: 1280, height: 720 });
    window.emit('show');
    for (const width of [1300, 1320, 1350, 1380, 1400, 1412]) {
      window.state.width = width;
      window.emit('resize');
      vi.advanceTimersByTime(100);
    }
    expect(recorded).toHaveLength(1);
    vi.advanceTimersByTime(WINDOW_SETTLE_MS - 101);
    expect(recorded).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.props).toMatchObject({ width: 1410, height: 720 });
  });

  it('never listens to moves, and drops a settle that matches the last record', () => {
    const { window, listeners, recorded } = watch({ width: 1280, height: 720 });
    expect(listeners.has('move')).toBe(false);
    expect(listeners.has('moved')).toBe(false);
    window.emit('show');
    window.emit('move');
    // A resize back to the same size (or one within the same 10 px) is not a change.
    window.state.width = 1282;
    window.emit('resize');
    vi.advanceTimersByTime(WINDOW_SETTLE_MS);
    expect(recorded).toHaveLength(1);
  });

  it('records full screen on and off at once, dropping a settle that was waiting', () => {
    const { window, recorded } = watch({ width: 1280, height: 720 });
    window.emit('show');
    window.state.width = 1512;
    window.state.height = 982;
    window.emit('resize');
    window.state.fullScreen = true;
    window.emit('enter-full-screen');
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.props).toMatchObject({ width: 1510, height: 980, fullScreen: true });
    vi.advanceTimersByTime(WINDOW_SETTLE_MS * 2);
    expect(recorded).toHaveLength(2);
    window.state.fullScreen = false;
    window.state.width = 1280;
    window.state.height = 720;
    window.emit('leave-full-screen');
    expect(recorded).toHaveLength(3);
    expect(recorded[2]!.props).toMatchObject({ width: 1280, height: 720, fullScreen: false });
  });

  it('records maximise and unmaximise once they settle', () => {
    const { window, recorded } = watch({ width: 1280, height: 720 });
    window.emit('show');
    window.state.maximised = true;
    window.state.width = 1512;
    window.state.height = 945;
    window.emit('maximize');
    window.emit('resize');
    vi.advanceTimersByTime(WINDOW_SETTLE_MS);
    expect(recorded.at(-1)!.props).toMatchObject({ maximised: true, width: 1510, height: 950 });
    window.state.maximised = false;
    window.emit('unmaximize');
    vi.advanceTimersByTime(WINDOW_SETTLE_MS);
    expect(recorded.at(-1)!.props).toMatchObject({ maximised: false });
    expect(recorded).toHaveLength(3);
  });

  it('divides by the page zoom, so the size is the page’s CSS pixels', () => {
    const { window, recorded } = watch({ width: 1440, height: 900, zoom: 1.25 });
    window.emit('show');
    expect(recorded[0]!.props).toMatchObject({ width: 1150, height: 720 });
    window.state.zoom = 1;
    window.emit('zoom-changed');
    vi.advanceTimersByTime(WINDOW_SETTLE_MS);
    expect(recorded[1]!.props).toMatchObject({ width: 1440, height: 900 });
    expect(recorded[1]!.sizeClass).toBe('expanded');
  });

  it('records nothing before the first show, after it closes, or while it closes', () => {
    let open = true;
    const { window, recorded } = watch({ width: 500, height: 700 }, () => open);
    window.emit('resize');
    window.emit('enter-full-screen');
    vi.advanceTimersByTime(WINDOW_SETTLE_MS);
    expect(recorded).toEqual([]);
    window.emit('show');
    expect(recorded[0]!.sizeClass).toBe('compact');
    window.state.width = 900;
    window.emit('resize');
    window.emit('closed');
    vi.advanceTimersByTime(WINDOW_SETTLE_MS);
    expect(recorded).toHaveLength(1);
    // Closing (A1577): leaving full screen to hide is not a change the person made.
    open = false;
    window.state.fullScreen = true;
    window.emit('leave-full-screen');
    expect(recorded).toHaveLength(1);
  });

  it('names the window it watches', () => {
    const { window } = fakeWindow({ width: 560, height: 300 });
    expect(windowProps(window, 'capture')).toEqual({
      window: 'capture',
      width: 560,
      height: 300,
      fullScreen: false,
      maximised: false,
    });
  });
});
