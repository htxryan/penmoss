// @vitest-environment happy-dom
/**
 * T45 (D37, A710, A711): a note in a window of its own. The router's window route and its
 * in-window history, where links and other pages go from a note window, opening a window (and
 * a blocked one), and the windows' offline refresh over a BroadcastChannel or the Mac app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PenmossDesktop } from '../../src/desktop/bridge';
import {
  inWindowPath,
  isNoteWindowPath,
  linkHandler,
  navigate,
  noteOfPath,
  parseRoute,
  historyPlace,
  startHistory,
} from '../../src/router';
import {
  blockedWindow,
  listenForOpenInMain,
  NOTE_WINDOW_FEATURES,
  noteWindowPath,
  OPEN_IN_MAIN_MESSAGE,
  openInMain,
  openNoteWindow,
} from '../../src/window/open';
import {
  ANNOUNCE_DELAY_MS,
  MAX_ANNOUNCED_IDS,
  parseChanged,
  StorePuller,
  storeSync,
  type ChannelLike,
} from '../../src/window/store-sync';

const ID = '01JB7Q3V6M8K2T9RZ4XN5C1HPD';
const OTHER = '01JB7Q3V6M8K2T9RZ4XN5C1HPE';

const here = () => window.location.pathname + window.location.search;

/** A page load at `path`: no history state, as a fresh window has. */
function load(path: string): void {
  window.history.replaceState(null, '', path);
  window.sessionStorage.clear();
  startHistory();
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { penmossDesktop?: unknown }).penmossDesktop;
  blockedWindow.set(null);
});

describe('the note window route (T45, A710)', () => {
  it('parses /window/notes/:id, a ULID only', () => {
    expect(parseRoute(`/window/notes/${ID}`)).toEqual({ name: 'window', id: ID });
    expect(parseRoute(`/window/notes/${ID}/`)).toEqual({ name: 'window', id: ID });
    expect(parseRoute('/window/notes/nope')).toEqual({ name: 'not-found' });
    expect(parseRoute(`/window/notes/${ID}/extra`)).toEqual({ name: 'not-found' });
    expect(parseRoute('/window/notes/%E0')).toEqual({ name: 'not-found' });
    expect(isNoteWindowPath(`/window/notes/${ID}`)).toBe(true);
    expect(isNoteWindowPath(`/notes/${ID}`)).toBe(false);
    expect(noteWindowPath(ID, 'Beds & borders')).toBe(
      `/window/notes/${ID}?heading=Beds%20%26%20borders`,
    );
  });

  it('keeps notes in the window, with their query; anything else is not the window’s', () => {
    expect(inWindowPath(`/notes/${ID}`)).toBe(`/window/notes/${ID}`);
    expect(inWindowPath(`/notes/${ID}?heading=Beds`)).toBe(`/window/notes/${ID}?heading=Beds`);
    expect(inWindowPath(`/window/notes/${ID}`)).toBe(`/window/notes/${ID}`);
    for (const path of ['/', '/settings', '/trash', `/graph?note=${ID}`, '/notes/nope']) {
      expect(inWindowPath(path)).toBeNull();
    }
    expect(noteOfPath(`/notes/${ID}?heading=Beds`)).toEqual({ id: ID, heading: 'Beds' });
    expect(noteOfPath(`/window/notes/${ID}`)).toEqual({ id: ID, heading: null });
    expect(noteOfPath('/settings')).toBeNull();
  });
});

describe('navigating in a note window', () => {
  beforeEach(() => load(`/window/notes/${ID}`));

  it('opens a followed note in the window, with Back and Forward', () => {
    const place = () => ({ ...historyPlace() });
    expect(place()).toEqual({ back: false, forward: false });
    navigate(`/notes/${OTHER}`);
    expect(here()).toBe(`/window/notes/${OTHER}`);
    expect(place()).toEqual({ back: true, forward: false });
    navigate(`/notes/${ID}?heading=Beds`);
    expect(here()).toBe(`/window/notes/${ID}?heading=Beds`);
    // Back twice, as the browser would (popstate after each).
    goBack();
    expect(here()).toBe(`/window/notes/${OTHER}`);
    expect(place()).toEqual({ back: true, forward: true });
    goBack();
    expect(place()).toEqual({ back: false, forward: true });
    // A new entry drops the ones ahead of it.
    navigate(`/notes/${OTHER}`);
    expect(place()).toEqual({ back: true, forward: false });
  });

  it('starts a fresh popup with nothing ahead, whatever its opener’s history held', () => {
    navigate(`/notes/${OTHER}`);
    navigate(`/notes/${ID}`);
    // A popup gets a copy of its opener's sessionStorage: its own history starts empty.
    window.history.replaceState(null, '', `/window/notes/${ID}`);
    startHistory();
    expect({ ...historyPlace() }).toEqual({ back: false, forward: false });
    // A reload keeps the entry's place.
    navigate(`/notes/${OTHER}`);
    startHistory();
    expect({ ...historyPlace() }).toEqual({ back: true, forward: false });
  });

  it('sends any other page to the window that opened it', () => {
    const opener = {
      closed: false,
      location: window.location,
      postMessage: vi.fn(),
      focus: vi.fn(),
    };
    vi.spyOn(window, 'opener', 'get').mockReturnValue(opener);
    navigate('/settings');
    expect(here()).toBe(`/window/notes/${ID}`);
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: OPEN_IN_MAIN_MESSAGE, path: '/settings' },
      window.location.origin,
    );
    expect(opener.focus).toHaveBeenCalled();
  });

  it('opens other pages in a new tab once the opener has gone, and in the Mac app’s main window', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(window, 'opener', 'get').mockReturnValue(null);
    navigate('/trash');
    expect(open).toHaveBeenLastCalledWith('/trash', '_blank');
    // The Mac app's main process sends an app path from window.open to the main window (A712).
    (window as { penmossDesktop?: unknown }).penmossDesktop = { window: 'note' };
    openInMain('/settings/appearance');
    expect(open).toHaveBeenLastCalledWith('/settings/appearance', '_blank');
    expect(here()).toBe(`/window/notes/${ID}`);
  });
});

describe('opening a note window', () => {
  beforeEach(() => load('/'));

  it('opens a popup from the click, always a new one', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    openNoteWindow(ID);
    openNoteWindow(ID, 'Beds');
    expect(open.mock.calls).toEqual([
      [`/window/notes/${ID}`, '_blank', NOTE_WINDOW_FEATURES],
      [`/window/notes/${ID}?heading=Beds`, '_blank', NOTE_WINDOW_FEATURES],
    ]);
    expect(NOTE_WINDOW_FEATURES).toBe('popup,width=720,height=800');
    expect(blockedWindow.get()).toBeNull();
  });

  it('offers a new tab when the browser blocks the popup; the Mac app returns no window', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    openNoteWindow(ID);
    expect(blockedWindow.get()).toEqual({ path: `/window/notes/${ID}` });
    blockedWindow.set(null);
    (window as { penmossDesktop?: unknown }).penmossDesktop = { window: 'main' };
    openNoteWindow(ID);
    expect(blockedWindow.get()).toBeNull();
  });

  it('opens a note in a new window on ⌥-click, never the browser’s download', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const click = (init: Partial<MouseEvent>) => {
      const event = {
        button: 0,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        defaultPrevented: false,
        preventDefault: vi.fn(),
        ...init,
      };
      linkHandler(`/notes/${ID}?heading=Beds`)(event as never);
      return event;
    };
    const alt = click({ altKey: true });
    expect(alt.preventDefault).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      `/window/notes/${ID}?heading=Beds`,
      '_blank',
      NOTE_WINDOW_FEATURES,
    );
    expect(here()).toBe('/');
    // A plain click navigates here; ⌘-click is the browser's (a new tab).
    click({});
    expect(here()).toBe(`/notes/${ID}?heading=Beds`);
    const meta = click({ metaKey: true, altKey: true });
    expect(meta.preventDefault).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows what a note window asks, only from this origin and only an app path', () => {
    const opened: string[] = [];
    const off = listenForOpenInMain((path) => opened.push(path));
    const post = (data: unknown, origin = window.location.origin, source: unknown = {}) =>
      window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }));
    post({ type: OPEN_IN_MAIN_MESSAGE, path: '/settings' });
    post({ type: OPEN_IN_MAIN_MESSAGE, path: '/trash' }, 'https://elsewhere.example');
    post({ type: OPEN_IN_MAIN_MESSAGE, path: '//elsewhere.example/x' });
    post({ type: OPEN_IN_MAIN_MESSAGE, path: 'javascript:alert(1)' });
    post({ type: 'other', path: '/trash' });
    off();
    post({ type: OPEN_IN_MAIN_MESSAGE, path: '/graph' });
    expect(opened).toEqual(['/settings']);
  });
});

describe('windows refresh each other offline (T45, A711)', () => {
  /** Two windows' channels: what one posts, the other hears. */
  function channels(): [ChannelLike, ChannelLike] {
    const make = (): ChannelLike & {
      peer?: (ChannelLike & { hear(data: unknown): void }) | undefined;
    } => {
      const listeners = new Set<(event: MessageEvent) => void>();
      const channel = {
        peer: undefined as (ChannelLike & { hear(data: unknown): void }) | undefined,
        postMessage: (data: unknown) => channel.peer?.hear(structuredClone(data)),
        addEventListener: (_: 'message', listener: (event: MessageEvent) => void) =>
          listeners.add(listener),
        removeEventListener: (_: 'message', listener: (event: MessageEvent) => void) =>
          listeners.delete(listener),
        close: vi.fn(),
        hear: (data: unknown) => {
          for (const listener of listeners) listener(new MessageEvent('message', { data }));
        },
      };
      return channel;
    };
    const a = make();
    const b = make();
    a.peer = b as never;
    b.peer = a as never;
    return [a, b];
  }

  it('tells the other windows which records were stored, a burst as one message', () => {
    vi.useFakeTimers();
    try {
      const [a, b] = channels();
      const closeA = vi.spyOn(a, 'close');
      const one = storeSync({ bridge: null, channel: () => a });
      const two = storeSync({ bridge: null, channel: () => b });
      const heard: Array<readonly string[] | null> = [];
      two.onChanged((ids) => heard.push(ids));
      one.announce([ID]);
      one.announce(['workspace', ID]);
      expect(heard).toEqual([]);
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
      expect(heard).toEqual([[ID, 'workspace']]);
      // Too many to name: "read everything".
      one.announce(Array.from({ length: MAX_ANNOUNCED_IDS + 1 }, (_, i) => `n${i}`));
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
      expect(heard.at(-1)).toBeNull();
      // Closing (the Mac app's close, a page going): what is gathered goes now.
      one.announce([ID]);
      one.flush();
      expect(heard.at(-1)).toEqual([ID]);
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
      expect(heard).toHaveLength(3);
      one.close();
      expect(closeA).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores messages that are not a list of record ids', () => {
    expect(parseChanged({ ids: [ID] })).toEqual([ID]);
    expect(parseChanged({ ids: null })).toBeNull();
    expect(parseChanged({ ids: 'x' })).toBeUndefined();
    expect(parseChanged({ ids: [1] })).toBeUndefined();
    expect(parseChanged({ ids: ['x'.repeat(65)] })).toBeUndefined();
    expect(parseChanged('hello')).toBeUndefined();
  });

  it('goes through the Mac app’s main process when there is one', () => {
    vi.useFakeTimers();
    try {
      const stored = vi.fn();
      let listener: ((ids?: readonly string[]) => void) | null = null;
      const bridge = {
        stored,
        onStoreChanged: (next: (ids?: readonly string[]) => void) => {
          listener = next;
          return () => undefined;
        },
      } as unknown as PenmossDesktop;
      const channel = vi.fn();
      const sync = storeSync({ bridge, channel });
      const heard: Array<readonly string[] | null> = [];
      sync.onChanged((ids) => heard.push(ids));
      sync.announce([ID]);
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
      expect(stored).toHaveBeenCalledWith([ID]);
      expect(channel).not.toHaveBeenCalled();
      listener!([OTHER]);
      // The capture window's save names nothing: read everything (T30).
      listener!();
      expect(heard).toEqual([[OTHER], null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads one batch at a time, gathering what comes meanwhile', async () => {
    const reads: Array<readonly string[] | null> = [];
    let release: () => void = () => undefined;
    const puller = new StorePuller(async (ids) => {
      reads.push(ids);
      await new Promise<void>((resolve) => (release = resolve));
    });
    const step = async () => {
      await Promise.resolve();
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    puller.changed([ID]);
    puller.changed([OTHER]);
    puller.changed(['workspace', OTHER]);
    await step();
    await step();
    await puller.idle();
    expect(reads).toEqual([[ID], [OTHER, 'workspace']]);
    // "Everything" wins over a list that comes while a read runs.
    puller.changed([ID]);
    puller.changed(null);
    puller.changed([OTHER]);
    await step();
    await step();
    await puller.idle();
    expect(reads.slice(2)).toEqual([[ID], null]);
  });
});

/** Back, as the browser does it: the entry changes, then `popstate` (happy-dom fires it). */
function goBack(): void {
  window.history.back();
}
