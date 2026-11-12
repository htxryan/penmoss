import { describe, expect, it } from 'vitest';
import type { MenuModel } from '../../src/menu';
import {
  cascadeBounds,
  MAX_NOTE_WINDOWS,
  MAX_STORED_IDS,
  NOTE_WINDOWS_PER_SECOND,
  NoteWindowGate,
  NOTE_WINDOW,
  noteWindowPath,
  parseStoredIds,
  WindowRegistry,
} from '../../src/windows';

// T45 (D37, A712; amends A224): the main window and the note windows.

const ID = '01JB7Q3V6M8K2T9RZ4XN5C1HPD';

/** A window as the registry sees one. */
function fakeWindow(name: string) {
  let destroyed = false;
  return {
    name,
    webContents: { name: `${name} page` },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
  };
}

const menus = (label: string): MenuModel[] => [{ label, groups: [] }];

describe('the window registry (A712)', () => {
  it('finds the window, and its kind, an IPC message came from; never another', () => {
    const windows = new WindowRegistry<ReturnType<typeof fakeWindow>>();
    const main = fakeWindow('main');
    const note = fakeWindow('note');
    const capture = fakeWindow('capture');
    windows.add(main, 'main');
    windows.add(note, 'note');
    expect(windows.windowOf(main.webContents)).toBe(main);
    expect(windows.kindOf(main.webContents)).toBe('main');
    expect(windows.kindOf(note.webContents)).toBe('note');
    // The capture window is not one of them: it gets no menus, commands or admin requests.
    expect(windows.kindOf(capture.webContents)).toBeNull();
    expect(windows.kindOf({})).toBeNull();
    expect(windows.main).toBe(main);
    expect(windows.notes()).toEqual([note]);
    // A destroyed window answers nothing, before its `closed` event removes it.
    note.destroy();
    expect(windows.kindOf(note.webContents)).toBeNull();
    windows.remove(note);
    expect(windows.notes()).toEqual([]);
  });

  it('has one main window', () => {
    const windows = new WindowRegistry<ReturnType<typeof fakeWindow>>();
    windows.add(fakeWindow('main'), 'main');
    expect(() => windows.add(fakeWindow('second'), 'main')).toThrow();
  });

  it('takes a new main window once the old one is destroyed, before its `closed` (T47, A724)', () => {
    const windows = new WindowRegistry<ReturnType<typeof fakeWindow>>();
    const old = fakeWindow('main');
    windows.add(old, 'main');
    old.destroy();
    expect(windows.main).toBeNull();
    const next = fakeWindow('reopened');
    windows.add(next, 'main');
    expect(windows.main).toBe(next);
    windows.remove(old);
    expect(windows.main).toBe(next);
  });

  it('sends menu commands to the window in front, else the main window, else a note window', () => {
    const windows = new WindowRegistry<ReturnType<typeof fakeWindow>>();
    expect(windows.active).toBeNull(); // none: the main window is made again
    const main = fakeWindow('main');
    const one = fakeWindow('one');
    const two = fakeWindow('two');
    windows.add(main, 'main');
    expect(windows.active).toBe(main);
    // A new window comes to the front as it opens.
    windows.add(one, 'note');
    windows.add(two, 'note');
    expect(windows.active).toBe(two);
    windows.focused(one);
    expect(windows.active).toBe(one);
    windows.focused(main);
    expect(windows.active).toBe(main);
    // The main window closed: the window in front before it.
    windows.remove(main);
    expect(windows.active).toBe(one);
    windows.remove(one);
    expect(windows.active).toBe(two);
    // A window the registry does not hold never comes to the front.
    windows.focused(fakeWindow('capture'));
    expect(windows.active).toBe(two);
  });

  it('keeps each window’s menus and shows those of the window in front', () => {
    const windows = new WindowRegistry<ReturnType<typeof fakeWindow>>();
    const main = fakeWindow('main');
    const note = fakeWindow('note');
    windows.add(main, 'main');
    expect(windows.setMenus(main, menus('main'))).toBe(true);
    windows.add(note, 'note');
    // The main window, behind the note window, keeps its menus without showing them.
    expect(windows.setMenus(main, menus('main again'))).toBe(false);
    expect(windows.setMenus(note, menus('note'))).toBe(true);
    windows.focused(main);
    expect(windows.menusOf(main)).toEqual(menus('main again'));
    expect(windows.menusOf(note)).toEqual(menus('note'));
    expect(windows.setMenus(fakeWindow('capture'), menus('capture'))).toBe(false);
  });
});

describe('the window the Dock icon restores (PEN-67)', () => {
  it('is the window minimized last that is still minimized', () => {
    const windows = new WindowRegistry<ReturnType<typeof fakeWindow>>();
    const main = fakeWindow('main');
    const note = fakeWindow('note');
    windows.add(main, 'main');
    windows.add(note, 'note');
    expect(windows.lastMinimized()).toBeNull();
    windows.minimized(main);
    windows.minimized(note);
    expect(windows.lastMinimized()).toBe(note);
    // Minimized again, it is the last one again.
    windows.minimized(main);
    expect(windows.lastMinimized()).toBe(main);
  });

  it('forgets a window once it is restored or closed', () => {
    const windows = new WindowRegistry<ReturnType<typeof fakeWindow>>();
    const main = fakeWindow('main');
    const first = fakeWindow('first');
    const second = fakeWindow('second');
    windows.add(main, 'main');
    windows.add(first, 'note');
    windows.add(second, 'note');
    windows.minimized(main);
    windows.minimized(first);
    windows.minimized(second);
    windows.restored(second);
    expect(windows.lastMinimized()).toBe(first);
    windows.remove(first);
    expect(windows.lastMinimized()).toBe(main);
    // Destroyed but its `closed` still to come: not restored either.
    main.destroy();
    expect(windows.lastMinimized()).toBeNull();
  });

  it('skips a window that says it is no longer minimized, and ignores one not registered', () => {
    const windows = new WindowRegistry<
      ReturnType<typeof fakeWindow> & { isMinimized(): boolean }
    >();
    let noteMinimized = true;
    const main = { ...fakeWindow('main'), isMinimized: () => true };
    const note = { ...fakeWindow('note'), isMinimized: () => noteMinimized };
    const stranger = { ...fakeWindow('capture'), isMinimized: () => true };
    windows.add(main, 'main');
    windows.add(note, 'note');
    windows.minimized(main);
    windows.minimized(note);
    windows.minimized(stranger);
    expect(windows.lastMinimized()).toBe(note);
    noteMinimized = false;
    expect(windows.lastMinimized()).toBe(main);
  });
});

describe('opening a note window (A712)', () => {
  it('takes only an app page’s note window path, a ULID, with its query', () => {
    expect(noteWindowPath(`app://penmoss/window/notes/${ID}`)).toBe(`/window/notes/${ID}`);
    expect(noteWindowPath(`app://penmoss/window/notes/${ID}?heading=Beds`)).toBe(
      `/window/notes/${ID}?heading=Beds`,
    );
    for (const url of [
      `app://penmoss/notes/${ID}`,
      'app://penmoss/window/notes/nope',
      `app://penmoss/window/notes/${ID}/more`,
      'app://penmoss/window/notes/%E0',
      `https://app.penmoss.app/window/notes/${ID}`,
      `app://other/window/notes/${ID}`,
    ]) {
      expect(noteWindowPath(url), url).toBeNull();
    }
  });

  it('opens note windows a few a second and at most 20, so a runaway page cannot open hundreds', () => {
    const gate = new NoteWindowGate();
    let now = 1_000;
    for (let i = 0; i < NOTE_WINDOWS_PER_SECOND; i++) expect(gate.allows(i, now)).toBe(true);
    expect(gate.allows(NOTE_WINDOWS_PER_SECOND, now + 500)).toBe(false);
    now += 1_000;
    expect(gate.allows(NOTE_WINDOWS_PER_SECOND, now)).toBe(true);
    // One by one, as a person opens them: up to the cap, then none.
    expect(new NoteWindowGate().allows(MAX_NOTE_WINDOWS - 1, now)).toBe(true);
    expect(new NoteWindowGate().allows(MAX_NOTE_WINDOWS, now)).toBe(false);
  });

  it('cascades 720×800 from the window in front, back to the corner at the display’s edge', () => {
    const area = { x: 0, y: 25, width: 1440, height: 1000 };
    const from = { x: 100, y: 60, width: 1200, height: 800 };
    expect(cascadeBounds(from, area)).toEqual({
      x: 100 + NOTE_WINDOW.step,
      y: 60 + NOTE_WINDOW.step,
      width: 720,
      height: 800,
    });
    // Each step from the last.
    const second = cascadeBounds(cascadeBounds(from, area), area);
    expect([second.x, second.y]).toEqual([100 + 2 * NOTE_WINDOW.step, 60 + 2 * NOTE_WINDOW.step]);
    // Past the right or bottom edge: back to the corner, on that display.
    expect(cascadeBounds({ x: 800, y: 60, width: 720, height: 800 }, area)).toMatchObject({
      x: 0 + NOTE_WINDOW.step,
      y: 60 + NOTE_WINDOW.step,
    });
    expect(cascadeBounds({ x: 100, y: 250, width: 720, height: 800 }, area)).toMatchObject({
      x: 100 + NOTE_WINDOW.step,
      y: 25 + NOTE_WINDOW.step,
    });
    // A small display: no bigger than it.
    expect(cascadeBounds(null, { x: 0, y: 0, width: 600, height: 500 })).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 500,
    });
    // No window in front: centred.
    expect(cascadeBounds(null, area)).toEqual({ x: 360, y: 125, width: 720, height: 800 });
  });
});

describe('telling the other windows what a page stored (A711)', () => {
  it('passes on a short list of record ids, and nothing else', () => {
    expect(parseStoredIds([ID, 'workspace'])).toEqual([ID, 'workspace']);
    expect(parseStoredIds([])).toBeUndefined();
    expect(parseStoredIds(null)).toBeUndefined();
    expect(parseStoredIds('workspace')).toBeUndefined();
    expect(parseStoredIds([1])).toBeUndefined();
    expect(parseStoredIds(['x'.repeat(65)])).toBeUndefined();
    expect(parseStoredIds(Array.from({ length: MAX_STORED_IDS + 1 }, () => ID))).toBeUndefined();
  });
});
