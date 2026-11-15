import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import type { IconName } from '@penmoss/ui/icons';
import { useKeys } from '../commands/hooks';
import { Kbd } from '../commands/Kbd';
import { useQuickAccess } from '../notes/quick-access';
import { ContextMenu } from '../shell/ContextMenu';
import { MenuItem } from '../shell/Menu';
import { revealNote } from '../shell/reveal-notebooks';
import { openNoteWindow } from '../window/open';
import { useTabs, useTabsState } from './hooks';
import { currentEntry, noteIdOfPath } from './state';

/**
 * A tab's menu (right-click, or the context-menu key with the tab focused; AC5): closing it or
 * the others, pinning, duplicating, moving it to a note window, its note's Quick Access pin
 * (which is not the tab's pin, A1499) and Reveal in Sidebar.
 */
export function TabMenu({
  id,
  x,
  y,
  onClose,
}: {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** `false`: the item put focus somewhere of its own (Reveal in Sidebar), so not on the tab. */
  readonly onClose: (giveFocusBack?: boolean) => void;
}) {
  const tabs = useTabs();
  const state = useTabsState();
  const quickAccess = useQuickAccess();
  const closeKeys = useKeys('tab.close');
  const tab = state?.tabs.find((item) => item.id === id);
  if (!tabs || !state || !tab) return null;
  const at = state.tabs.indexOf(tab);
  const note = noteIdOfPath(currentEntry(tab).path);
  const others = state.tabs.some((item) => item.id !== id && !item.pinned);
  const right = state.tabs.slice(at + 1).some((item) => !item.pinned);
  const pinnedQuick = note !== null && quickAccess.pinned(note);

  const item = (
    testId: string,
    label: string,
    icon: IconName,
    run: () => void,
    disabled = false,
    keys: readonly string[] = [],
    focusMoves = false,
  ) => (
    <MenuItem
      icon={icon}
      data-testid={testId}
      disabled={disabled}
      aria-keyshortcuts={ariaKeyShortcuts(keys) || undefined}
      // Named by aria-keyshortcuts: the keycaps stay out of the item's name.
      hint={
        keys[0] ? (
          <span className="menu-keys" aria-hidden="true">
            <Kbd combo={keys[0]} />
          </span>
        ) : null
      }
      onClick={() => {
        onClose(!focusMoves);
        run();
      }}
    >
      {label}
    </MenuItem>
  );
  const rule = (key: string) => <div key={key} className="menu-sep" role="separator" />;

  return (
    <ContextMenu label="Tab" x={x} y={y} onClose={onClose}>
      {item(
        'tab-menu-close',
        'Close Tab',
        'close',
        () => tabs.close(id),
        // ⌘W closes the active tab; a pinned one stays (A1499).
        false,
        tab.pinned ? [] : closeKeys,
      )}
      {item(
        'tab-menu-close-others',
        'Close Other Tabs',
        'close',
        () => tabs.closeOthers(id),
        !others,
      )}
      {item(
        'tab-menu-close-right',
        'Close Tabs to the Right',
        'close',
        () => tabs.closeRight(id),
        !right,
      )}
      {rule('a')}
      {item('tab-menu-pin', tab.pinned ? 'Unpin Tab' : 'Pin Tab', 'pin', () =>
        tabs.setPinned(id, !tab.pinned),
      )}
      {item('tab-menu-duplicate', 'Duplicate Tab', 'copy', () => tabs.duplicate(id))}
      {item(
        'tab-menu-window',
        'Move to New Window',
        'windowNew',
        () => {
          if (note === null) return;
          const path = currentEntry(tab).path;
          const heading = new URLSearchParams(path.split('?')[1] ?? '').get('heading');
          openNoteWindow(note, heading);
          tabs.close(id);
        },
        note === null,
      )}
      {rule('b')}
      {item(
        'tab-menu-quick-access',
        pinnedQuick ? 'Unpin from Quick Access' : 'Pin to Quick Access',
        'star',
        () => {
          if (note !== null) quickAccess.toggle(note);
        },
        note === null || !quickAccess.canChange,
      )}
      {item(
        'tab-menu-reveal',
        'Reveal in Sidebar',
        'folder',
        () => {
          if (note === null) return;
          // Its tab first, which the tree reveals (a tab behind too); focus goes to the row.
          tabs.activate(id);
          revealNote(note);
        },
        note === null,
        [],
        true,
      )}
    </ContextMenu>
  );
}
