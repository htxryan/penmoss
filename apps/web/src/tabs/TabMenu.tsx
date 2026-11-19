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

  const rule = (key: string) => <div key={key} className="menu-sep" role="separator" />;

  return (
    <ContextMenu label="Tab" x={x} y={y} onClose={onClose}>
      <Item
        data-event="tabs.menu.close"
        testId="tab-menu-close"
        label="Close Tab"
        icon="close"
        run={() => tabs.close(id)}
        // ⌘W closes the active tab; a pinned one stays (A1499).
        keys={tab.pinned ? [] : closeKeys}
        onClose={onClose}
      />
      <Item
        data-event="tabs.menu.close-others"
        testId="tab-menu-close-others"
        label="Close Other Tabs"
        icon="close"
        run={() => tabs.closeOthers(id)}
        disabled={!others}
        onClose={onClose}
      />
      <Item
        data-event="tabs.menu.close-right"
        testId="tab-menu-close-right"
        label="Close Tabs to the Right"
        icon="close"
        run={() => tabs.closeRight(id)}
        disabled={!right}
        onClose={onClose}
      />
      {rule('a')}
      <Item
        data-event={tab.pinned ? 'tabs.menu.unpin' : 'tabs.menu.pin'}
        testId="tab-menu-pin"
        label={tab.pinned ? 'Unpin Tab' : 'Pin Tab'}
        icon="pin"
        run={() => tabs.setPinned(id, !tab.pinned)}
        onClose={onClose}
      />
      <Item
        data-event="tabs.menu.duplicate"
        testId="tab-menu-duplicate"
        label="Duplicate Tab"
        icon="copy"
        run={() => tabs.duplicate(id)}
        onClose={onClose}
      />
      <Item
        data-event="tabs.menu.move-to-window"
        testId="tab-menu-window"
        label="Move to New Window"
        icon="windowNew"
        run={() => {
          if (note === null) return;
          const path = currentEntry(tab).path;
          const heading = new URLSearchParams(path.split('?')[1] ?? '').get('heading');
          openNoteWindow(note, heading);
          tabs.close(id);
        }}
        disabled={note === null}
        onClose={onClose}
      />
      {rule('b')}
      <Item
        data-event={pinnedQuick ? 'tabs.menu.quick-access.unpin' : 'tabs.menu.quick-access.pin'}
        testId="tab-menu-quick-access"
        label={pinnedQuick ? 'Unpin from Quick Access' : 'Pin to Quick Access'}
        icon="star"
        run={() => {
          if (note !== null) quickAccess.toggle(note);
        }}
        disabled={note === null || !quickAccess.canChange}
        onClose={onClose}
      />
      <Item
        data-event="tabs.menu.reveal"
        testId="tab-menu-reveal"
        label="Reveal in Sidebar"
        icon="folder"
        run={() => {
          if (note === null) return;
          // Its tab first, which the tree reveals (a tab behind too); focus goes to the row.
          tabs.activate(id);
          revealNote(note);
        }}
        disabled={note === null}
        focusMoves
        onClose={onClose}
      />
    </ContextMenu>
  );
}

/** One of the menu's items; `data-event` is its tracked id (PEN-137). */
function Item({
  'data-event': event,
  testId,
  label,
  icon,
  run,
  disabled = false,
  keys = [],
  focusMoves = false,
  onClose,
}: {
  readonly 'data-event': string;
  readonly testId: string;
  readonly label: string;
  readonly icon: IconName;
  readonly run: () => void;
  readonly disabled?: boolean;
  readonly keys?: readonly string[];
  /** The item puts focus somewhere of its own, so not back on the tab. */
  readonly focusMoves?: boolean;
  readonly onClose: (giveFocusBack?: boolean) => void;
}) {
  return (
    <MenuItem
      icon={icon}
      data-testid={testId}
      data-event={event}
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
}
