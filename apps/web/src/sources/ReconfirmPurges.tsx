/** A notebook page's Delete for Good confirmations that ran out before their sync (GitNotebooksSettings.tsx). */
import { Icon } from '@penmoss/ui/icons';
import { useState } from 'react';
import { type GitPendingPurge } from '../desktop/bridge';
import type { GitSource } from './git-source';
import { ConfirmBlock } from '../shell/ConfirmBlock';
import { counted } from '@penmoss/core/words';

/**
 * Delete for good whose confirmation ran out before its sync (A855): first the notes it would
 * take, named by main from the branch, then one Touch ID for those this Mac confirmed once
 * already. A note never confirmed here (a page script marked it) is listed apart and never sent
 * in that list (main would refuse it): Keep note takes the mark back, deleting nothing (Undo marks
 * it again), and Delete for good asks Touch ID for that note, named by main from the branch.
 */
export function ReconfirmPurges({
  source,
  onDone,
}: {
  source: GitSource;
  onDone: (message: string) => void;
}) {
  const [notes, setNotes] = useState<readonly GitPendingPurge[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** Notes kept here (Keep note), each with its Undo until the panel closes. */
  const [kept, setKept] = useState<readonly GitPendingPurge[]>([]);
  const title = (note: GitPendingPurge) => note.title.trim() || 'Untitled';
  if (notes === null) {
    return (
      <button
        data-event="settings.git-notebooks.reconfirm.open"
        data-ui="item"
        type="button"
        className="btn"
        data-testid="git-reconfirm-purges"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void source
            .purgesToConfirm()
            .then((listed) => {
              if (listed) setNotes(listed);
              else onDone('This window cannot change git notebooks.');
            })
            .finally(() => setBusy(false));
        }}
      >
        Confirm Delete for Good Again…
      </button>
    );
  }
  const again = notes.filter((note) => note.confirmedBefore);
  const never = notes.filter(
    (note) => !note.confirmedBefore && !kept.some((one) => one.id === note.id),
  );
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };
  return (
    <ConfirmBlock className="git-reconfirm" title="Delete for Good?" testId="git-reconfirm-panel">
      {again.length > 0 ? (
        <>
          <p>
            {again.length === 1 ? 'This note goes' : `These ${again.length} notes go`} for good at
            this sync (git history keeps {again.length === 1 ? 'it' : 'them'}). You confirmed{' '}
            {again.length === 1 ? 'it' : 'them'} once already; the confirmation ran out before the
            sync.
          </p>
          <ul data-testid="git-reconfirm-notes">
            {again.map((note) => (
              <li key={note.id}>{title(note)}</li>
            ))}
          </ul>
        </>
      ) : never.length === 0 && kept.length === 0 ? (
        <p>Nothing here to confirm again.</p>
      ) : null}
      {never.length > 0 ? (
        <>
          <p>
            Marked deleted for good but never confirmed on this Mac, so the sync stays stopped until
            each is kept or confirmed. Keep note puts it back where it was and deletes nothing.
          </p>
          <ul data-testid="git-reconfirm-never">
            {never.map((note) => (
              <li key={note.id} data-testid="git-never-note">
                <span>{title(note)}</span>{' '}
                <button
                  data-event="settings.git-notebooks.reconfirm.keep-note"
                  data-ui="item"
                  type="button"
                  className="btn"
                  data-testid="git-keep-note"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const refused = await source.keepNote(note.id);
                      if (refused) {
                        setNotes((list) => (list ?? []).filter((one) => one.id !== note.id));
                        onDone(refused);
                        return;
                      }
                      setKept((list) => [...list, note]);
                    })
                  }
                >
                  Keep Note
                </button>{' '}
                <button
                  data-event="settings.git-notebooks.reconfirm.purge-note"
                  data-ui="item"
                  type="button"
                  className="btn"
                  data-testid="git-purge-note"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const refused = await source.confirmPurge(note.id);
                      if (refused) {
                        onDone(refused);
                        return;
                      }
                      setNotes((list) => (list ?? []).filter((one) => one.id !== note.id));
                      onDone('Confirmed: Delete for good goes at this sync.');
                    })
                  }
                >
                  <Icon name="key" size={14} />
                  {/* No "…": Trash's and Android's are "Delete for Good" too (T39 pass 3, A894). */}
                  Delete for Good
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {kept.length > 0 ? (
        <ul data-testid="git-kept-notes">
          {kept.map((note) => (
            <li key={note.id}>
              Kept {title(note)}.{' '}
              <button
                data-event="settings.git-notebooks.reconfirm.undo-keep"
                data-ui="item"
                type="button"
                className="btn"
                data-testid="git-keep-undo"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await source.undoKeep(note.id);
                    setKept((list) => list.filter((one) => one.id !== note.id));
                  })
                }
              >
                Undo
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="settings-actions">
        {again.length > 0 ? (
          <button
            data-event="settings.git-notebooks.reconfirm.confirm"
            data-ui="item"
            type="button"
            className="btn"
            data-testid="git-reconfirm-confirm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void source
                .reconfirmPurges(again.map((note) => note.id))
                .then((refused) => {
                  setNotes(null);
                  onDone(refused ?? 'Confirmed: Delete for good goes at this sync.');
                })
                .finally(() => setBusy(false));
            }}
          >
            <Icon name="key" size={14} />
            Confirm {counted(again.length, 'Note')} with Touch ID
          </button>
        ) : null}
        <button
          data-event="settings.git-notebooks.reconfirm.cancel"
          data-ui="item"
          type="button"
          className="btn"
          data-testid="git-reconfirm-cancel"
          disabled={busy}
          onClick={() => {
            setNotes(null);
            setKept([]);
          }}
        >
          {kept.length > 0 ? 'Done' : 'Cancel'}
        </button>
      </div>
    </ConfirmBlock>
  );
}
