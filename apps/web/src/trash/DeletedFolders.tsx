import { Icon } from '@penmoss/ui/icons';
import { FOLDER_TRASH_DAYS, type TrashedFolder } from '@penmoss/sync-client/workspace';
import { useState } from 'react';
import { useNotes } from '../notes/hooks';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import { folderContents, restoredMessage } from './deleted-folders';
import { DeletedByChip } from './DeletedByChip';

const DAY_MS = 24 * 60 * 60 * 1000;

const deletedOn = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * The deleted folders in Trash (T42, A560): each with what it held, who deleted it (an agent by
 * name) and its days left. Restore brings it back with its subfolders, into the folder it was
 * in, and puts back each note still where the delete left it.
 */
export function DeletedFolderList({
  folders,
  now,
  busy,
  folderName,
  onRestore,
}: {
  readonly folders: readonly TrashedFolder[];
  readonly now: number;
  readonly busy: boolean;
  readonly folderName: (id: string | null) => string;
  readonly onRestore: (folder: TrashedFolder) => void;
}) {
  if (folders.length === 0) return null;
  return (
    <ul className="trash-list" aria-label="Deleted folders" data-testid="trash-folders">
      {folders.map((folder) => {
        const left = Math.max(
          0,
          Math.ceil((folder.deletedAt + FOLDER_TRASH_DAYS * DAY_MS - now) / DAY_MS),
        );
        return (
          <li
            key={folder.id}
            className="trash-item"
            data-folder-id={folder.id}
            data-notebook={folder.notebook ? '' : undefined}
          >
            <div className="trash-info">
              <Icon name={folder.notebook ? 'notebook' : 'folder'} />
              <span className="trash-title">
                {folder.name}
                {folder.notebook ? <span className="muted"> · Notebook</span> : null}
              </span>
              <span className="muted">
                {folderContents(folder)} · Deleted {deletedOn(folder.deletedAt)} from{' '}
                {folderName(folder.parentId)}
                {folder.deletedBy ? (
                  <>
                    {' by '}
                    <DeletedByChip by={folder.deletedBy} />
                  </>
                ) : null}{' '}
                · {left} {left === 1 ? 'day' : 'days'} left
              </span>
            </div>
            <div className="trash-actions">
              <button
                type="button"
                className="btn"
                data-ui="item"
                disabled={busy}
                aria-label={`Restore the ${folder.notebook ? 'notebook' : 'folder'} ${folder.name}`}
                onClick={() => onRestore(folder)}
              >
                <Icon name="undo" />
                Restore
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Trash's folders, read from the workspace document (so offline too), and their Restore. */
export function DeletedFolders({ onStatus }: { readonly onStatus: (text: string) => void }) {
  const workspace = useWorkspace();
  const notes = useNotes();
  // Re-read on every change of the document, as the tree is.
  const { snapshot } = useWorkspaceState();
  const [now] = useState(() => Date.now());
  const folders = workspace.folderTrash();
  const folderName = (id: string | null) =>
    id === null
      ? 'the top level'
      : `“${snapshot.folders.find((folder) => folder.id === id)?.name ?? 'a deleted folder'}”`;
  return (
    <DeletedFolderList
      folders={folders}
      now={now}
      busy={false}
      folderName={folderName}
      onRestore={(folder) => {
        const result = workspace.restoreFolder(folder.id);
        onStatus(restoredMessage(folder.name, result));
        // A notebook's notes come out of Trash with it (T43, A755), here and on the server.
        for (const id of result.filed) {
          void notes.restoreFromTrash(id).catch(() => {
            // Offline with no copy here: the server restores it once the workspace syncs.
          });
        }
      }}
    />
  );
}
