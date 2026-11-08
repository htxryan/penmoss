// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuBar, MenuBarPin, PenmossDesktop } from '../../src/desktop/bridge';
import { MenuBarIconSetting } from '../../src/desktop/MenuBarIconSetting';
import { QuickAccessMenuBar } from '../../src/desktop/QuickAccessMenuBar';
import type { QuickAccessNote } from '../../src/notes/quick-access';

// T51 item 17 (A945, A946) in the page: the main window tells the Mac app the Quick Access
// notes and their titles as they change, and Settings → Display shows the per-Mac toggle. The
// Electron suite (apps/desktop/test/e2e/menu-bar.spec.ts) checks the menu in the app.

let pinned: readonly Omit<QuickAccessNote, 'notebook'>[] = [];
vi.mock('../../src/notes/quick-access', () => ({
  useQuickAccessNotes: (): readonly QuickAccessNote[] =>
    pinned.map((pin) => ({ notebook: null, ...pin })),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ID_A = '01JZ0000000000000000000001';
const ID_B = '01JZ0000000000000000000002';

let root: Root;
let host: HTMLElement;

function install(window: PenmossDesktop['window'], menuBar: MenuBar | undefined) {
  const bridge = { platform: 'darwin', version: '0.0.0', window, menuBar } as PenmossDesktop;
  Object.assign(globalThis.window, { penmossDesktop: bridge });
}

beforeEach(() => {
  pinned = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'penmossDesktop');
});

const render = (element: React.ReactElement) => act(() => root.render(element));
/** Runs `step`, then lets the bridge's answers arrive. */
const settle = (step: () => void) =>
  act(async () => {
    step();
    await Promise.resolve();
  });

describe('the Quick Access notes for the menu bar icon', () => {
  it('are sent from the main window, again only when a pin or its title changes', () => {
    const sent: Array<readonly MenuBarPin[]> = [];
    install('main', {
      shown: () => Promise.resolve(true),
      setShown: () => Promise.resolve(true),
      setQuickAccess: (pins) => sent.push(pins),
    });
    pinned = [
      { id: ID_B, title: 'Groceries' },
      { id: ID_A, title: '' },
    ];
    render(<QuickAccessMenuBar />);
    expect(sent).toEqual([
      [
        { id: ID_B, title: 'Groceries' },
        { id: ID_A, title: '' },
      ],
    ]);
    // A new list with the same pins (another note edited): nothing sent.
    pinned = [...pinned];
    render(<QuickAccessMenuBar />);
    expect(sent).toHaveLength(1);
    pinned = [
      { id: ID_B, title: 'Groceries and more' },
      { id: ID_A, title: '' },
    ];
    render(<QuickAccessMenuBar />);
    expect(sent).toHaveLength(2);
    expect(sent.at(-1)).toEqual([
      { id: ID_B, title: 'Groceries and more' },
      { id: ID_A, title: '' },
    ]);
    // Unpinned (or trashed: the list leaves it out): the menu loses it.
    pinned = [{ id: ID_A, title: '' }];
    render(<QuickAccessMenuBar />);
    expect(sent.at(-1)).toEqual([{ id: ID_A, title: '' }]);
  });

  it('are not sent from a note window, or by a Mac app without the menu bar icon', () => {
    const setQuickAccess = vi.fn();
    pinned = [{ id: ID_A, title: 'A' }];
    install('note', { shown: () => Promise.resolve(true), setShown: vi.fn(), setQuickAccess });
    render(<QuickAccessMenuBar />);
    act(() => root.unmount());
    root = createRoot(host);
    install('main', undefined);
    render(<QuickAccessMenuBar />);
    expect(setQuickAccess).not.toHaveBeenCalled();
    expect(host.innerHTML).toBe('');
  });

  it('carry ids and titles only', () => {
    const sent: Array<readonly MenuBarPin[]> = [];
    install('main', {
      shown: () => Promise.resolve(true),
      setShown: () => Promise.resolve(true),
      setQuickAccess: (pins) => sent.push(pins),
    });
    pinned = [{ id: ID_A, title: 'A', extra: 1 } as Omit<QuickAccessNote, 'notebook'>];
    render(<QuickAccessMenuBar />);
    expect(sent).toEqual([[{ id: ID_A, title: 'A' }]]);
  });
});

describe('Settings → Display → Show Penmoss in the Menu Bar', () => {
  const box = () => host.querySelector<HTMLInputElement>('[data-testid="menu-bar-icon"]');

  it('shows only in the Mac app', () => {
    render(<MenuBarIconSetting />);
    expect(box()).toBeNull();
  });

  it('reads this Mac’s preference, off by default, and turns it on', async () => {
    let shown = false;
    const setShown = vi.fn((next: boolean) => {
      shown = next;
      return Promise.resolve(shown);
    });
    install('main', { shown: () => Promise.resolve(shown), setShown });
    await settle(() => root.render(<MenuBarIconSetting />));
    expect(host.textContent).toContain('Show Penmoss in the Menu Bar');
    expect(box()?.checked).toBe(false);
    await settle(() => box()?.click());
    expect(setShown).toHaveBeenCalledWith(true);
    expect(box()?.checked).toBe(true);
  });

  it('goes back when the Mac refuses the change', async () => {
    install('main', { shown: () => Promise.resolve(false), setShown: () => Promise.resolve(null) });
    await settle(() => root.render(<MenuBarIconSetting />));
    await settle(() => box()?.click());
    expect(box()?.checked).toBe(false);
  });
});
