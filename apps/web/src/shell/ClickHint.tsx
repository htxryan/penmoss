import { isApplePlatform } from '@penmoss/editor/keys';

/**
 * A menu item's click gesture, shown where a key's keycaps go (PEN-140, mockup ac2): Open in New
 * Tab is ⌘-Click and Open in New Window ⌥-Click (Ctrl-Click and Alt-Click elsewhere). In the
 * notebooks' tree ⌘-click picks one more row (A570), so its Open in New Tab shows Middle-Click,
 * the gesture that does open a tab there (A1498). Hidden from the item's name, as keycaps are.
 */
export function ClickHint({ modifier }: { modifier: 'mod' | 'alt' | 'middle' }) {
  const apple = isApplePlatform();
  const key =
    modifier === 'middle'
      ? 'Middle'
      : modifier === 'mod'
        ? apple
          ? '⌘'
          : 'Ctrl'
        : apple
          ? '⌥'
          : 'Alt';
  return (
    <span className="menu-keys" aria-hidden="true" data-testid="menu-click-hint">
      {key}-Click
    </span>
  );
}
