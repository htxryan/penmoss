import type { KeyboardEvent, ReactNode, Ref } from 'react';

/**
 * A modal dialog over the page (the pickers, Capture, the cheat sheet, a preview's zoom): the
 * scrim, and the dialog on it. A press on the scrim closes it. With `onEscape`, an Escape inside
 * it is taken (its default prevented) and handed over; without, the dialog's own parts take it.
 */
export function ModalOverlay({
  testId,
  className,
  overlayClassName,
  label,
  labelledBy,
  dialogTestId,
  dialogRef,
  onClose,
  onEscape,
  children,
}: {
  /** The scrim's test id. */
  readonly testId: string;
  /** The dialog's classes besides `dialog`. */
  readonly className: string;
  /** The scrim's classes besides `overlay`. */
  readonly overlayClassName?: string;
  readonly label?: string;
  readonly labelledBy?: string;
  readonly dialogTestId?: string;
  readonly dialogRef?: Ref<HTMLDivElement>;
  readonly onClose: () => void;
  readonly onEscape?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={overlayClassName ? `overlay ${overlayClassName}` : 'overlay'}
      data-testid={testId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={
        onEscape
          ? (event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              onEscape(event);
            }
          : undefined
      }
    >
      <div
        ref={dialogRef}
        className={`dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        data-testid={dialogTestId}
      >
        {children}
      </div>
    </div>
  );
}
