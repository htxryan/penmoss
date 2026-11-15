import { Icon, type IconName } from '@penmoss/ui/icons';
import type { CSSProperties } from 'react';
import { glyphInk, useNotebookBadge, type NotebookBadgeValue } from './badge';
import type { Source } from './registry';

/**
 * The glyph's ink and size, inline on the glyph itself: the badge's own, whatever its row's state.
 * A selected row's rule for its icons (Settings' nav, `a[aria-current] .i { color: accent }`), a
 * menu's muted icons or a sheet's bigger ones reached the badge's icon and drew it in the accent
 * on the badge's colour, unreadable. An inline style beats every such rule.
 */
const GLYPH_INK: CSSProperties = { color: 'var(--nb-badge-ink)', opacity: 1 };

function glyphStyle(px: number): CSSProperties {
  return { ...GLYPH_INK, width: `${px}px`, height: `${px}px` };
}

/** The sizes a badge comes in (PEN-140): tabs and lists, the sidebar's row, Settings' heading. */
export type BadgeSize = 16 | 18 | 26;

/**
 * A notebook's badge drawn from its value: a square (A976) of its colour holding its glyph in
 * white or near-black, whichever reads at 4.5:1. Its accessible name is the notebook's, so a
 * screen reader hears "Personal", not "P"; `decorative` hides it where the name is beside it.
 */
export function BadgeView({
  badge,
  name,
  size = 16,
  decorative = false,
  className,
}: {
  readonly badge: NotebookBadgeValue;
  readonly name: string;
  readonly size?: BadgeSize;
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  const style = {
    '--nb-badge-bg': badge.color,
    '--nb-badge-ink': glyphInk(badge.color),
    '--nb-badge-size': `${size / 16}rem`,
  } as CSSProperties;
  const { glyph } = badge;
  const iconSize = Math.round(size * 0.72);
  return (
    <span
      className={className ? `nb-badge ${className}` : 'nb-badge'}
      style={style}
      data-testid="notebook-badge"
      data-size={size}
      data-glyph={`${glyph.kind}:${glyph.value}`}
      data-color={badge.color}
      data-kind={glyph.kind}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
    >
      {glyph.kind === 'icon' ? (
        <Icon
          name={glyph.value as IconName}
          size={iconSize}
          className="nb-badge-icon"
          style={glyphStyle(iconSize)}
        />
      ) : (
        // Drawn from the attribute, so the name beside it (a heading, a tab) keeps its own text.
        <span
          className="nb-badge-text"
          aria-hidden="true"
          data-text={glyph.value}
          style={GLYPH_INK}
        />
      )}
    </span>
  );
}

/** A notebook's badge, following its settings and name as they change. */
export function NotebookBadge({
  source,
  size = 16,
  decorative = false,
  className,
}: {
  readonly source: Source;
  readonly size?: BadgeSize;
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  const badge = useNotebookBadge(source);
  if (!badge) return null;
  return (
    <BadgeView
      badge={badge}
      name={source.name}
      size={size}
      decorative={decorative}
      {...(className ? { className } : {})}
    />
  );
}
