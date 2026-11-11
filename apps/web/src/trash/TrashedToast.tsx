import { Icon } from '@penmoss/ui/icons';
import { useEffect, useRef, useState } from 'react';
import { navigate, notePath } from '../router';
import {
  TRASHED_MS,
  trashedNote,
  trashedText,
  trashedTitle,
  undoFailedText,
  undoTrash,
  useTrashedNote,
  type Trashed,
} from './trashed';
import { ToastSlot } from '../toasts/ToastSlot';

/**
 * "Moved “…” to Trash" with Undo (T39 pass 2, A524). A note moved to Trash by mistake (the
 * button sits beside the Info panel's) came back only from the Trash page. Focus moves to
 * Undo, as the note it was in has closed; when the toast goes, focus goes to the main
 * column rather than the page body, and after Undo to the restored note's body. The toast
 * waits while it is pointed at or focused, so a keyboard user has no time limit.
 */
export function TrashedToast() {
  const trashed = useTrashedNote();
  const toast = useRef<HTMLDivElement>(null);
  // In the window's stack (PEN-63), Undo exists once the stack has made room for it.
  const [undo, setUndo] = useState<HTMLButtonElement | null>(null);
  const [held, setHeld] = useState(false);
  /** Why Undo failed, for what is still in Trash (the toast offers Undo for those again). */
  const [failed, setFailed] = useState<{ readonly for: Trashed; readonly message: string } | null>(
    null,
  );

  useEffect(() => {
    if (trashed) undo?.focus();
  }, [trashed, undo]);

  // Counted from when the toast is shown and neither pointed at nor focused; renders in
  // between do not restart it.
  useEffect(() => {
    if (!trashed || held) return;
    const timer = setTimeout(() => {
      if (trashedNote.get() === trashed) trashedNote.set(null);
    }, TRASHED_MS);
    return () => clearTimeout(timer);
  }, [trashed, held]);

  function dismiss() {
    // Undo or the close button: whichever of the toast's controls has focus.
    const hadFocus = toast.current?.contains(document.activeElement) ?? false;
    trashedNote.set(null);
    setHeld(false);
    if (hadFocus) document.querySelector<HTMLElement>('.note-main')?.focus();
  }

  const restore = async () => {
    if (!trashed) return;
    // The move to Trash may still be under way (a note not open here is updated in storage);
    // undoTrash waits for it, as a restore before it ends would be undone by it.
    // In the source that trashed them, never the one in view now (A826).
    const source = trashed.from;
    const outcome = await undoTrash(trashed, (id) => source.restoreFromTrash(id));
    if (outcome.failed.length > 0) {
      // What is still in Trash stays offered, with why (review S2).
      const left: Trashed = {
        notes: outcome.failed.map(({ id, title }) => ({ id, title })),
        done: Promise.resolve(outcome.failed.map(({ id }) => id)),
        from: source,
      };
      setFailed({ for: left, message: undoFailedText(outcome) });
      trashedNote.set(left);
      return;
    }
    trashedNote.set(null);
    setHeld(false);
    const first = trashed.notes[0]?.id;
    if (trashed.notes.length === 1 && first) {
      // The toast held focus and is gone: the note's body takes it, as when it was open.
      source.requestBodyFocus(first);
      navigate(notePath(first));
    } else {
      // Several, from the tree: they are back in it; focus goes to the main column.
      document.querySelector<HTMLElement>('.note-main')?.focus();
    }
  };

  return (
    <ToastSlot>
      {trashed ? (
        <div
          ref={toast}
          className="toast toast-with-action"
          data-tone="info"
          data-testid="trashed-toast"
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              dismiss();
            }
          }}
        >
          <Icon name="trash" />
          <span>
            {failed?.for === trashed ? (
              failed.message
            ) : trashed.notes.length === 1 ? (
              <>
                Moved “
                <bdi data-testid="trashed-title">{trashedTitle(trashed.notes[0]!.title)}</bdi>” to
                Trash
              </>
            ) : (
              trashedText(trashed.notes.map((note) => note.title))
            )}
          </span>
          <button
            ref={setUndo}
            type="button"
            className="toast-action"
            data-ui="submit"
            onClick={() => void restore()}
            data-testid="trashed-undo"
          >
            Undo
          </button>
          <button
            type="button"
            className="toast-close"
            data-ui="dismiss"
            aria-label="Dismiss"
            onClick={() => dismiss()}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : null}
    </ToastSlot>
  );
}
