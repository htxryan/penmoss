// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { CommandsContext, useCommand } from '../../src/commands/hooks';
import type { DesktopMenu, PenmossDesktop } from '../../src/desktop/bridge';
import { DesktopIntegration } from '../../src/desktop/DesktopIntegration';

// A526 after review: a menu item whose availability follows a screen's own state (a git
// notebook to sync for Sync now, a daily note for the journal's items) is greyed or ungreyed
// when that state changes, not only when the registry or the route do.

function SyncNow({ notebooks }: { notebooks: number }) {
  useCommand(
    'git.syncNow',
    () => undefined,
    () => notebooks > 0,
  );
  return null;
}

function Journal({ kind }: { kind: 'daily' | 'weekly' | null }) {
  const enabled = () => kind !== null;
  useCommand('journal.previous', () => undefined, enabled);
  useCommand('journal.next', () => undefined, enabled);
  useCommand(
    'journal.week',
    () => undefined,
    () => kind === 'daily',
  );
  return null;
}

let sent: Array<readonly DesktopMenu[]>;
let root: Root;
let center: CommandCenter;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent = [];
  const bridge = {
    platform: 'darwin',
    version: '0.0.0',
    window: 'main',
    menu: {
      set: (menus: readonly DesktopMenu[]) => sent.push(menus),
      onCommand: () => () => undefined,
    },
    onOpenPath: () => () => undefined,
    clipboard: { write: () => Promise.resolve(true) },
  } as unknown as PenmossDesktop;
  Object.assign(window, { penmossDesktop: bridge });
  center = new CommandCenter(COMMANDS, memoryBindings());
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  Reflect.deleteProperty(window, 'penmossDesktop');
});

/** Renders, then lets the menus' deferred send run. */
async function show(children: React.ReactNode): Promise<void> {
  act(() => {
    root.render(
      <CommandsContext.Provider value={center}>
        <DesktopIntegration />
        {children}
      </CommandsContext.Provider>,
    );
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

const enabledOf = (id: string): boolean | undefined => {
  const item = sent
    .at(-1)
    ?.flatMap((menu) => menu.groups.flat())
    .find((entry) => entry.id === id);
  if (!item) throw new Error(`no menu item ${id}`);
  return item.enabled;
};

describe('the Mac menus follow what each screen can do now (A526)', () => {
  it('sends the menus again when a notebook makes Sync now available, and when it goes', async () => {
    await show(<SyncNow notebooks={0} />);
    expect(enabledOf('git.syncNow')).toBe(false);
    const before = sent.length;
    // Only the screen's own state changes: no registry change, no route change.
    await show(<SyncNow notebooks={1} />);
    expect(sent.length).toBeGreaterThan(before);
    expect(enabledOf('git.syncNow')).toBeUndefined();
    await show(<SyncNow notebooks={0} />);
    expect(enabledOf('git.syncNow')).toBe(false);
  });

  it('greys the journal items until a daily or weekly note shows', async () => {
    await show(<Journal kind={null} />);
    expect(enabledOf('journal.previous')).toBe(false);
    expect(enabledOf('journal.next')).toBe(false);
    expect(enabledOf('journal.week')).toBe(false);
    await show(<Journal kind="daily" />);
    expect(enabledOf('journal.previous')).toBeUndefined();
    expect(enabledOf('journal.next')).toBeUndefined();
    expect(enabledOf('journal.week')).toBeUndefined();
    await show(<Journal kind="weekly" />);
    expect(enabledOf('journal.previous')).toBeUndefined();
    expect(enabledOf('journal.week')).toBe(false);
  });

  it('sends nothing more when a render changes nothing', async () => {
    await show(<SyncNow notebooks={1} />);
    const before = sent.length;
    await show(<SyncNow notebooks={1} />);
    expect(sent.length).toBe(before);
  });
});
