import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useTrackedDialog } from '../analytics/dialog';

/**
 * A modal confirm (`dialog.confirm`), open while mounted: a native `<dialog>` shown with
 * `showModal`, whose form submits to `onSubmit`; Escape cancels. Its body and buttons are the
 * caller's (a `.confirm-actions` row, Cancel first, the action as the form's submit).
 */
export function ConfirmDialog({
  title,
  testId,
  className = 'confirm',
  dialog = 'confirm',
  onCancel,
  onSubmit,
  children,
}: {
  readonly title: ReactNode;
  readonly testId?: string;
  /** `confirm` and any classes of its own (the Tags dialogs' `tags-dialog`). */
  readonly className?: string;
  /** Its name in usage analytics (PEN-137): `confirm`, unless the catalogue has one of its own. */
  readonly dialog?: string;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const tracked = useTrackedDialog(dialog);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          tracked.done();
          onSubmit();
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </form>
    </dialog>
  );
}
