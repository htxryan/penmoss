import { Icon } from '@penmoss/ui/icons';
import type { Ref } from 'react';

/**
 * The close button of an overlay dialog (T39): the palette, search and the
 * theme picker had only Escape and a click outside, neither of which a phone
 * has in reach (the dialog fills the screen there). Every dialog, sheet, panel
 * and popover Escape closes uses it: its name says what it closes, and its
 * tooltip adds (Esc) (ux-conventions, Interaction).
 */
export function DialogClose({
  label,
  onClose,
  event = 'dialog.close',
  testId,
  size = 16,
  className,
  ref,
}: {
  label: string;
  onClose: () => void;
  /** Its `data-event`, when the dialog has its own. */
  event?: string;
  testId?: string;
  /** The icon's size, in px. */
  size?: number;
  /** A class beside its own, to place it. */
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={className ? `icon-btn dlg-close ${className}` : 'icon-btn dlg-close'}
      data-ui="dismiss"
      data-event={event}
      aria-label={label}
      data-tip={`${label} (Esc)`}
      onClick={onClose}
      data-testid={testId}
    >
      <Icon name="close" size={size} />
    </button>
  );
}
