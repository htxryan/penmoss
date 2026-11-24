import { REVEAL, hasTabs, notePath, openIntent, openPath } from '../router';
import { Menu, MenuItem } from '../shell/Menu';
import { useSidebarLayout } from '../shell/sidebar-layout-state';
import { displayTitle } from './list';
import { useQuickAccessNotes } from './quick-access';

/**
 * Quick Access on the collapsed sidebar (Quanta feedback, PEN-182): a pin in the rail, under the
 * shortcuts, that opens the pinned notes as a menu beside the rail, in pin order. Choosing one
 * opens it, as its row in the open sidebar does (⌘-click: a new tab behind this one). The menu
 * is the app's own (`Menu`), so its keys, Escape and focus are every menu's.
 */
export function QuickAccessFlyout() {
  const { quickAccessNotebook } = useSidebarLayout();
  const pinned = useQuickAccessNotes(quickAccessNotebook);
  return (
    <Menu
      label="Quick Access"
      icon="pin"
      iconSize={18}
      className="icon-btn sb-shortcut sb-quick-flyout"
      testId="quick-access-flyout"
      data-event="sidebar.quick-access.flyout"
    >
      {pinned.length === 0 ? (
        <MenuItem
          icon="pin"
          disabled
          data-event="sidebar.quick-access.flyout"
          data-testid="quick-access-flyout-empty"
        >
          No Pinned Notes
        </MenuItem>
      ) : (
        pinned.map((note) => (
          <MenuItem
            key={note.id}
            icon="file"
            data-event="sidebar.quick-access.note"
            data-testid="quick-access-flyout-note"
            data-note-id={note.id}
            hint={
              note.notebook !== null ? (
                <span className="menu-keys">{note.notebook}</span>
              ) : undefined
            }
            onClick={(event) => {
              const intent = hasTabs() ? openIntent(event) : null;
              openPath(
                notePath(note.id),
                intent === 'background' || intent === 'foreground' ? intent : 'current',
                REVEAL,
              );
            }}
          >
            {displayTitle(note.title)}
          </MenuItem>
        ))
      )}
    </Menu>
  );
}
