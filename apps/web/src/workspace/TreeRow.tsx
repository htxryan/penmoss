/**
 * The folder tree's rows (T7): a folder, a note, the new folder's name field and an open empty
 * folder's "Empty". Each row is a WAI-ARIA treeitem keyed by `data-key`; the tree handles their
 * events once, on itself (FolderTree.tsx), and finds them with tree-dom.ts.
 */
import { Icon } from '@penmoss/ui/icons';
import { useRef, type CSSProperties } from 'react';
import { notePath } from '../router';
import { SORT_LABELS, type DropZone, type FolderRow, type NoteRow, type Row } from './model';

const depth = (level: number) => ({ '--depth': level - 1 }) as CSSProperties;

/** What every row has: where a drag would drop on it, and the tree's roving tab stop. */
export interface RowPlace {
  /** The drop hint on this row, if a drag is over it. */
  readonly drop: DropZone | undefined;
  /** The tree's one tab stop is this row. */
  readonly tabStop: boolean;
  /** False while a name is typed in the tree. */
  readonly draggable: boolean;
}

function rowAttributes(row: Row, place: RowPlace) {
  return {
    'data-key': row.key,
    'data-drop': place.drop,
    role: 'treeitem',
    'aria-level': row.level,
    'aria-setsize': row.setSize,
    'aria-posinset': row.posInSet,
    tabIndex: place.tabStop ? 0 : -1,
    draggable: place.draggable,
    style: depth(row.level),
  };
}

export function FolderTreeRow({
  row,
  place,
  picked,
  chosen,
  keyShortcuts,
  renaming,
  onRename,
  onCancelRename,
  onNewNote,
}: {
  row: FolderRow;
  place: RowPlace;
  /** Picked with Shift- or ⌘-click (T68, #230). */
  picked: boolean;
  /** The folder new notes and folders go into. */
  chosen: boolean;
  keyShortcuts: string;
  /** Its name is being edited in place. */
  renaming: boolean;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onNewNote: () => void;
}) {
  return (
    <div
      {...rowAttributes(row, place)}
      className="tree-row folder-row"
      data-event="tree.toggle"
      data-picked={picked ? '' : undefined}
      aria-label={row.name}
      aria-expanded={row.expanded}
      aria-selected={chosen}
      aria-keyshortcuts={keyShortcuts || undefined}
    >
      <span className="twisty" data-open={row.expanded} aria-hidden="true">
        <ChevronIcon />
      </span>
      <FolderIcon />
      {renaming ? (
        <NameInput
          label={`Rename folder ${row.name}`}
          initial={row.name}
          onCommit={onRename}
          onCancel={onCancelRename}
        />
      ) : (
        <span className="tree-label">{row.name}</span>
      )}
      {row.sortMode !== 'manual' && !renaming ? (
        <span className="sort-badge">{SORT_LABELS[row.sortMode]}</span>
      ) : null}
      {renaming ? null : (
        <span className="row-actions row-end">
          {/* A new note in it (T53 item 5), as its menu's New Note Here. Rename and Delete are
              in its menu only (Quanta feedback 2, A1120). */}
          <button
            type="button"
            tabIndex={-1}
            className="icon-btn"
            data-ui="item"
            data-event="tree.folder-row.new-note"
            aria-label={`New Note in ${row.name}`}
            data-tip="New Note Here"
            data-testid="folder-row-new-note"
            onClick={onNewNote}
          >
            <PlusIcon />
          </button>
        </span>
      )}
    </div>
  );
}

export function NoteTreeRow({
  row,
  place,
  selected,
  open,
  renaming,
  onRename,
  onCancelRename,
}: {
  row: NoteRow;
  place: RowPlace;
  selected: boolean;
  /** The open note. */
  open: boolean;
  /** Its title is being edited in place (T62 item 13). */
  renaming: boolean;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  return (
    <div
      {...rowAttributes(row, place)}
      className="tree-row note-row"
      data-event="tree.open"
      aria-label={row.title}
      aria-selected={selected}
      // No tooltip (A1119): the tree shows where the note is, and the time it was last edited
      // covered the rows below.
    >
      <span className="twisty" data-empty="" aria-hidden="true" />
      {renaming ? (
        <span className="tree-link">
          <NoteIcon />
          <NameInput
            label={`Rename note ${row.title}`}
            initial={row.untitled ? '' : row.title}
            placeholder="Untitled"
            onCommit={onRename}
            onCancel={onCancelRename}
          />
        </span>
      ) : (
        <a
          className="tree-link"
          href={notePath(row.id)}
          tabIndex={-1}
          draggable={false}
          aria-current={open ? 'page' : undefined}
          data-untracked="its row is the control, this link only names it"
          data-untitled={row.untitled ? '' : undefined}
        >
          <NoteIcon />
          <span className="tree-label">{row.title}</span>
        </a>
      )}
    </div>
  );
}

/** The new folder's row, its name typed in place, at `level`. */
export function NewFolderRow({
  level,
  onCommit,
  onCancel,
}: {
  level: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-selected={false}
      className="tree-row draft-row"
      data-untracked="a draft row, its name field is what you use"
      style={depth(level)}
    >
      <span className="twisty" data-empty="" aria-hidden="true" />
      <FolderIcon />
      <NameInput label="New folder name" initial="" onCommit={onCommit} onCancel={onCancel} />
    </div>
  );
}

/** An open folder with nothing in it says so (#231), where its first row would be. */
export function EmptyFolderRow({ level }: { level: number }) {
  return (
    <div
      className="tree-row tree-empty-row"
      style={depth(level)}
      aria-hidden="true"
      data-testid="tree-empty-folder"
    >
      <span className="twisty" data-empty="" />
      <span className="tree-label">Empty</span>
    </div>
  );
}

/** A name typed in place: Enter or leaving the field keeps it, Escape cancels. */
function NameInput({
  label,
  initial,
  placeholder = 'Folder name',
  onCommit,
  onCancel,
}: {
  label: string;
  initial: string;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const done = useRef(false);
  return (
    <input
      className="tree-input"
      aria-label={label}
      defaultValue={initial}
      placeholder={placeholder}
      autoFocus
      maxLength={200}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          done.current = true;
          onCommit(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={(event) => {
        if (done.current) return;
        done.current = true;
        onCommit(event.currentTarget.value);
      }}
    />
  );
}

const FolderIcon = () => <Icon name="folder" className="tree-icon" />;
const NoteIcon = () => <Icon name="file" className="tree-icon" />;
const ChevronIcon = () => <Icon name="chevR" size={12} className="chevron" />;
const PlusIcon = () => <Icon name="plus" size={14} />;
