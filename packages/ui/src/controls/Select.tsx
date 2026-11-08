/**
 * The one select (T51 item 13, A941): a native `<select>`, so the keyboard, screen readers and
 * a phone's own picker all work as they do everywhere, drawn with one look. The look is the
 * stylesheet's `.pm-select` (apps/web/src/styles.css): the control height, padding, radius and
 * border of a text field, a chevron of its own instead of the platform's, the focus ring, the
 * disabled state, and the theme's colours in light and dark. Selects made outside React (the
 * editor's code-block language and callout type) take the same classes through `selectClass`.
 */
import type { ComponentPropsWithRef } from 'react';

/** `default` is a field's height (`--pm-control`); `small` sits in toolbars and filters. */
export type SelectSize = 'default' | 'small';

/**
 * `quiet` has no border or fill until it is hovered or focused, for a select inside something
 * that already has a frame (a code block's toolbar, a callout's title).
 */
export type SelectVariant = 'default' | 'quiet';

/** The classes for a select of this size and variant, then the caller's own. */
export function selectClass(
  size: SelectSize = 'default',
  variant: SelectVariant = 'default',
  className?: string,
): string {
  return [
    'pm-select',
    size === 'small' ? 'pm-select-sm' : null,
    variant === 'quiet' ? 'pm-select-quiet' : null,
    className || null,
  ]
    .filter(Boolean)
    .join(' ');
}

export interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'size'> {
  readonly size?: SelectSize;
  readonly variant?: SelectVariant;
}

export function Select({ size, variant, className, children, ...props }: SelectProps) {
  return (
    <select {...props} className={selectClass(size, variant, className)}>
      {children}
    </select>
  );
}
