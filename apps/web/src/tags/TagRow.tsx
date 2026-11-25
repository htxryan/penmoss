/** One tag's row on the Tags page (TagsPage.tsx), and the checkbox its rows and head share. */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Menu, MenuItem } from '../shell/Menu';
import type { Workspace } from '../workspace/service';
import { type TagRow } from './manage';
import { DescriptionField } from './TagDescriptionField';
import { RenameRow } from './TagRenameRow';

export function Checkbox({
  label,
  checked,
  mixed = false,
  onChange,
  'data-event': tracked,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly mixed?: boolean;
  readonly onChange: (on: boolean) => void;
  /** Its tracked id (PEN-137). */
  readonly 'data-event'?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="tags-check"
      data-event={tracked ?? 'tags.select'}
      aria-label={label}
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

/** `text` with the first match of `key` marked, from character `start` of the tag on. */
function marked(text: string, start: number, at: number, key: string): ReactNode {
  const from = Math.max(at - start, 0);
  const to = Math.min(at + key.length - start, text.length);
  if (at < 0 || !key || to <= 0 || from >= text.length) return text;
  return (
    <>
      {text.slice(0, from)}
      <mark>{text.slice(from, to)}</mark>
      {text.slice(to)}
    </>
  );
}

export function TagRowView({
  row,
  rows,
  noteTags,
  filter,
  description,
  workspace,
  selected,
  renaming,
  onSelect,
  onShow,
  onStartRename,
  onCancelRename,
  onRename,
  onMergeInto,
  onDelete,
  generating,
  onGenerate,
  onClear,
}: {
  readonly row: TagRow;
  readonly rows: readonly TagRow[];
  readonly noteTags: readonly (readonly string[])[];
  readonly filter: string;
  readonly description: string;
  readonly workspace: Workspace;
  readonly selected: boolean;
  readonly renaming: boolean;
  readonly onSelect: (on: boolean) => void;
  readonly onShow: () => void;
  readonly onStartRename: () => void;
  readonly onCancelRename: () => void;
  readonly onRename: (from: string, to: string, nested: boolean) => Promise<void>;
  readonly onMergeInto: (target: string | null) => void;
  readonly onDelete: () => void;
  /** Its AI description is being generated now. */
  readonly generating: boolean;
  readonly onGenerate: () => void;
  readonly onClear: () => void;
}) {
  const at = filter ? row.tag.indexOf(filter) : -1;
  const cells = (name: ReactNode) => (
    <div
      className="tags-row"
      role="row"
      data-tag={row.tag}
      data-selected={selected ? '' : undefined}
      onKeyDown={(event) => {
        if (event.key === 'F2' && !renaming) {
          event.preventDefault();
          onStartRename();
        }
      }}
    >
      <span role="cell">
        <Checkbox
          label={`Select #${row.tag}`}
          data-event="tags.row.select"
          checked={selected}
          onChange={onSelect}
        />
      </span>
      <span role="cell" className="tags-name-cell">
        {name}
      </span>
      <span role="cell" className="tags-count-cell">
        {row.count}
      </span>
      <span role="cell" className="tags-desc-cell">
        <DescriptionField
          tag={row.tag}
          value={description}
          workspace={workspace}
          generating={generating}
        />
      </span>
      <span role="cell" className="tags-more-cell">
        <Menu
          label={`More Actions for #${row.tag}`}
          title="More Actions"
          icon="more"
          iconSize={14}
          testId={`tag-more-${row.tag}`}
          data-event="tags.row.more"
        >
          <MenuItem icon="search" data-event="tags.row.show-notes" onClick={onShow}>
            Show Notes
          </MenuItem>
          <MenuItem icon="pencil" data-event="tags.row.rename" onClick={onStartRename}>
            Rename…
          </MenuItem>
          <MenuItem icon="branch" data-event="tags.row.merge" onClick={() => onMergeInto(null)}>
            Merge Into…
          </MenuItem>
          <div className="menu-sep" role="separator" />
          <MenuItem
            icon="sparkle"
            data-event="tags.row.generate"
            disabled={generating}
            onClick={onGenerate}
          >
            Generate AI Description
          </MenuItem>
          {description ? (
            <MenuItem icon="close" data-event="tags.row.clear-description" onClick={onClear}>
              Clear Description
            </MenuItem>
          ) : null}
          <div className="menu-sep" role="separator" />
          <MenuItem icon="trash" danger data-event="tags.row.delete" onClick={onDelete}>
            Delete…
          </MenuItem>
        </Menu>
      </span>
    </div>
  );

  if (renaming) {
    return (
      <RenameRow
        row={row}
        rows={rows}
        noteTags={noteTags}
        cells={cells}
        onCancel={onCancelRename}
        onRename={onRename}
        onMergeInto={onMergeInto}
      />
    );
  }
  return cells(
    <button
      type="button"
      className="tags-name"
      data-ui="item"
      data-event="tags.row.show"
      aria-label={`#${row.tag}`}
      data-tip={`Show Notes Tagged #${row.tag}`}
      onClick={onShow}
    >
      <span className="tags-name-parent">#{marked(row.parent, 0, at, filter)}</span>
      {marked(row.name, row.parent.length, at, filter)}
    </button>,
  );
}
