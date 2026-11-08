import { Icon } from '@penmoss/ui/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNoteList, useNotes } from '../notes/hooks';
import { RestoreNeedsFolder, TRASH_DAYS, trashDaysLeft, type TrashEntry } from '../notes/service';
import { useIsGitSource } from '../sources/hooks';
import { navigate, notePath } from '../router';
import { FolderPicker } from '../workspace/FolderPicker';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import { folderChoices } from '../workspace/model';
import { useFolderTree } from '../workspace/tree';
import { restoredMessage } from './deleted-folders';
import { DeletedFolders } from './DeletedFolders';
import { deletedForGoodText } from './trashed';

const deletedOn = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Trash (T21): notes deleted in the last 30 days, newest first, from this
 * device's copies. Restore puts a note back in the folder it was deleted
 * from, with its id, so links to it still resolve; Delete for good removes it
 * from its git notebook, after Touch ID (D34, A828). Who deleted a note was
 * the server's to say, and went with it (T59, D49).
 */
export function TrashView() {
  const notes = useNotes();
  const list = useNoteList(); // re-read when local records change
  const { snapshot } = useWorkspaceState();
  const workspace = useWorkspace();
  const foldersInTrash = workspace.folderTrash().length;
  const [listed, setEntries] = useState<TrashEntry[]>(() => notes.localTrash());
  // A deleted notebook's notes come back with it (T43, A755): Trash lists the notebook only.
  // Read from the document again whenever it changes (`snapshot`).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const withNotebook = useMemo(() => workspace.notebookTrashNotes(), [workspace, snapshot]);
  const entries = useMemo(
    () =>
      withNotebook.size === 0 ? listed : listed.filter((entry) => !withNotebook.has(entry.id)),
    [listed, withNotebook],
  );
  const [confirming, setConfirming] = useState<string | null>(null);
  // A note with no safe place to come back to (T43 review B2): the person chooses.
  const [needsPlace, setNeedsPlace] = useState<{
    readonly id: string;
    readonly title: string;
    readonly notebook: { readonly id: string; readonly name: string } | null;
  } | null>(null);
  const [picking, setPicking] = useState<{ readonly id: string; readonly title: string } | null>(
    null,
  );
  const pickerTree = useFolderTree(picking !== null)?.tree ?? null;
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Days left are counted from the last time the list was read.
  const [now, setNow] = useState(() => Date.now());
  // A git notebook keeps a deleted note until it is deleted for good (A828).
  const git = useIsGitSource();

  const reload = useCallback(() => {
    void notes.trash().then((next) => {
      setNow(Date.now());
      setEntries(next);
    });
  }, [notes]);
  useEffect(() => {
    reload();
  }, [reload, list]);

  const folderName = (entry: TrashEntry) => {
    if (entry.folderId === undefined) return null;
    if (entry.folderId === null) return 'the top level';
    return (
      snapshot.folders.find((folder) => folder.id === entry.folderId)?.name ?? 'a deleted folder'
    );
  };

  const run = async (id: string, work: () => Promise<string>) => {
    setBusy(id);
    setStatus(null);
    try {
      setStatus(await work());
    } catch (error) {
      if (error instanceof RestoreNeedsFolder) {
        const title = entries.find((entry) => entry.id === id)?.title || 'Untitled';
        setNeedsPlace({ id, title, notebook: error.notebook });
      }
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
      setConfirming(null);
      reload();
    }
  };

  return (
    <section className="trash" aria-labelledby="trash-heading" data-testid="trash">
      <h2 id="trash-heading">Trash</h2>
      <p className="muted trash-lede">
        {git
          ? `Deleted notes stay here until you delete them for good; deleted folders, for ${TRASH_DAYS} days on this device.`
          : `Deleted notes and folders stay here for ${TRASH_DAYS} days, then they are deleted for good.`}
      </p>
      <p className="trash-status" role="status" data-testid="trash-status">
        {status}
      </p>
      <DeletedFolders onStatus={setStatus} />
      {entries.length === 0 && foldersInTrash > 0 ? null : entries.length === 0 ? (
        <div className="empty-state compact" data-testid="trash-empty">
          <span className="empty-icon" aria-hidden="true">
            <Icon name="trash" size={28} />
          </span>
          <h3>Trash is empty</h3>
          <p>Nothing has been deleted lately.</p>
        </div>
      ) : (
        <ul className="trash-list" aria-label="Deleted notes">
          {entries.map((entry) => {
            const left = trashDaysLeft(entry.deletedAt, now);
            const from = folderName(entry);
            const title = entry.title || 'Untitled';
            return (
              <li key={entry.id} className="trash-item" data-note-id={entry.id}>
                <div className="trash-info">
                  <Icon name="file" />
                  <span className="trash-title">{title}</span>
                  <span className="muted">
                    Deleted {deletedOn(entry.deletedAt)}
                    {from ? ` from ${from}` : ''}
                    {git
                      ? ' · kept until deleted for good'
                      : ` · ${left} ${left === 1 ? 'day' : 'days'} left`}
                  </span>
                </div>
                {confirming === entry.id ? (
                  <div
                    className="trash-actions"
                    role="group"
                    aria-label={`Delete ${title} for good?`}
                  >
                    <span className="trash-warning" data-testid="purge-warning">
                      {git
                        ? 'Delete for good? It leaves this notebook on every device; the repository’s git history still keeps its content.'
                        : 'Delete for good? This cannot be undone.'}
                    </span>
                    <button
                      type="button"
                      className="btn danger-fill"
                      data-ui="submit"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(entry.id, async () => {
                          await notes.purgeFromTrash(entry.id);
                          return deletedForGoodText(git ? entry.title : title, git);
                        })
                      }
                    >
                      <Icon name="trash" />
                      Delete for Good
                    </button>
                    <button
                      type="button"
                      className="btn quiet"
                      data-ui="dismiss"
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : needsPlace?.id === entry.id ? (
                  <div
                    className="trash-actions trash-needs-place"
                    role="group"
                    aria-label={`Where to restore ${title}`}
                    data-testid="restore-needs-folder"
                  >
                    {needsPlace.notebook &&
                    workspace
                      .folderTrash()
                      .some((folder) => folder.id === needsPlace.notebook!.id) ? (
                      <button
                        type="button"
                        className="btn"
                        data-ui="item"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(entry.id, async () => {
                            const notebook = needsPlace.notebook!;
                            const result = workspace.restoreFolder(notebook.id);
                            for (const id of result.filed) {
                              void notes.restoreFromTrash(id).catch(() => undefined);
                            }
                            setNeedsPlace(null);
                            await notes.restoreFromTrash(entry.id);
                            return `${restoredMessage(notebook.name, result)} Restored “${title}”.`;
                          })
                        }
                      >
                        <Icon name="undo" />
                        Restore the Notebook “{needsPlace.notebook.name}”
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn"
                      data-ui="item"
                      disabled={busy !== null}
                      onClick={() => setPicking({ id: entry.id, title })}
                    >
                      <Icon name="folder" />
                      Choose a Folder…
                    </button>
                    <button
                      type="button"
                      className="btn quiet"
                      data-ui="dismiss"
                      onClick={() => setNeedsPlace(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="trash-actions">
                    <button
                      type="button"
                      className="btn"
                      data-ui="item"
                      disabled={busy !== null}
                      aria-label={`Restore ${title}`}
                      onClick={() =>
                        void run(entry.id, async () => {
                          await notes.restoreFromTrash(entry.id);
                          navigate(notePath(entry.id));
                          return `Restored “${title}”.`;
                        })
                      }
                    >
                      <Icon name="undo" />
                      Restore
                    </button>
                    <button
                      type="button"
                      className="btn quiet danger"
                      data-ui="item"
                      disabled={busy !== null}
                      aria-label={`Delete ${title} for Good`}
                      onClick={() => setConfirming(entry.id)}
                    >
                      <Icon name="trash" />
                      Delete for Good
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {picking && pickerTree ? (
        <FolderPicker
          title={picking.title}
          choices={folderChoices(pickerTree)}
          currentId={undefined}
          onChoose={(folderId) => {
            const { id, title } = picking;
            setPicking(null);
            setNeedsPlace(null);
            void run(id, async () => {
              await notes.restoreFromTrash(id, { folderId });
              navigate(notePath(id));
              return `Restored “${title}”.`;
            });
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </section>
  );
}
