// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandsProvider } from '../../src/commands/CommandsRoot';
import { dayLabel } from '../../src/history/format';
import { HistoryPanel } from '../../src/history/HistoryPanel';
import type {
  HistoryDetail,
  HistoryList,
  HistorySource,
  HistorySummary,
  HistoryVersion,
} from '../../src/history/source';
import { NotesProvider } from '../../src/notes/context';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';
import { memoryNotes } from './support/memory-notes';
import { testNotes } from './support/local-sources';

// A1180: Sync Now's "Saved a version" came before the list was read again, so for a moment the
// status sat over the versions from before, and a click on the top one then picked the version
// before the save (the web suite's Version History test, 9 runs in 30 under load). The status
// now waits for the list.

const NOTE = '01JB7Q3V6M8K2T9RZ4XN5C1HPD';

const version = (id: number): HistoryVersion => ({
  id,
  createdAt: Date.UTC(2026, 10, 7, 15, id),
  reason: 'auto',
  summary: '',
  authors: [{ id: 'this-mac', kind: 'device', label: 'Penmoss for Mac' }],
});

/** A git notebook's history whose next list read waits until the test lets it land. */
function slowHistory() {
  let versions: HistoryVersion[] = [version(1)];
  let release: (() => void) | null = null;
  let held = false;
  const source: HistorySource = {
    offline: 'offline',
    automatic: 'Each sync with git is a version.',
    saveLabel: 'Sync Now',
    list: () => {
      const list: HistoryList = { versions: [...versions].reverse(), unversioned: null };
      if (!held) return Promise.resolve(list);
      return new Promise((resolve) => {
        release = () => resolve(list);
      });
    },
    summaries: (ids) =>
      Promise.resolve(
        new Map(ids.map((id) => [id, { summary: '+1 −0 line', gist: `Added “v${id}”` }])),
      ),
    detail: (id) =>
      Promise.resolve<HistoryDetail>({
        id,
        previousId: id > 1 ? id - 1 : null,
        markdown: `version ${id}`,
        diff: [{ op: 'add', line: `version ${id}` }],
      }),
    save: () => {
      // The save made a commit; the list read after it is slow (git through the Mac app).
      versions = [...versions, version(versions.length + 1)];
      held = true;
      return Promise.resolve();
    },
    restore: () => Promise.resolve({ changed: true }),
    revert: () => Promise.resolve({ changed: true, conflicts: [] }),
  };
  return {
    source,
    land: () => {
      held = false;
      release?.();
      release = null;
    },
  };
}

const history = vi.hoisted(() => ({ current: null as HistorySource | null }));
vi.mock('../../src/history/source', async (original) => {
  const actual = await original<typeof import('../../src/history/source')>();
  return { ...actual, noHistory: () => history.current! };
});

const workspace = {
  settings: () => ({}),
  setSetting: () => undefined,
  subscribe: () => () => undefined,
} as unknown as Workspace;

let unmount = () => undefined as void;
afterEach(() => unmount());

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe('Version History after Sync Now (A1180)', () => {
  it('says the version is saved only once the list shows it, picked', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const slow = slowHistory();
    history.current = slow.source;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
    act(() =>
      root.render(
        <WorkspaceContext.Provider value={workspace}>
          <NotesProvider notes={testNotes(memoryNotes())}>
            <CommandsProvider>
              <HistoryPanel noteId={NOTE} />
            </CommandsProvider>
          </NotesProvider>
        </WorkspaceContext.Provider>,
      ),
    );
    await flush();
    const $ = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const entries = () => [...container.querySelectorAll<HTMLElement>('.history-list button')];
    expect(entries()).toHaveLength(1);

    act(() => container.querySelector<HTMLElement>('.history-save')!.click());
    await flush();
    // Saved, but the list read after it has not landed: nothing says it is saved yet.
    expect($('history-status')).toBeNull();
    expect(entries()).toHaveLength(1);

    slow.land();
    await flush();
    expect($('history-status')?.textContent).toContain('Saved a version');
    expect(entries()).toHaveLength(2);
    // The top one is the saved version, and it is the one shown.
    expect(entries()[0]!.getAttribute('aria-pressed')).toBe('true');
    expect($('history-diff')?.textContent).toContain('version 2');
  });
});

describe('Version History shows the list before the summaries (Ryan’s review of #192)', () => {
  it('lists every version at once, then fills in what each changed', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const asked: number[][] = [];
    let release: (() => void) | null = null;
    const versions = Array.from({ length: 30 }, (_, i) => version(30 - i));
    history.current = {
      offline: 'offline',
      automatic: 'Each sync with git is a version.',
      saveLabel: 'Sync Now',
      list: () => Promise.resolve({ versions, unversioned: null }),
      summaries: (ids) => {
        asked.push([...ids]);
        const read = new Map(
          ids.map((id) => [id, { summary: `+${id} −0 lines`, gist: `Added “line ${id}”` }]),
        );
        // The first read (the rows on screen) waits until the test lets it land.
        if (asked.length > 1) return Promise.resolve(read);
        return new Promise((resolve) => {
          release = () => resolve(read);
        });
      },
      detail: () => Promise.resolve(null),
      save: () => Promise.resolve(),
      restore: () => Promise.resolve({ changed: true }),
      revert: () => Promise.resolve({ changed: true, conflicts: [] }),
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
    act(() =>
      root.render(
        <WorkspaceContext.Provider value={workspace}>
          <NotesProvider notes={testNotes(memoryNotes())}>
            <CommandsProvider>
              <HistoryPanel noteId={NOTE} />
            </CommandsProvider>
          </NotesProvider>
        </WorkspaceContext.Provider>,
      ),
    );
    await flush();
    const summaries = () => [
      ...container.querySelectorAll<HTMLElement>('.history-list .history-summary'),
    ];
    // Every version is listed, each waiting for its summary.
    expect(summaries()).toHaveLength(30);
    expect(summaries().every((each) => each.getAttribute('aria-busy') === 'true')).toBe(true);
    expect(container.querySelectorAll('.history-summary-pending')).toHaveLength(30);
    // The newest 20 are read first, in one call.
    expect(asked).toEqual([versions.slice(0, 20).map((v) => v.id)]);

    act(() => release!());
    await flush();
    // Then the other 10, in one more.
    expect(asked[1]).toEqual(versions.slice(20).map((v) => v.id));
    expect(summaries()[0]!.textContent).toBe('Added “line 30”');
    expect(summaries()[29]!.textContent).toBe('Added “line 1”');
    // The lines it changed beside it, in their colours.
    const lines = container.querySelector<HTMLElement>('.history-entry .history-lines')!;
    expect(lines.querySelector('.history-added')?.textContent).toBe('+30');
    expect(lines.querySelector('.history-removed')).toBeNull();
    expect(container.querySelectorAll('.history-summary-pending')).toHaveLength(0);
  });
});

describe('Version History as a list over a docked preview (Ryan’s review of #192, finding 13)', () => {
  const at = (day: number, hour: number, minute = 0) =>
    new Date(2026, 10, day, hour, minute).getTime();
  const versions: HistoryVersion[] = [
    {
      id: 5,
      createdAt: at(14, 14, 42),
      reason: 'edit',
      summary: '',
      authors: [{ id: 'claude', kind: 'agent', label: 'Claude Code' }],
    },
    {
      id: 4,
      createdAt: at(14, 10, 31),
      reason: 'auto',
      summary: '',
      authors: [{ id: 'mac', kind: 'device', label: 'Penmoss for Mac' }],
    },
    {
      id: 3,
      createdAt: at(13, 16, 48),
      reason: 'auto',
      summary: '',
      authors: [{ id: 'pixel', kind: 'device', label: 'Penmoss for Android (Pixel 10 Pro)' }],
    },
    {
      id: 2,
      createdAt: at(12, 9, 30),
      reason: 'auto',
      summary: '',
      authors: [{ id: 'mac', kind: 'device', label: 'Penmoss for Mac' }],
    },
    {
      id: 1,
      createdAt: new Date(2025, 11, 30, 9, 0).getTime(),
      reason: 'auto',
      summary: '',
      authors: [{ id: 'mac', kind: 'device', label: 'Penmoss for Mac' }],
    },
  ];
  const described: Record<number, HistorySummary> = {
    5: { summary: '+1 −1 line', gist: 'Checked off “Tags page”' },
    4: { summary: '+14 −5 lines', gist: 'Next up, Android' },
    3: { summary: 'No text changes', gist: '' },
    2: { summary: '+3 −0 lines', gist: 'Added “Plan” and 2 more' },
    1: { summary: '+1 −0 line', gist: 'Added “First”' },
  };
  const thisMac = { id: 'this-mac', kind: 'device', label: 'This Mac' } as const;

  function render(source: HistorySource) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    history.current = source;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      act(() => root.unmount());
      container.remove();
      vi.useRealTimers();
    };
    act(() =>
      root.render(
        <WorkspaceContext.Provider value={workspace}>
          <NotesProvider notes={testNotes(memoryNotes())}>
            <CommandsProvider>
              <HistoryPanel noteId={NOTE} />
            </CommandsProvider>
          </NotesProvider>
        </WorkspaceContext.Provider>,
      ),
    );
    return container;
  }

  function source(overrides: Partial<HistorySource> = {}): HistorySource {
    return {
      offline: 'offline',
      automatic: 'Each sync with git is a version.',
      saveLabel: 'Sync Now',
      list: () => Promise.resolve({ versions, unversioned: { authors: [thisMac], since: 0 } }),
      summaries: (ids) => Promise.resolve(new Map(ids.map((id) => [id, described[id]!]))),
      detail: (id) =>
        Promise.resolve<HistoryDetail>({
          id,
          previousId: id > 1 ? id - 1 : null,
          markdown: `---\ntitle: Plan\n---\n\nversion ${id}\n`,
          diff: [{ op: 'add', line: `version ${id}` }],
        }),
      save: () => Promise.resolve(),
      restore: () => Promise.resolve({ changed: true }),
      revert: () => Promise.resolve({ changed: true, conflicts: [] }),
      ...overrides,
    };
  }

  it('names the days: Today, Yesterday, a date, and the year when it is another', () => {
    const now = at(14, 15);
    expect(dayLabel(at(14, 0, 1), now)).toBe('Today');
    expect(dayLabel(at(13, 23, 59), now)).toBe('Yesterday, Nov 13');
    expect(dayLabel(at(12, 9), now)).toBe('Nov 12');
    expect(dayLabel(new Date(2025, 11, 30).getTime(), now)).toBe('Dec 30, 2025');
  });

  it('lists one line per version by day, each writer’s icon naming them on hover', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(14, 15));
    const container = render(source());
    await flush();
    const days = [...container.querySelectorAll('.history-day')].map((day) => day.textContent);
    expect(days).toEqual(['Today', 'Yesterday, Nov 13', 'Nov 12', 'Dec 30, 2025']);
    const rows = [...container.querySelectorAll<HTMLElement>('.history-list .history-entry')];
    expect(rows).toHaveLength(5);
    // Who (an icon, its name a tooltip and words for screen readers), when, what, the lines.
    const who = rows[0]!.querySelector<HTMLElement>('.history-who')!;
    expect(who.dataset['tip']).toBe('Agent · Claude Code');
    expect(who.dataset['kind']).toBe('agent');
    expect(who.querySelector('svg')).not.toBeNull();
    expect(rows[0]!.textContent).toContain('Agent · Claude Code');
    expect(rows[0]!.querySelector('.history-time')!.textContent).toMatch(/^2:42\sPM$/);
    expect(rows[0]!.querySelector('.history-summary')!.textContent).toBe('Checked off “Tags page”');
    expect(rows[1]!.querySelector('.history-lines')!.textContent).toBe('+14−5');
    expect(rows[2]!.querySelector<HTMLElement>('.history-who')!.dataset['tip']).toBe(
      'Penmoss for Android (Pixel 10 Pro)',
    );
    // A version that changed no text is there, dimmed, and says so.
    expect(rows[2]!.hasAttribute('data-dim')).toBe(true);
    expect(rows[2]!.querySelector('.history-summary')!.textContent).toBe('No text changes');
    // Now, above them: not synced yet, with Sync Now (quiet), described by how versions are made.
    const now = container.querySelector<HTMLElement>('[data-testid="history-now"]')!;
    expect(now.textContent).toContain('Not saved as a version yet');
    const sync = now.querySelector<HTMLButtonElement>('.history-save')!;
    expect(sync.textContent).toBe('Sync Now');
    expect(sync.className).toContain('quiet');
    const described = document.getElementById(sync.getAttribute('aria-describedby')!);
    expect(described?.textContent).toBe('Each sync with git is a version.');
  });

  it('moves through the versions with ↑ and ↓, showing each one’s changes', async () => {
    const container = render(source());
    await flush();
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>('.history-entry')];
    const picked = () => rows().findIndex((row) => row.getAttribute('aria-pressed') === 'true');
    const diff = () => container.querySelector('[data-testid="history-diff"]')?.textContent;
    expect(picked()).toBe(0);
    // One stop in the Tab order: the chosen row.
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect(diff()).toContain('version 5');
    const press = (key: string) =>
      act(() => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    rows()[0]!.focus();
    press('ArrowDown');
    await flush();
    expect(picked()).toBe(1);
    expect(document.activeElement).toBe(rows()[1]);
    expect(diff()).toContain('version 4');
    press('End');
    await flush();
    expect(picked()).toBe(4);
    expect(diff()).toContain('version 1');
    press('ArrowDown');
    expect(picked()).toBe(4);
    press('ArrowUp');
    await flush();
    expect(picked()).toBe(3);
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
  });

  it('docks the changes under a handle that resizes them, and remembers it', async () => {
    localStorage.removeItem('penmoss.historyPreviewHeight');
    const container = render(source());
    await flush();
    const handle = container.querySelector<HTMLElement>('[data-testid="history-resizer"]')!;
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute('aria-valuenow')).toBe('20');
    const panel = container.querySelector<HTMLElement>('[data-testid="history-panel"]')!;
    expect(panel.style.getPropertyValue('--history-preview')).toBe('20rem');
    // ↑ makes the changes taller (the list shorter); with Shift, by four.
    act(() => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(handle.getAttribute('aria-valuenow')).toBe('21');
    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }),
      );
    });
    expect(handle.getAttribute('aria-valuenow')).toBe('17');
    expect(panel.style.getPropertyValue('--history-preview')).toBe('17rem');
    expect(localStorage.getItem('penmoss.historyPreviewHeight')).toBe('17');
    localStorage.removeItem('penmoss.historyPreviewHeight');
  });

  it('puts the actions under the changes, each with its icon; Copy Text copies the body', async () => {
    const writeText = vi.fn((text: string) => Promise.resolve(void text));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const container = render(source());
    await flush();
    const detail = container.querySelector<HTMLElement>('[aria-label="Selected Version"]')!;
    const buttons = [...detail.querySelectorAll<HTMLButtonElement>('.history-actions button')];
    // An agent's version: Restore, Revert, Copy, each an icon and one word (Ryan's review of #193,
    // R2-12), its full name in Title Case for screen readers and in its tooltip.
    expect(buttons.map((button) => button.textContent)).toEqual(['Restore', 'Revert', 'Copy']);
    const names = ['Restore This Version', 'Revert This Edit', 'Copy Text'];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(names);
    expect(buttons.map((button) => button.dataset['tip'])).toEqual(names);
    expect(buttons.every((button) => button.querySelector('svg'))).toBe(true);
    // No ↑/↓ hint beside them (R2-11).
    expect(detail.querySelector('kbd')).toBeNull();
    act(() => buttons[2]!.click());
    await flush();
    expect(writeText).toHaveBeenCalledWith('version 5\n');
    expect(container.querySelector('[data-testid="history-status"]')?.textContent).toBe(
      'Copied the text of this version.',
    );
  });

  it('offers View only where there is a note as it is now to compare with (A1572)', async () => {
    const without = render(source());
    await flush();
    expect(without.querySelector('[data-testid="history-view-open"]')).toBeNull();
    unmount();
    const container = render(
      source({ current: () => Promise.resolve('---\ntitle: Plan\n---\n\nnow\n') }),
    );
    await flush();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.history-actions button')];
    // First, an icon and one word, its full name for screen readers and in its tooltip.
    expect(buttons.map((button) => button.textContent)).toEqual([
      'View',
      'Restore',
      'Revert',
      'Copy',
    ]);
    expect(buttons[0]!.getAttribute('aria-label')).toBe('View This Version');
    expect(buttons[0]!.dataset['tip']).toBe('View This Version');
    expect(buttons[0]!.querySelector('svg[data-icon="eye"]')).not.toBeNull();
  });

  it('views a version beside now: a dialog owning the panel, both sides, the differences tinted', async () => {
    const restored: number[] = [];
    const container = render(
      source({
        current: () => Promise.resolve('---\ntitle: Plan\n---\n\nversion 3\n\nnow only\n'),
        restore: (id) => {
          restored.push(id);
          return Promise.resolve({ changed: true });
        },
      }),
    );
    await flush();
    const view = () => document.querySelector<HTMLElement>('[data-testid="history-view"]');
    const open = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="history-view-open"]');
    act(() => open()!.click());
    await vi.waitFor(() => expect(view()?.querySelector('.history-view-side')).not.toBeNull());
    const dialog = view()!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The panel stays beside it, in it for Tab and for screen readers.
    const panel = container.querySelector<HTMLElement>('[data-testid="history-panel"]')!;
    expect(dialog.getAttribute('aria-owns')).toBe(panel.id);
    // The preview folds away; focus is on the version picked in the list.
    expect(container.querySelector('[aria-label="Selected Version"]')).toBeNull();
    expect(container.querySelector('[data-testid="history-viewing"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('data-version')).toBe('5');
    const side = (which: string) => dialog.querySelector<HTMLElement>(`[data-side="${which}"]`)!;
    expect(side('right').getAttribute('aria-label')).toBe('Now');
    expect(side('left').getAttribute('aria-label')).toBe(dialog.querySelector('h2')!.textContent);
    // The title is the same; the version's line was replaced; now's last line has a gap beside it.
    const cells = (which: string) =>
      [...side(which).children].filter(
        (cell) =>
          !cell.classList.contains('history-view-line') &&
          !cell.classList.contains('history-view-gutter'),
      );
    const numbers = (which: string) =>
      [...side(which).querySelectorAll('.history-view-line')].map((cell) => cell.textContent);
    const changes = (which: string) =>
      cells(which).map((cell) =>
        cell.classList.contains('history-view-gap')
          ? 'gap'
          : ((cell as HTMLElement).dataset['change'] ?? 'same'),
      );
    expect(changes('left')).toEqual(['same', 'removed', 'gap']);
    expect(changes('right')).toEqual(['same', 'added', 'added']);
    expect(cells('left')[1]!.textContent).toBe('Not in now: version 5');
    // Each block's line in the markdown, in its side's gutter; the gap's is empty.
    expect(numbers('left')).toEqual(['2', '5', '']);
    expect(numbers('right')).toEqual(['2', '5', '7']);
    // The top actions keep the short names: Wrap Lines, on; then the switch from Diff (the
    // default) to Full File.
    const actions = [...dialog.querySelectorAll<HTMLButtonElement>('.history-view-head button')];
    expect(actions[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Wrap Lines',
      'Show Full File',
      'Restore This Version',
      'Revert This Edit',
      'Copy Text',
      'Close',
    ]);
    expect(actions[0]!.textContent).toBe('Wrap Lines');
    expect(actions[1]!.querySelector('.history-view-long')!.textContent).toBe('Show Full File');
    expect(actions[1]!.querySelector('.history-view-short')!.textContent).toBe('Full File');
    expect(actions.slice(2, 5).map((button) => button.textContent)).toEqual([
      'Restore',
      'Revert',
      'Copy',
    ]);
    // Close is the app's × for a dialog (DialogClose), with no words of its own.
    expect(actions[5]!.textContent).toBe('');
    expect(actions[5]!.querySelector('svg[data-icon="close"]')).not.toBeNull();
    expect(actions[5]!.dataset['tip']).toBe('Close (Esc)');
    // The toggle flips, and this device remembers it.
    act(() => actions[1]!.click());
    expect(actions[1]!.getAttribute('aria-label')).toBe('Show Diff');
    expect(localStorage.getItem('penmoss.historyView.mode')).toBe('full');
    act(() => actions[1]!.click());
    expect(actions[1]!.getAttribute('aria-label')).toBe('Show Full File');
    expect(localStorage.getItem('penmoss.historyView.mode')).toBeNull();
    // Wrap Lines turns off, and this device remembers that too.
    act(() => actions[0]!.click());
    expect(actions[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(dialog.querySelector('.history-view-grid')!.getAttribute('data-wrap')).toBe('off');
    expect(localStorage.getItem('penmoss.historyView.wrap')).toBe('off');
    act(() => actions[0]!.click());
    expect(dialog.querySelector('.history-view-grid')!.hasAttribute('data-wrap')).toBe(false);
    expect(localStorage.getItem('penmoss.historyView.wrap')).toBeNull();

    // Another version from the list: only the left side changes. A phone's can be reverted too
    // (A1575).
    const rows = [...container.querySelectorAll<HTMLElement>('.history-list .history-entry')];
    act(() => rows[2]!.click());
    await vi.waitFor(() => expect(cells('left')[1]?.textContent).toBe('version 3'));
    expect(changes('left')).toEqual(['same', 'same', 'gap']);
    expect(dialog.querySelector('[aria-label="Revert This Edit"]')).not.toBeNull();

    // Esc closes it, and focus goes back to View.
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await flush();
    expect(view()).toBeNull();
    expect(document.activeElement).toBe(open());

    // Restore from it restores that version, closes it, and says so under the changes.
    act(() => open()!.click());
    await vi.waitFor(() => expect(view()?.querySelector('.history-view-side')).not.toBeNull());
    act(() =>
      view()!.querySelector<HTMLButtonElement>('[aria-label="Restore This Version"]')!.click(),
    );
    await vi.waitFor(() => expect(view()).toBeNull());
    expect(restored).toEqual([3]);
    expect(container.querySelector('[data-testid="history-status"]')?.textContent).toContain(
      'as a new change',
    );
    expect(document.activeElement).toBe(open());
  });

  it('reads the list again when the note’s sync state changes', async () => {
    let changed: (() => void) | null = null;
    let pending = true;
    const container = render(
      source({
        list: () =>
          Promise.resolve({
            versions,
            unversioned: pending ? { authors: [thisMac], since: 0 } : null,
          }),
        watch: (listener) => {
          changed = listener;
          return () => {
            changed = null;
          };
        },
      }),
    );
    await flush();
    const now = () => container.querySelector('[data-testid="history-now"]')!.textContent;
    expect(now()).toContain('Not saved as a version yet');
    pending = false;
    act(() => changed!());
    await flush();
    expect(now()).toContain('Synced');
  });
});
