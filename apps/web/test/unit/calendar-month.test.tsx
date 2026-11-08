// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { CommandsContext } from '../../src/commands/hooks';
import { Calendar } from '../../src/journal/Calendar';
import { TIME_ZONE_SETTING } from '../../src/journal/journal';
import { NotesContext } from '../../src/notes/hooks';
import type { Notes } from '../../src/notes/service';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';

// T19's sidebar calendar shows the month with today in it, also when the synced time zone
// arrives after the first render and moves today into the next month (found by the T51 e2e run
// on 31 October, already 1 November in Pacific/Kiritimati).

let root: Root;
let host: HTMLDivElement;
let settings: Record<string, unknown>;
const listeners = new Set<() => void>();
let state = {};

const workspace = {
  settings: () => settings,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState: () => state,
} as unknown as Workspace;

const noNotes: never[] = [];
const notes = {
  subscribe: () => () => undefined,
  list: () => noNotes,
  periodicId: (kind: string, key: string) => `${kind}:${key}`,
} as unknown as Notes;

function setSetting(key: string, value: unknown) {
  settings = { ...settings, [key]: value };
  state = {};
  act(() => {
    for (const listener of listeners) listener();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // 3 pm on 31 October in Chicago; 10 am on 1 November in Kiritimati (UTC+14).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-31T20:00:00Z'));
  settings = {};
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  listeners.clear();
  vi.useRealTimers();
});

const today = () => host.querySelector<HTMLElement>('[aria-current="date"]')?.dataset['date'];

describe('the sidebar calendar', () => {
  it('follows today into another month when the time zone changes', () => {
    act(() =>
      root.render(
        <CommandsContext.Provider value={new CommandCenter(COMMANDS, memoryBindings())}>
          <NotesContext.Provider value={notes}>
            <WorkspaceContext.Provider value={workspace}>
              <Calendar activeId={null} />
            </WorkspaceContext.Provider>
          </NotesContext.Provider>
        </CommandsContext.Provider>,
      ),
    );
    expect(today()).toBe('2026-10-31');
    setSetting(TIME_ZONE_SETTING, 'Pacific/Kiritimati');
    expect(today()).toBe('2026-11-01');
    expect(host.querySelector('[data-date="2026-11-30"]')).not.toBeNull();
    setSetting(TIME_ZONE_SETTING, 'America/Chicago');
    expect(today()).toBe('2026-10-31');
  });
});
