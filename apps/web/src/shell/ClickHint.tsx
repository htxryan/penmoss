import { isApplePlatform } from '@penmoss/editor/keys';

/**
 * A menu item's click gesture, shown where a key's keycaps go (PEN-140, mockup ac2): Open in New
 * Tab is ⌘-Click and Open in New Window ⌥-Click (Ctrl-Click and Alt-Click elsewhere), in the
 * notebooks' tree too, where ⌘-click opens a tab unless several rows are picked (A1570). Hidden
 * from the item's name, as keycaps are.
 */
export function ClickHint({ modifier }: { modifier: 'mod' | 'alt' }) {
  const apple = isApplePlatform();
  const key = modifier === 'mod' ? (apple ? '⌘' : 'Ctrl') : apple ? '⌥' : 'Alt';
  return (
    <span className="menu-keys" aria-hidden="true" data-testid="menu-click-hint">
      {key}-Click
    </span>
  );
}
