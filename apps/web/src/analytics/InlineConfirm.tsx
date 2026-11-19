/**
 * The app's inline confirmation (PEN-137, as CommentsPanel's Delete Thread asks): a block under
 * the control that asked, `role="alertdialog"`, its question a bold Title Case line that is also
 * its name, then a sentence, then Cancel (quiet) and the destructive action. Focus moves to
 * Cancel, and Escape cancels, so nothing is deleted by a stray key.
 */
import { useEffect, useRef } from 'react';
import { copy } from './status';

export function InlineConfirm({
  title,
  body,
  onCancel,
  onConfirm,
  cancelEvent,
  confirmEvent,
  testId,
}: {
  readonly title: string;
  readonly body: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  /** The buttons' tracked ids (the catalogue's click names). */
  readonly cancelEvent: string;
  readonly confirmEvent: string;
  readonly testId: string;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus({ preventScroll: true });
    cancel.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <div
      className="privacy-confirm"
      role="alertdialog"
      aria-label={title}
      data-testid={testId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p className="privacy-confirm-title">{title}</p>
      <p className="privacy-confirm-body">{body}</p>
      <span className="privacy-confirm-actions">
        <button
          ref={cancel}
          type="button"
          className="btn quiet"
          data-ui="dismiss"
          data-event={cancelEvent}
          data-testid={`${testId}-cancel`}
          onClick={onCancel}
        >
          {copy('confirm.cancel.button')}
        </button>
        <button
          type="button"
          className="btn danger"
          data-ui="submit"
          data-event={confirmEvent}
          data-testid={`${testId}-delete`}
          onClick={onConfirm}
        >
          {copy('confirm.delete.button')}
        </button>
      </span>
    </div>
  );
}
