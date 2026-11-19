import { Icon } from '@penmoss/ui/icons';
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { fuzzyMatch, highlightRuns } from '@penmoss/core/fuzzy';
import { DialogClose } from '../shell/DialogClose';
import { PickerField, PickerListbox, PickerOverlay } from '../shell/picker';
import { usePickerList } from '../shell/picker-list';
import type { FolderChoice } from './model';
import { useTrackedDialog } from '../analytics/dialog';

export interface FolderPickerProps {
  /** The note's title, for the dialog's name ("3 notes" for several). */
  readonly title: string;
  /** How many notes move (T42, A570): one dialog for every selected note. */
  readonly count?: number;
  readonly choices: readonly FolderChoice[];
  /** Where the notes are now (null: the top level; undefined: several places). */
  readonly currentId: string | null | undefined;
  readonly onChoose: (folderId: string | null) => void;
  readonly onClose: () => void;
  /** The dialog's name when it is not a move to a folder (T68: to another notebook). */
  readonly label?: string;
  /** The search field's hint and Enter's action (T68: "Copy to…", "Copy here"). */
  readonly placeholder?: string;
  readonly action?: string;
  /** Options at the dialog's foot, over its keys (A1353: Copy to Notebook's Copy Tags). */
  readonly options?: ReactNode;
}

/**
 * "Move to folder…" (T39): the palette's combobox over the top level and
 * every folder, indented as in the tree and found by path ("work deep").
 * Before it, a note changed folders only by dragging it in the tree, which
 * neither the keyboard nor a phone's touch could do.
 */
export function FolderPicker({
  title,
  count = 1,
  choices,
  currentId,
  onChoose,
  onClose,
  label: named,
  placeholder = 'Move to folder…',
  action = 'Move here',
  options,
}: FolderPickerProps) {
  const tracked = useTrackedDialog('folderPicker');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      choices.findIndex((choice) => choice.id === currentId),
    ),
  );

  const items = useMemo(() => {
    const q = query.trim();
    return choices.flatMap((choice) => {
      if (!q) return [{ choice, indices: [] as readonly number[], filtered: false }];
      const match = fuzzyMatch(q, choice.path, { scattered: false });
      return match ? [{ choice, indices: match.indices, filtered: true }] : [];
    });
  }, [choices, query]);

  const choose = (choice: FolderChoice | undefined) => {
    if (!choice) return;
    tracked.done();
    onChoose(choice.id);
  };
  const picker = usePickerList({
    items,
    active,
    setActive,
    onChoose: (index) => choose(items[index]?.choice),
    onClose,
  });

  const label =
    named ??
    (count === 1 ? `Move “${title || 'Untitled'}” to a folder` : `Move ${count} notes to a folder`);
  return (
    <PickerOverlay
      testId="folder-picker"
      className="palette folder-picker"
      label={label}
      onClose={onClose}
    >
      <div className="dlg-search">
        <PickerField
          picker={picker}
          aria-label="Folder"
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <DialogClose label="Close the Folder Picker" onClose={onClose} />
      </div>
      <PickerListbox picker={picker} label="Folders">
        {items.length === 0 ? (
          <p className="dlg-empty" role="status">
            No folder matches “{query}”
          </p>
        ) : (
          items.map(({ choice, indices, filtered }, index) => (
            <div
              key={choice.id ?? 'top'}
              {...picker.optionProps(index)}
              className="opt folder-opt"
              aria-current={choice.id === currentId ? 'location' : undefined}
              // Indented by depth as in the tree, capped in CSS (six levels on a phone, A363).
              style={filtered ? undefined : ({ '--depth': choice.depth } as CSSProperties)}
              onClick={() => choose(choice)}
            >
              <span className="oic" aria-hidden="true">
                <Icon name={choice.id === null ? 'list' : 'folder'} size={14} />
              </span>
              <span className="ot">
                {/* Filtered, a folder shows its path, so two "Notes" folders differ. */}
                {(filtered
                  ? highlightRuns(choice.path, indices)
                  : [{ text: choice.name, match: false }]
                ).map((run, i) =>
                  run.match ? <b key={i}>{run.text}</b> : <span key={i}>{run.text}</span>,
                )}
              </span>
              <span className="os">
                {choice.id === currentId ? (
                  <>
                    <span className="sr-only">Here now</span>
                    <Icon name="check" size={14} />
                  </>
                ) : null}
              </span>
            </div>
          ))
        )}
      </PickerListbox>
      {options ? (
        // Pressing one keeps the focus in the search field, so Enter still chooses.
        <div className="dlg-options" onMouseDown={(event) => event.preventDefault()}>
          {options}
        </div>
      ) : null}
      <div className="dlg-foot" aria-hidden="true">
        <span className="keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
        </span>
        Choose
        <span className="keys">
          <kbd>↵</kbd>
        </span>
        {action}
        <span className="grow" />
        <span className="keys">
          <kbd>Esc</kbd>
        </span>
        Cancel
      </div>
    </PickerOverlay>
  );
}
