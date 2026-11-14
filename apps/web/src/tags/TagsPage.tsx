import { normaliseTag, TAG_DESCRIPTION_MAX } from '@penmoss/core/tags';
import type { TagChange } from '@penmoss/sync-client/tags';
import { Icon } from '@penmoss/ui/icons';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useNotes } from '../notes/hooks';
import { Menu } from '../shell/Menu';
import { SourceScope } from '../sources/context';
import { useSourcesState } from '../sources/hooks';
import type { Source } from '../sources/registry';
import type { Workspace } from '../workspace/service';
import { useOpenNoteList } from '../workspace/notebooks';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import {
  describedAfter,
  filterKey,
  mergeChanges,
  mergeCounts,
  notesText,
  renameProblem,
  rowMatches,
  tagList,
  tagRows,
  type TagRow,
} from './manage';
import { DeleteDialog, MergeDialog } from './TagDialogs';
import { TagDoneToast, type TagDone } from './TagDoneToast';

/** What choosing a tag's name does: what choosing it in the sidebar does, in its notebook. */
export type ShowTag = (sourceId: string | null, tag: string) => void;

const NO_SOURCES = (): (() => void) => () => undefined;

/**
 * The Tags page (PEN-68, `/tags`; finding 8 of Ryan's review of #192, design "Tags D"): one
 * compact table per notebook, a tag (with its note count) on the left and what it means on the
 * right, narrowed by the filter at the top. A description saves as it is typed, into the
 * notebook's WorkspaceDoc, so it syncs and agents read it (`describe_tags`), and its row says
 * Saving…, Saved or Not saved. It is where tags are managed too: rename in place, merge, delete,
 * from a row's ⋯ or, for the selected tags, the buttons above the table; each acts on that
 * notebook's notes only, and its toast offers Undo. Choosing a tag's name opens Search on it.
 */
export function TagsPage({ onShowTag }: { readonly onShowTag: ShowTag }) {
  const state = useSourcesState();
  const sources = state?.all ?? null;
  const anyTags = useAnyTags(sources);
  const [query, setQuery] = useState('');
  const [done, setDone] = useState<TagDone | null>(null);
  const closeDone = useCallback(() => setDone(null), []);
  const section = (source: Source | null) => (
    <NotebookTags
      name={source ? source.name : null}
      sourceId={source ? source.id : null}
      query={query}
      onShowTag={onShowTag}
      onDone={setDone}
    />
  );
  return (
    <section className="tags-page" aria-labelledby="tags-page-heading" data-testid="tags-page">
      <h2 id="tags-page-heading">Tags</h2>
      {anyTags === false ? (
        <div className="empty-state compact" data-testid="tags-page-empty">
          <span className="empty-icon" aria-hidden="true">
            <Icon name="hash" size={28} />
          </span>
          <h3>No tags yet</h3>
          <p>Tag a note, with #name in its text or under its title, and the tag shows here.</p>
        </div>
      ) : (
        <>
          <label className="tags-filter tags-page-filter">
            <Icon name="search" size={14} />
            <input
              className="input"
              type="search"
              aria-label="Filter Tags"
              placeholder="Filter tags"
              value={query}
              data-testid="tags-filter"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault();
                  setQuery('');
                }
              }}
            />
          </label>
          {sources === null
            ? section(null)
            : sources.map((source) => (
                <SourceScope key={source.id} source={source}>
                  {section(source)}
                </SourceScope>
              ))}
        </>
      )}
      <TagDoneToast done={done} onClose={closeDone} />
    </section>
  );
}

/** Whether any notebook has a tag; null without the sources (one notebook in context). */
function useAnyTags(sources: readonly Source[] | null): boolean | null {
  const subscribe = useMemo(() => {
    if (!sources) return NO_SOURCES;
    return (listener: () => void) => {
      const offs = sources.map((source) => source.notes.subscribe(listener));
      return () => {
        for (const off of offs) off();
      };
    };
  }, [sources]);
  const read = () =>
    sources ? sources.some((source) => source.notes.list().some((n) => n.tags.length > 0)) : null;
  return useSyncExternalStore(subscribe, read, read);
}

type Sort = { readonly by: 'tag' | 'notes'; readonly up: boolean };

/** One notebook's tags (the notebook in context): its table, selection and actions. */
function NotebookTags({
  name,
  sourceId,
  query,
  onShowTag,
  onDone,
}: {
  /** The notebook's name, as its section's heading; null outside the sources (tests). */
  readonly name: string | null;
  readonly sourceId: string | null;
  readonly query: string;
  readonly onShowTag: ShowTag;
  readonly onDone: (done: TagDone) => void;
}) {
  const notes = useNotes();
  const workspace = useWorkspace();
  const list = useOpenNoteList();
  const noteTags = useMemo(() => list.map((entry) => entry.tags), [list]);
  const rows = useMemo(() => tagRows(noteTags), [noteTags]);
  const stored = useWorkspaceState().snapshot.tagDescriptions;
  const descriptions = useMemo(() => stored ?? {}, [stored]);
  const [sort, setSort] = useState<Sort>({ by: 'tag', up: true });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [merging, setMerging] = useState<{
    readonly sources: readonly string[];
    readonly target: string | null;
  } | null>(null);
  const [deleting, setDeleting] = useState<readonly string[] | null>(null);

  const key = filterKey(query);
  const shown = useMemo(() => {
    const matching = rows.filter((row) => rowMatches(row, descriptions[row.tag] ?? '', key));
    if (sort.by === 'notes') matching.sort((a, b) => b.count - a.count);
    if (!sort.up) matching.reverse();
    return matching;
  }, [rows, descriptions, key, sort]);
  // The selection, in the table's order, without tags that are gone.
  const picked = rows.filter((row) => selected.has(row.tag)).map((row) => row.tag);
  const allShown = shown.length > 0 && shown.every((row) => selected.has(row.tag));
  const someShown = shown.some((row) => selected.has(row.tag));

  const toggle = (tag: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(tag);
      else next.delete(tag);
      return next;
    });

  /**
   * Makes `changes` in this notebook's notes and moves the descriptions with them; the toast
   * says `text` and offers Undo, which puts back the notes and the descriptions.
   */
  const run = async (changes: readonly TagChange[], text: (notes: number) => string) => {
    const before = descriptions;
    const moved = describedAfter(before, changes);
    const result = await notes.changeTags(changes);
    for (const [tag, description] of Object.entries(moved)) {
      workspace.setTagDescription(tag, description);
    }
    void workspace.flush().catch(() => undefined);
    // The tags it changed leave the selection; a merge's target too, as the selection was its.
    const touched = new Set(changes.flatMap((change) => [change.from, change.to ?? change.from]));
    setSelected((current) => new Set([...current].filter((tag) => !touched.has(tag))));
    onDone({
      text: text(result.notes.length),
      undo: async () => {
        const back = await result.undo();
        for (const tag of Object.keys(moved)) workspace.setTagDescription(tag, before[tag] ?? '');
        void workspace.flush().catch(() => undefined);
        return back.length;
      },
    });
  };

  const rename = async (from: string, to: string, nested: boolean) => {
    await run([{ from, to, nested }], (n) => `Renamed #${from} to #${to} in ${notesText(n)}.`);
    setRenaming(null);
  };

  const merge = async (sources: readonly string[], target: string) => {
    const merged = sources.filter((source) => source !== target);
    await run(mergeChanges(sources, target), (n) =>
      merged.length > 3
        ? `Merged ${merged.length} tags into #${target} in ${notesText(n)}.`
        : `Merged ${tagList(merged)} into #${target} in ${notesText(n)}.`,
    );
    setMerging(null);
  };

  const remove = async (tags: readonly string[]) => {
    await run(
      tags.map((from) => ({ from, to: null })),
      (n) =>
        tags.length > 3
          ? `Deleted ${tags.length} tags from ${notesText(n)}.`
          : `Deleted ${tagList(tags)} from ${notesText(n)}.`,
    );
    setDeleting(null);
  };

  const headingId = sourceId ? `tags-page-${sourceId}` : 'tags-page-notebook';
  const count = `${key ? `${shown.length} of ` : ''}${rows.length} ${rows.length === 1 ? 'Tag' : 'Tags'}`;
  return (
    <section
      className="tags-page-notebook"
      aria-labelledby={name ? headingId : undefined}
      aria-label={name ? undefined : 'Tags'}
      data-testid="tags-page-notebook"
    >
      <div className="tags-page-notebook-head">
        {name ? (
          <h3 id={headingId} className="tags-page-notebook-name">
            <Icon name="notebook" size={16} />
            {name}
          </h3>
        ) : null}
        <span className="muted tags-page-count" data-testid="tags-count">
          {count}
        </span>
        {picked.length > 0 ? (
          <div className="tags-page-actions" role="group" aria-label="Selected Tags">
            <span className="tags-page-selected">{picked.length} Selected</span>
            {picked.length === 1 ? (
              <button type="button" className="btn" onClick={() => setRenaming(picked[0]!)}>
                <Icon name="pencil" size={14} />
                Rename…
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={() => setMerging({ sources: picked, target: null })}
            >
              <Icon name="branch" size={14} />
              Merge…
            </button>
            <button type="button" className="btn danger" onClick={() => setDeleting(picked)}>
              <Icon name="trash" size={14} />
              Delete…
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Clear Selection"
              data-tip="Clear Selection"
              onClick={() => setSelected(new Set())}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="muted tags-page-none" data-testid="tags-page-none">
          No tags in this notebook yet.
        </p>
      ) : shown.length === 0 ? (
        <p className="muted tags-page-none" data-testid="tags-page-none">
          No tag matches “{query.trim()}”.
        </p>
      ) : (
        <div className="tags-table" role="table" aria-label={name ? `Tags in ${name}` : 'Tags'}>
          <div className="tags-row tags-head" role="row">
            <span role="columnheader">
              <Checkbox
                label="Select All"
                checked={allShown}
                mixed={!allShown && someShown}
                onChange={(on) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    for (const row of shown) {
                      if (on) next.add(row.tag);
                      else next.delete(row.tag);
                    }
                    return next;
                  })
                }
              />
            </span>
            <SortHeader label="Tag" by="tag" sort={sort} onSort={setSort} />
            <SortHeader label="Notes" by="notes" sort={sort} onSort={setSort} />
            <span role="columnheader">Description</span>
            <span role="columnheader">
              <span className="sr-only">Actions</span>
            </span>
          </div>
          {shown.map((row) => (
            <TagRowView
              key={row.tag}
              row={row}
              rows={rows}
              noteTags={noteTags}
              filter={key}
              description={descriptions[row.tag] ?? ''}
              workspace={workspace}
              selected={selected.has(row.tag)}
              renaming={renaming === row.tag}
              onSelect={(on) => toggle(row.tag, on)}
              onShow={() => onShowTag(sourceId, row.tag)}
              onStartRename={() => setRenaming(row.tag)}
              onCancelRename={() => setRenaming(null)}
              onRename={rename}
              onMergeInto={(target) => {
                setRenaming(null);
                setMerging({ sources: [row.tag], target });
              }}
              onDelete={() => setDeleting([row.tag])}
            />
          ))}
        </div>
      )}
      {merging ? (
        <MergeDialog
          sources={merging.sources}
          initialTarget={merging.target}
          rows={rows}
          notes={noteTags}
          descriptions={descriptions}
          onMerge={merge}
          onCancel={() => setMerging(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          tags={deleting}
          rows={rows}
          notes={noteTags}
          onDelete={() => remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </section>
  );
}

/** A checkbox with an accessible name, and its mixed state set on the element. */
function Checkbox({
  label,
  checked,
  mixed = false,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly mixed?: boolean;
  readonly onChange: (on: boolean) => void;
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
      aria-label={label}
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

/** A column heading that sorts by it; a second press reverses the order. */
function SortHeader({
  label,
  by,
  sort,
  onSort,
}: {
  readonly label: string;
  readonly by: Sort['by'];
  readonly sort: Sort;
  readonly onSort: (sort: Sort) => void;
}) {
  const on = sort.by === by;
  return (
    <span
      role="columnheader"
      aria-sort={on ? (sort.up ? 'ascending' : 'descending') : undefined}
      className={by === 'notes' ? 'tags-count-cell' : undefined}
    >
      <button
        type="button"
        className="tags-sort"
        data-ui="item"
        onClick={() => onSort({ by, up: on ? !sort.up : true })}
      >
        {label}
        {on ? <Icon name={sort.up ? 'chevU' : 'chevD'} size={12} /> : null}
      </button>
    </span>
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

function TagRowView({
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
        <Checkbox label={`Select #${row.tag}`} checked={selected} onChange={onSelect} />
      </span>
      <span role="cell" className="tags-name-cell">
        {name}
      </span>
      <span role="cell" className="tags-count-cell">
        {row.count}
      </span>
      <span role="cell" className="tags-desc-cell">
        <DescriptionField tag={row.tag} value={description} workspace={workspace} />
      </span>
      <span role="cell" className="tags-more-cell">
        <Menu
          label={`More Actions for #${row.tag}`}
          title="More Actions"
          icon="more"
          iconSize={14}
          testId={`tag-more-${row.tag}`}
        >
          <MenuItem icon="search" onClick={onShow}>
            Show Notes
          </MenuItem>
          <MenuItem icon="pencil" onClick={onStartRename}>
            Rename…
          </MenuItem>
          <MenuItem icon="branch" onClick={() => onMergeInto(null)}>
            Merge Into…
          </MenuItem>
          <div className="menu-sep" role="separator" />
          <MenuItem icon="trash" danger onClick={onDelete}>
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
      aria-label={`#${row.tag}`}
      data-tip={`Show Notes Tagged #${row.tag}`}
      onClick={onShow}
    >
      <span className="tags-name-parent">#{marked(row.parent, 0, at, filter)}</span>
      {marked(row.name, row.parent.length, at, filter)}
    </button>,
  );
}

function MenuItem({
  icon,
  danger = false,
  onClick,
  children,
}: {
  readonly icon: 'search' | 'pencil' | 'branch' | 'trash';
  readonly danger?: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={danger ? 'menu-item danger' : 'menu-item'}
      data-ui="item"
      onClick={onClick}
    >
      <Icon name={icon} />
      <span className="menu-label">{children}</span>
    </button>
  );
}

/**
 * A tag's name edited in its own row (Tags D · Rename): Return, or clicking away, renames at
 * once, with Undo in the toast after; Escape cancels. The strip under the row says what will
 * change; a name that exists turns the rename into an offer to merge, with the counts, and a tag
 * with tags inside it offers to rename them too (on by default).
 */
function RenameRow({
  row,
  rows,
  noteTags,
  cells,
  onCancel,
  onRename,
  onMergeInto,
}: {
  readonly row: TagRow;
  readonly rows: readonly TagRow[];
  readonly noteTags: readonly (readonly string[])[];
  readonly cells: (name: ReactNode) => ReactNode;
  readonly onCancel: () => void;
  readonly onRename: (from: string, to: string, nested: boolean) => Promise<void>;
  readonly onMergeInto: (target: string) => void;
}) {
  const [value, setValue] = useState(row.tag);
  // Only a tag notes have can leave the tags inside it where they are.
  const canLeave = row.nested.length > 0 && row.own > 0;
  const [nestedOn, setNestedOn] = useState(true);
  const nested = canLeave ? nestedOn : true;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  useEffect(() => {
    input.current?.select();
    void zone.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  const to = normaliseTag(value);
  const problem = value.trim() ? renameProblem(row.tag, value) : null;
  const unchanged = to === row.tag || !value.trim();
  const existing = !problem && to && !unchanged ? rows.find((each) => each.tag === to) : undefined;

  // Once cancelled or merging, nothing renames (a blur as the row goes, say).
  const closed = useRef(false);
  const cancel = () => {
    closed.current = true;
    onCancel();
  };
  const commit = () => {
    if (closed.current || busy || problem || existing) return;
    if (unchanged || !to) return cancel();
    setBusy(true);
    setFailed(null);
    onRename(row.tag, to, nested).catch((caught: unknown) => {
      setBusy(false);
      setFailed(caught instanceof Error ? caught.message : String(caught));
    });
  };

  const moved = nested ? row.nested.filter((tag) => tag !== row.tag) : [];
  const notes = nested ? row.count : row.own;
  const strip = (() => {
    if (problem || failed) {
      return (
        <p className="kb-error tags-strip-text" role="alert">
          {problem ?? `Not renamed: ${failed!}`}
        </p>
      );
    }
    if (existing) {
      const { after, had } = mergeCounts(noteTags, [row.tag], existing.tag);
      return (
        <>
          <p className="tags-strip-text">
            <strong>#{existing.tag}</strong> already exists ({notesText(existing.count)}). Merge{' '}
            <strong>#{row.tag}</strong> into it? {notesText(after)} end up with #{existing.tag}
            {had > 0 ? `; ${had} already ${had === 1 ? 'has' : 'have'} both` : ''}.
          </p>
          <span className="tags-strip-end">
            <button
              type="button"
              className="btn"
              onClick={() => {
                input.current?.focus();
                input.current?.select();
              }}
            >
              Pick Another Name
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                closed.current = true;
                onMergeInto(existing.tag);
              }}
            >
              <Icon name="branch" size={14} />
              Merge Into #{existing.tag}
            </button>
          </span>
        </>
      );
    }
    if (row.nested.length > 0) {
      const shownMoves = row.nested.slice(0, 3);
      return (
        <>
          {canLeave ? (
            <label className="tags-strip-check">
              <input
                type="checkbox"
                checked={nestedOn}
                onChange={(event) => setNestedOn(event.target.checked)}
              />
              <span>
                Also rename the {row.nested.length === 1 ? 'tag' : `${row.nested.length} tags`}{' '}
                inside it
              </span>
            </label>
          ) : (
            <span className="tags-strip-text">
              The {row.nested.length === 1 ? 'tag' : `${row.nested.length} tags`} inside it move
              too.
            </span>
          )}
          {nested && to && !unchanged ? (
            <span className="muted tags-strip-hint">
              {shownMoves.map((tag) => `#${tag} → #${to}${tag.slice(row.tag.length)}`).join(' · ')}
              {row.nested.length > shownMoves.length
                ? ` · ${row.nested.length - shownMoves.length} more`
                : ''}
            </span>
          ) : null}
          <span className="tags-strip-end">
            <span className="muted">
              {moved.length > 0
                ? `Renames ${moved.length + 1} tags in ${notesText(notes)}.`
                : `Renames it in ${notesText(notes)}.`}
            </span>
            <button type="button" className="btn" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || unchanged}
              onClick={commit}
            >
              {moved.length > 0 ? 'Rename Tags' : 'Rename Tag'}
            </button>
          </span>
        </>
      );
    }
    return (
      <>
        <span className="muted tags-strip-text">Renames it in {notesText(notes)}.</span>
        <span className="muted tags-strip-hint">
          <kbd>Return</kbd> or click away: Rename · <kbd>Esc</kbd>: Cancel
        </span>
      </>
    );
  })();

  return (
    <div
      ref={zone}
      role="rowgroup"
      className="tags-rename"
      onBlur={(event) => {
        // Clicking away renames; moving within the row and its strip does not.
        if (!event.currentTarget.contains(event.relatedTarget)) commit();
      }}
    >
      {cells(
        <label className="tags-name-edit" data-warn={existing || problem ? '' : undefined}>
          <span className="sr-only">New name for #{row.tag}</span>
          <span className="tag-hash" aria-hidden="true">
            #
          </span>
          <input
            ref={input}
            className="input"
            value={value}
            autoFocus
            disabled={busy}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => {
              setFailed(null);
              setValue(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancel();
              }
            }}
          />
        </label>,
      )}
      <div
        className="tags-strip"
        role="row"
        onMouseDown={(event) => {
          // A press on the strip's text keeps the name's field focused, so it does not rename.
          if (!(event.target as HTMLElement).closest('button, input, label'))
            event.preventDefault();
        }}
        data-tone={problem || failed ? 'warn' : existing ? 'offer' : undefined}
        data-testid="tags-rename-strip"
      >
        <div role="cell" className="tags-strip-cell">
          {strip}
        </div>
      </div>
    </div>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/** How long a typed description waits before it is stored, and how long Saved shows. */
const SAVE_DELAY_MS = 500;
const SAVED_MS = 2000;

/**
 * A tag's description: its first line, cut with an ellipsis, until it is chosen; then a field
 * that grows to show every line, saved as it is typed (as a note's title is). Beside it, Saving…
 * then Saved once it is stored, or Not saved with Try Again. While it is edited it shows what is
 * typed; otherwise what is stored, so another device's edit arrives.
 */
function DescriptionField({
  tag,
  value,
  workspace,
}: {
  readonly tag: string;
  readonly value: string;
  readonly workspace: Workspace;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>('idle');
  const field = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fade = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editing = draft !== null;
  const view = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    view.current?.focus();
  }, [editing]);

  const store = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    workspace.flush().then(
      () => {
        setState('saved');
        if (fade.current) clearTimeout(fade.current);
        fade.current = setTimeout(() => setState('idle'), SAVED_MS);
      },
      () => setState('failed'),
    );
  }, [workspace]);

  useEffect(
    () => () => {
      // Leaving the page: whatever is typed is stored now.
      if (timer.current) {
        clearTimeout(timer.current);
        void workspace.flush().catch(() => undefined);
      }
      if (fade.current) clearTimeout(fade.current);
    },
    [workspace],
  );

  // The field grows with its lines (one line high when short).
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [draft, editing]);

  const change = (text: string) => {
    setDraft(text);
    if (fade.current) clearTimeout(fade.current);
    try {
      workspace.setTagDescription(tag, text);
    } catch {
      setState('failed');
      return;
    }
    setState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(store, SAVE_DELAY_MS);
  };

  const firstLine = value.split('\n')[0] ?? '';
  const more = value.includes('\n');
  return (
    <span className="tags-desc" data-state={state}>
      {editing ? (
        <textarea
          ref={field}
          className="input tags-desc-field"
          aria-label={`Description of #${tag}`}
          placeholder="Add a description"
          rows={1}
          maxLength={TAG_DESCRIPTION_MAX}
          spellCheck
          autoFocus
          value={draft}
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          onBlur={() => {
            if (timer.current) store();
            setDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              // Done: what is typed is kept (it saves as it is typed), and focus stays on the row.
              event.preventDefault();
              event.stopPropagation();
              refocus.current = true;
              event.currentTarget.blur();
            }
          }}
          onChange={(event) => change(event.target.value)}
        />
      ) : (
        <button
          ref={view}
          type="button"
          className="tags-desc-view"
          data-ui="item"
          data-empty={value ? undefined : ''}
          aria-label={value ? `Description of #${tag}: ${value}` : `Add a Description of #${tag}`}
          onClick={() => setDraft(value)}
        >
          <span className="tags-desc-line">
            {value ? `${firstLine}${more ? ' …' : ''}` : 'Add a description'}
          </span>
        </button>
      )}
      <span className="tags-save" role="status" data-testid="tags-save">
        {state === 'saving' ? (
          <>
            <span className="tags-save-dot" aria-hidden="true" />
            Saving…
          </>
        ) : state === 'saved' ? (
          <>
            <Icon name="check" size={12} />
            Saved
          </>
        ) : state === 'failed' ? (
          <>
            <span className="tags-save-failed">Not saved</span>
            <button type="button" className="btn quiet" onClick={store}>
              Try Again
            </button>
          </>
        ) : null}
      </span>
    </span>
  );
}
