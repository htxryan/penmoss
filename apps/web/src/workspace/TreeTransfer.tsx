/**
 * Moving and copying to another open notebook from the folder tree (T68, #230): the menu items,
 * for one item or several, and the picker of the other notebooks' folders.
 */
import { useMemo, useState } from 'react';
import { MenuItem } from '../shell/Menu';
import type { Source } from '../sources/registry';
import { useCopyTagsDefault } from './copy-tags-state';
import { FolderPicker } from './FolderPicker';
import { folderChoices, type ItemRef } from './model';
import { folderTreeOf } from './tree';

/** Moving or copying to another open notebook (T68, #230): what, and which way. */
export interface Transferring {
  readonly items: readonly ItemRef[];
  readonly mode: 'move' | 'copy';
  readonly rowKey: string;
}

/** The other notebook's folder chosen in the picker: its source's id, then the folder's. */
const choiceKey = (sourceId: string, folderId: string | null) =>
  `${sourceId}\u0000${folderId ?? ''}`;

/** Move to Notebook… and Copy to Notebook… (T68, #230), for one item or several. */
export function TransferButtons({
  noun,
  onTransfer,
}: {
  /** "3 Notes", "4 Items"; null for one note or folder. */
  noun: string | null;
  onTransfer: (mode: 'move' | 'copy') => void;
}) {
  return (
    <>
      <MenuItem
        icon="notebook"
        data-testid="menu-move-to-notebook"
        onClick={() => onTransfer('move')}
      >
        {noun ? `Move ${noun} to Notebook…` : 'Move to Notebook…'}
      </MenuItem>
      <MenuItem icon="copy" data-testid="menu-copy-to-notebook" onClick={() => onTransfer('copy')}>
        {noun ? `Copy ${noun} to Notebook…` : 'Copy to Notebook…'}
      </MenuItem>
    </>
  );
}

/** The menu on folders and notes picked together (T68, #230). */
export function TransferMenuItems({
  items,
  canTransfer,
  onTransfer,
}: {
  items: readonly ItemRef[];
  canTransfer: boolean;
  onTransfer: (items: readonly ItemRef[], mode: 'move' | 'copy') => void;
}) {
  if (!canTransfer) {
    return (
      <MenuItem icon="notebook" disabled>
        Open another notebook to move these to
      </MenuItem>
    );
  }
  return (
    <TransferButtons
      noun={`${items.length} Items`}
      onTransfer={(mode) => onTransfer(items, mode)}
    />
  );
}

/**
 * Where in another open notebook (T68, #230): the folder picker over every other notebook's top
 * level and folders, each path starting with the notebook's name.
 */
export function TransferPicker({
  job,
  others,
  title,
  onChoose,
  onClose,
}: {
  job: Transferring;
  others: readonly Source[];
  title: string;
  onChoose: (target: Source, folderId: string | null, tags: boolean) => void;
  onClose: () => void;
}) {
  // A copy asks whether the tags go too (A1353), ticked as Settings → Notebooks says. A
  // move always takes them: the notes leave this notebook.
  const copying = job.mode === 'copy';
  const { copies } = useCopyTagsDefault();
  const [tags, setTags] = useState(copies);
  const choices = useMemo(
    () =>
      others.flatMap((other) =>
        folderChoices(folderTreeOf(other.workspace.getState().snapshot, []).tree).map((choice) => ({
          ...choice,
          id: choiceKey(other.id, choice.id),
          name: choice.id === null ? other.name : choice.name,
          path: choice.id === null ? other.name : `${other.name} / ${choice.path}`,
        })),
      ),
    [others],
  );
  const verb = job.mode === 'move' ? 'Move' : 'Copy';
  return (
    <FolderPicker
      title={title}
      count={job.items.length}
      label={`${verb} “${title}” to another notebook`}
      placeholder={`${verb} to notebook…`}
      action={`${verb} here`}
      choices={choices}
      currentId={undefined}
      onChoose={(key) => {
        const [sourceId, folderId] = (key ?? '').split('\u0000');
        const target = others.find((other) => other.id === sourceId);
        if (target) onChoose(target, folderId ? folderId : null, copying ? tags : true);
      }}
      onClose={onClose}
      options={
        copying ? (
          <label className="display-toggle">
            <input
              type="checkbox"
              checked={tags}
              data-testid="copy-tags"
              onChange={(event) => setTags(event.target.checked)}
            />
            <span>Copy Tags</span>
          </label>
        ) : undefined
      }
    />
  );
}
