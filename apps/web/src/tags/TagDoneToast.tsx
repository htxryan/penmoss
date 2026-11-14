import { Icon } from '@penmoss/ui/icons';
import { useEffect, useState } from 'react';
import { showToast } from '../toasts/toasts';
import { ToastSlot } from '../toasts/ToastSlot';

/** What a rename, merge or delete on the Tags page did, with its Undo. */
export interface TagDone {
  /** `Renamed #a to #b in 3 notes.` */
  readonly text: string;
  /** Puts it back; resolves with the notes it changed. */
  readonly undo: () => Promise<number>;
}

/** How long the toast shows while neither pointed at nor focused. */
export const TAG_DONE_MS = 8000;

/**
 * A tag change's toast on the Tags page (finding 8 of Ryan's review of #192): what it did, with
 * Undo in place of a confirm before a rename. It waits while pointed at or focused, as Trash's
 * Undo does (A524), so a keyboard user has no time limit.
 */
export function TagDoneToast({
  done,
  onClose,
}: {
  readonly done: TagDone | null;
  readonly onClose: () => void;
}) {
  const [held, setHeld] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!done || held) return;
    const timer = setTimeout(onClose, TAG_DONE_MS);
    return () => clearTimeout(timer);
  }, [done, held, onClose]);

  const undo = async () => {
    if (!done) return;
    setBusy(true);
    try {
      const notes = await done.undo();
      showToast({
        text: `Undone: ${notes === 1 ? '1 note is' : `${notes} notes are`} as they were.`,
        tone: 'done',
        testId: 'tag-undone-toast',
      });
    } catch (caught) {
      showToast({
        text: `Could not undo: ${caught instanceof Error ? caught.message : String(caught)}`,
        tone: 'error',
      });
    } finally {
      setBusy(false);
      setHeld(false);
      onClose();
    }
  };

  return (
    <ToastSlot>
      {done ? (
        <div
          className="toast toast-with-action"
          data-tone="done"
          data-testid="tag-done-toast"
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onClose();
            }
          }}
        >
          <Icon name="check" className="toast-glyph" />
          <span className="toast-text">{done.text}</span>
          <button
            type="button"
            className="toast-action"
            data-ui="submit"
            disabled={busy}
            onClick={() => void undo()}
            data-testid="tag-undo"
          >
            Undo
          </button>
          <button
            type="button"
            className="toast-close"
            data-ui="dismiss"
            aria-label="Dismiss"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : null}
    </ToastSlot>
  );
}
