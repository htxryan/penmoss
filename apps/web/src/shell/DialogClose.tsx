import { Icon } from '@penmoss/ui/icons';

/**
 * The close button of an overlay dialog (T39): the palette, search and the
 * theme picker had only Escape and a click outside, neither of which a phone
 * has in reach (the dialog fills the screen there).
 */
export function DialogClose({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn dlg-close"
      data-ui="dismiss"
      aria-label={label}
      data-tip={`${label} (Esc)`}
      onClick={onClose}
    >
      <Icon name="close" />
    </button>
  );
}
