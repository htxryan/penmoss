import { isApplePlatform } from '@penmoss/editor/keys';
import { MenuItem } from './Menu';

/**
 * A menu item's click gesture, shown where a key's keycaps go (PEN-140, mockup ac2): Open in New
 * Tab is ⌘-Click and Open in New Window ⌥-Click (Ctrl-Click and Alt-Click elsewhere), in the
 * notebooks' tree too, where ⌘-click opens a tab unless several rows are picked (A1570). Hidden
 * from the item's name, as keycaps are.
 */
function ClickHint({ modifier }: { modifier: 'mod' | 'alt' }) {
  const apple = isApplePlatform();
  const key = modifier === 'mod' ? (apple ? '⌘' : 'Ctrl') : apple ? '⌥' : 'Alt';
  return (
    <span className="menu-keys" aria-hidden="true" data-testid="menu-click-hint">
      {key}-Click
    </span>
  );
}

/**
 * The open group that leads a sidebar note's context menu, with a separator under it (Ryan,
 * A1571): Open in New Tab (where the window has tabs) and Open in New Window, each with its
 * click. The folder tree and Quick Access both show it; the caller closes its menu in each.
 */
export function OpenNoteItems({
  testIdPrefix,
  onTab,
  onWindow,
}: {
  /** `note` in the tree, `quick-access` in Quick Access: `<prefix>-open-tab`, `-open-window`. */
  readonly testIdPrefix: string;
  /** A new tab behind this one; null in a window with no tabs. */
  readonly onTab: (() => void) | null;
  /** A note window (T45); a browser opens one window per click. */
  readonly onWindow: () => void;
}) {
  return (
    <>
      {onTab ? (
        <MenuItem
          icon="plus"
          data-testid={`${testIdPrefix}-open-tab`}
          data-event="note.menu.open-tab"
          hint={<ClickHint modifier="mod" />}
          onClick={onTab}
        >
          Open in New Tab
        </MenuItem>
      ) : null}
      <MenuItem
        icon="windowNew"
        data-testid={`${testIdPrefix}-open-window`}
        data-event="note.menu.open-window"
        hint={<ClickHint modifier="alt" />}
        onClick={onWindow}
      >
        Open in New Window
      </MenuItem>
      <div className="menu-sep" role="separator" />
    </>
  );
}
