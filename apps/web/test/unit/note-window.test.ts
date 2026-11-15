// @vitest-environment happy-dom
/**
 * T45 (D37, A710, A711): a note in a window of its own. The router's window route and its
 * in-window history, where links and other pages go from a note window, opening a window, and
 * the windows' offline refresh through the Mac app's main process.
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
  noteWindowPath,
  openNoteWindow,
  setStoreBeforeNoteWindow,
  STORE_BEFORE_OPEN_MS,
} from '../../src/window/open';
import {
  ANNOUNCE_DELAY_MS,
  MAX_ANNOUNCED_IDS,
  StorePuller,
  storeSync,
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

  it('sends any other page to the main window, and stays on its note', () => {
    // The Mac app's main process sends an app path from window.open to the main window (A712).
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    navigate('/trash');
    expect(open).toHaveBeenLastCalledWith('/trash', '_blank');
    navigate('/settings/appearance');
    expect(open).toHaveBeenLastCalledWith('/settings/appearance', '_blank');
    expect(here()).toBe(`/window/notes/${ID}`);
  });
});

describe('opening a note window', () => {
  beforeEach(() => load('/'));

  it('asks main for a window of its own, always a new one (A712)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openNoteWindow(ID);
    openNoteWindow(ID, 'Beds');
    expect(open.mock.calls).toEqual([
      [`/window/notes/${ID}`, '_blank'],
      [`/window/notes/${ID}?heading=Beds`, '_blank'],
    ]);
  });

  it('in the Mac app, opens it once this window has stored its notes (A1591)', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    let stored!: () => void;
    setStoreBeforeNoteWindow(() => new Promise<void>((resolve) => (stored = resolve)));
    try {
      openNoteWindow(ID);
      await Promise.resolve();
      // The new window would read the note without this window's last keystrokes.
      expect(open).not.toHaveBeenCalled();
      stored();
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      expect(open).toHaveBeenCalledWith(`/window/notes/${ID}`, '_blank');
    } finally {
      setStoreBeforeNoteWindow(null);
    }
  });

  it('opens it anyway once storing takes too long, or fails, and only once (A1591)', async () => {
    vi.useFakeTimers();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      let stored!: () => void;
      setStoreBeforeNoteWindow(() => new Promise<void>((resolve) => (stored = resolve)));
      openNoteWindow(ID);
      vi.advanceTimersByTime(STORE_BEFORE_OPEN_MS);
      expect(open).toHaveBeenCalledTimes(1);
      stored();
      await vi.runAllTimersAsync();
      expect(open).toHaveBeenCalledTimes(1);
      setStoreBeforeNoteWindow(() => Promise.reject(new Error('no store')));
      openNoteWindow(ID);
      await vi.runAllTimersAsync();
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      setStoreBeforeNoteWindow(null);
      vi.useRealTimers();
    }
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
    expect(open).toHaveBeenCalledWith(`/window/notes/${ID}?heading=Beds`, '_blank');
    expect(here()).toBe('/');
    // A plain click navigates here; ⌘-click is the browser's (a new tab).
    click({});
    expect(here()).toBe(`/notes/${ID}?heading=Beds`);
    const meta = click({ metaKey: true, altKey: true });
    expect(meta.preventDefault).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('windows refresh each other offline (T45, A711)', () => {
  /** The Mac app's main process: what one window stores, every other hears. */
  function mainProcess() {
    const listeners = new Set<(ids?: readonly string[]) => void>();
    const window = (): PenmossDesktop =>
      ({
        stored: (ids: readonly string[] | null) => {
          for (const listener of listeners) listener(ids ?? undefined);
        },
        onStoreChanged: (listener: (ids?: readonly string[]) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }) as unknown as PenmossDesktop;
    return { window };
  }

  it('tells the other windows which records were stored, a burst as one message', () => {
    vi.useFakeTimers();
    try {
      const main = mainProcess();
      const one = storeSync(main.window());
      const two = storeSync(main.window());
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
      // Without the bridge (a unit test's page): nothing is sent, and nothing heard.
      const alone = storeSync(null);
      alone.announce([ID]);
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
      expect(heard).toHaveLength(3);
      one.close();
    } finally {
      vi.useRealTimers();
    }
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
      const sync = storeSync(bridge);
      const heard: Array<readonly string[] | null> = [];
      sync.onChanged((ids) => heard.push(ids));
      sync.announce([ID]);
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
      expect(stored).toHaveBeenCalledWith([ID]);
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
