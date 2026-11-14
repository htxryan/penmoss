// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandsProvider } from '../../src/commands/CommandsRoot';
import { HistoryPanel } from '../../src/history/HistoryPanel';
import type {
  HistoryDetail,
  HistoryList,
  HistorySource,
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
    summaries: (ids) => Promise.resolve(new Map(ids.map((id) => [id, '+1 −0 line']))),
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
        const read = new Map(ids.map((id) => [id, `+${id} −0 lines`]));
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
    const summaries = () => [...container.querySelectorAll<HTMLElement>('.history-summary')];
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
    expect(summaries()[0]!.textContent).toBe('+30 −0 lines');
    expect(summaries()[29]!.textContent).toBe('+1 −0 lines');
    expect(container.querySelectorAll('.history-summary-pending')).toHaveLength(0);
  });
});
