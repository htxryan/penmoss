import { useCommand, useCommands } from '../commands/hooks';
import { useSourcesRegistry } from '../sources/hooks';
import { openInMain, openNoteWindow } from '../window/open';
import { useTabs, useTabsState } from './hooks';
import { activeTab, currentEntry, isBareHome, noteIdOfPath, NEW_TAB_PATH } from './state';

/**
 * The tab commands (PEN-140, A1503): New Tab, Close Tab, Reopen Closed Tab, the others, and
 * moving between tabs. In a window with no tabs (a note window), New Tab asks the main window
 * for one, and the rest are not there.
 */
export function TabsCommands() {
  const tabs = useTabs();
  const state = useTabsState();
  const registry = useSourcesRegistry();
  const has = () => tabs !== null;
  const count = state?.tabs.length ?? 0;
  // A bare Home is no tab to close (A1576).
  const active = state && !isBareHome(state) ? activeTab(state) : null;

  const commands = useCommands();
  // A new tab is Home with the cursor in Search, as a browser's is in its address bar (AC2).
  useCommand('tab.new', () => {
    if (!tabs) {
      openInMain(NEW_TAB_PATH);
      return;
    }
    tabs.newTab();
    commands.run('app.search', { source: 'menu' });
  });
  // ⌘W leaves a pinned tab open (A1499).
  useCommand(
    'tab.close',
    () => tabs?.close(undefined, { fromKey: true }),
    () => has() && active !== null && !active.pinned,
  );
  useCommand(
    'tab.reopenClosed',
    () =>
      tabs?.reopenClosed((note) => {
        // Not a note in Trash or one no notebook knows (A1501).
        const source = registry.sourceOfNote(note);
        if (!source) return false;
        return source.notes.list().some((entry) => entry.id === note);
      }),
    () => has() && (state?.closed.length ?? 0) > 0,
  );
  useCommand(
    'tab.closeOthers',
    () => tabs?.closeOthers(),
    () => has() && count > 1,
  );
  useCommand(
    'tab.closeRight',
    () => tabs?.closeRight(),
    () => has() && count > 1,
  );
  useCommand(
    'tab.next',
    () => tabs?.cycle(1),
    () => has() && count > 1,
  );
  useCommand(
    'tab.previous',
    () => tabs?.cycle(-1),
    () => has() && count > 1,
  );
  useCommand('tab.select1', () => tabs?.selectNth(0), has);
  useCommand(
    'tab.select2',
    () => tabs?.selectNth(1),
    () => has() && count > 1,
  );
  useCommand(
    'tab.select3',
    () => tabs?.selectNth(2),
    () => has() && count > 2,
  );
  useCommand(
    'tab.select4',
    () => tabs?.selectNth(3),
    () => has() && count > 3,
  );
  useCommand(
    'tab.select5',
    () => tabs?.selectNth(4),
    () => has() && count > 4,
  );
  useCommand(
    'tab.select6',
    () => tabs?.selectNth(5),
    () => has() && count > 5,
  );
  useCommand(
    'tab.select7',
    () => tabs?.selectNth(6),
    () => has() && count > 6,
  );
  useCommand(
    'tab.select8',
    () => tabs?.selectNth(7),
    () => has() && count > 7,
  );
  useCommand('tab.selectLast', () => tabs?.selectLast(), has);
  useCommand(
    'tab.pin',
    () => {
      if (active) tabs?.setPinned(active.id, !active.pinned);
    },
    has,
  );
  useCommand('tab.duplicate', () => tabs?.duplicate(), has);
  const note = active ? noteIdOfPath(currentEntry(active).path) : null;
  useCommand(
    'tab.moveToWindow',
    () => {
      if (!tabs || !active || note === null) return;
      const path = currentEntry(active).path;
      openNoteWindow(note, new URLSearchParams(path.split('?')[1] ?? '').get('heading'));
      tabs.close(active.id);
    },
    () => has() && note !== null,
  );
  useCommand(
    'tab.all',
    () => {
      // The strip's All Tabs button when the tabs overflow; else the first tab takes focus.
      const all = document.querySelector<HTMLButtonElement>('[data-testid="tab-all"]');
      if (all) {
        all.click();
        return;
      }
      document.querySelector<HTMLElement>('.tab-strip [role="tab"][tabindex="0"]')?.focus();
    },
    has,
  );
  return null;
}
