import { Icon, type IconName } from '@penmoss/ui/icons';
import type { MutableRefObject, ReactNode } from 'react';
import { ConfirmDialog } from '../shell/ConfirmDialog';

/**
 * One flow for describing many things at once (PEN-161's Describe Notes Now, A1677's Generate All
 * Tag Descriptions): it asks first, saying how many, then works through them with a progress bar
 * and what it is on, Stop while it runs, and Close once done. The caller counts, starts the work
 * and says what is asked; this draws the rest the same way for both.
 */
export function BatchDialog({
  title,
  testId,
  dialog,
  total,
  done,
  stop,
  startLabel,
  startIcon,
  progress,
  events,
  onStart,
  onClose,
  after,
  children,
}: {
  readonly title: string;
  /** Its own test id; its progress line is `<testId>-progress`. */
  readonly testId: string;
  /** Its name in usage analytics (ConfirmDialog's `dialog`). */
  readonly dialog?: string;
  /** How many there are to do; null while they are being counted. */
  readonly total: number | null;
  /** How many are done; null until it starts. */
  readonly done: number | null;
  /** The running batch's controller, aborted by Stop and by closing. */
  readonly stop: MutableRefObject<AbortController | null>;
  /** The start button's words for `total` (Describe 3 Notes, Generate 3 Descriptions). */
  readonly startLabel: string;
  readonly startIcon?: IconName;
  /** The progress bar's name, and the line under it as it runs and once done. */
  readonly progress: {
    readonly label: string;
    readonly running: (at: number, total: number) => string;
    readonly finished: (done: number, total: number) => string;
  };
  /** The buttons' tracked ids (PEN-137). */
  readonly events: { readonly stop: string; readonly cancel: string; readonly start: string };
  readonly onStart: () => void;
  readonly onClose: () => void;
  /** Under the progress once it has started (a count of the ones that failed). */
  readonly after?: ReactNode;
  /** What is asked: the count, and any choice before it starts. */
  readonly children: ReactNode;
}) {
  // Stop closes the dialog, so a stopped batch is never shown running.
  const running = done !== null && total !== null && done < total;
  const finished = done !== null && total !== null && done >= total;
  const close = () => {
    stop.current?.abort();
    onClose();
  };
  return (
    <ConfirmDialog
      title={title}
      testId={testId}
      dialog={dialog}
      onCancel={close}
      onSubmit={() => (finished ? onClose() : onStart())}
    >
      {children}
      {done !== null && total !== null && total > 0 ? (
        <>
          <progress className="ai-progress" max={total} value={done} aria-label={progress.label} />
          <p className="muted" role="status" data-testid={`${testId}-progress`}>
            {finished ? progress.finished(done, total) : progress.running(done + 1, total)}
          </p>
          {after}
        </>
      ) : null}
      <div className="confirm-actions">
        {running ? (
          <button
            data-ui="dismiss"
            type="button"
            className="btn"
            data-event={events.stop}
            onClick={close}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            data-ui="dismiss"
            data-event={events.cancel}
            onClick={onClose}
            autoFocus
          >
            {finished ? 'Close' : 'Cancel'}
          </button>
        )}
        {!finished && !running ? (
          <button
            type="submit"
            className="btn primary"
            data-ui="submit"
            data-event={events.start}
            disabled={!total}
          >
            {startIcon ? <Icon name={startIcon} size={14} /> : null}
            {startLabel}
          </button>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
