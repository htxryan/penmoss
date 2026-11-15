import { Icon, type IconName } from '@penmoss/ui/icons';
import type { CSSProperties } from 'react';
import { glyphInk, useNotebookBadge, type NotebookBadgeValue } from './badge';
import type { Source } from './registry';

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
        <Icon name={glyph.value as IconName} size={Math.round(size * 0.72)} />
      ) : (
        // Drawn from the attribute, so the name beside it (a heading, a tab) keeps its own text.
        <span className="nb-badge-text" aria-hidden="true" data-text={glyph.value} />
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
