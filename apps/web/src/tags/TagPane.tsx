import { Icon } from '@penmoss/ui/icons';
import { normaliseTag, tagAncestors, tagTree, type TagNode } from '@penmoss/core/tags';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNotes } from '../notes/hooks';
import { useStoredCollapse } from '../shell/collapsed';
import { useOpenNoteList } from '../workspace/notebooks';
import { tagFilter, useTagFilter } from './filter';
import { SectionHead } from '../shell/SectionHead';
import { linkHandler } from '../router';

/** Whether the Tags panel is collapsed on this device (T51, A934). */
export const TAGS_COLLAPSED_KEY = 'penmoss.sidebar.tags';

/**
 * The tag pane (T18): every tag in the notes on this device, nested by `/`,
 * with how many notes carry it (or a tag under it). Choosing a tag filters
 * the sidebar; Rename changes the tag in every note that has it, and merges
 * when the new name is already a tag. Built from the local replica, so it
 * works offline, and it follows other devices as catch-up sync brings their
 * changes in.
 */
export function TagPane({ tools }: { readonly tools?: ReactNode } = {}) {
  // Tags of the open notebooks only (T43, A752).
  const list = useOpenNoteList();
  const filter = useTagFilter();
  const tree = useMemo(() => tagTree(list.map((entry) => entry.tags)), [list]);
  const known = useMemo(() => new Set(list.flatMap((entry) => entry.tags)), [list]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [collapsed, toggleCollapsed] = useStoredCollapse(TAGS_COLLAPSED_KEY);

  // The filtered tag's parents stay open, so it is visible.
  const expanded = (tag: string) =>
    open.has(tag) || (filter !== null && filter !== tag && tagAncestors(filter).includes(tag));

  const toggle = (tag: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });

  const rows = (nodes: readonly TagNode[], depth: number) =>
    nodes.map((node) => (
      <li key={node.tag} className="tag-item">
        <div className="tag-row" style={{ ['--depth' as string]: depth }}>
          {node.children.length > 0 ? (
            <button
              type="button"
              className="twisty"
              data-ui="item"
              data-open={expanded(node.tag) ? 'true' : 'false'}
              aria-expanded={expanded(node.tag)}
              aria-label={`${expanded(node.tag) ? 'Collapse' : 'Expand'} #${node.tag}`}
              onClick={() => toggle(node.tag)}
            >
              <Icon name="chevR" size={12} className="chevron" />
            </button>
          ) : (
            <span className="twisty" data-empty="" aria-hidden="true" />
          )}
          <button
            type="button"
            className="tag-name"
            data-ui="item"
            aria-pressed={filter === node.tag}
            aria-label={`#${node.tag}, ${node.count} ${node.count === 1 ? 'note' : 'notes'}`}
            data-tip={`Show Notes Tagged #${node.tag}`}
            onClick={() => tagFilter.set(filter === node.tag ? null : node.tag)}
          >
            <span className="tag-hash" aria-hidden="true">
              #
            </span>
            <span className="tag-label">{node.name}</span>
            <span className="count">{node.count}</span>
          </button>
          <button
            type="button"
            className="tag-edit"
            data-ui="item"
            aria-label={`Rename #${node.tag}`}
            data-tip="Rename or Merge"
            onClick={() => {
              setStatus(null);
              setRenaming(renaming === node.tag ? null : node.tag);
            }}
          >
            <Icon name="pencil" size={14} />
          </button>
        </div>
        {renaming === node.tag ? (
          <RenameTag
            from={node.tag}
            known={known}
            onDone={(message) => {
              setRenaming(null);
              setStatus(message);
            }}
          />
        ) : null}
        {node.children.length > 0 && expanded(node.tag) ? (
          <ul className="tag-tree" role="list">
            {rows(node.children, depth + 1)}
          </ul>
        ) : null}
      </li>
    ));

  return (
    <section
      className="tag-pane"
      aria-labelledby="tag-pane-heading"
      data-testid="tag-pane"
      data-collapsed={collapsed ? 'true' : undefined}
    >
      {/* The sections' title row, remembered on this device (T51, A934; A988). */}
      <SectionHead
        name="Tags"
        nameId="tag-pane-heading"
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        controls="tag-pane-body"
        tools={tools}
        testId="tag-pane-toggle"
      />
      {collapsed ? null : tree.length === 0 ? (
        <p id="tag-pane-body" className="tag-empty muted">
          No tags
        </p>
      ) : (
        <ul id="tag-pane-body" className="tag-tree" role="list">
          {rows(tree, 0)}
        </ul>
      )}
      <p className="tag-status" role="status">
        {status}
      </p>
    </section>
  );
}

function RenameTag({
  from,
  known,
  onDone,
}: {
  from: string;
  known: ReadonlySet<string>;
  onDone: (message: string | null) => void;
}) {
  const notes = useNotes();
  const [value, setValue] = useState(from);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // Braces: Chrome's scrollIntoView returns a promise, which an effect must not return.
    void form.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const to = normaliseTag(value);
  const merge = to !== null && to !== from && known.has(to);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!to) {
      setError('A tag is letters, digits, - and _, with / for levels, and no spaces.');
      return;
    }
    if (to === from) return onDone(null);
    if (to.startsWith(`${from}/`)) {
      setError(`#${from} cannot move inside itself.`);
      return;
    }
    setBusy(true);
    notes
      .renameTag(from, to)
      .then((changed) => {
        const count = `${changed.length} ${changed.length === 1 ? 'note' : 'notes'}`;
        if (tagFilter.get() === from) tagFilter.set(to);
        onDone(
          merge
            ? `Merged #${from} into #${to} in ${count}`
            : `Renamed #${from} to #${to} in ${count}`,
        );
      })
      .catch((caught: unknown) => {
        setBusy(false);
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  };

  return (
    <form ref={form} className="tag-rename" onSubmit={submit}>
      <input
        className="input"
        aria-label={`New name for #${from}`}
        value={value}
        autoFocus
        onChange={(event) => {
          setError(null);
          setValue(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onDone(null);
          }
        }}
      />
      <div className="tag-rename-actions">
        <button type="submit" className="btn primary" data-ui="submit" disabled={busy}>
          {merge ? 'Merge' : 'Rename'}
        </button>
        <button type="button" className="btn quiet" data-ui="dismiss" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
      {merge ? <p className="muted">#{to} exists: its notes and these will share it.</p> : null}
      {error ? (
        <p className="kb-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The Tags page (PEN-68) from the Tags section's title row, first among its tools: where each
 * tag's description is written.
 */
export function TagsPageLink({ current }: { readonly current: boolean }) {
  return (
    <a
      className="icon-btn"
      data-ui="item"
      href="/tags"
      data-command="app.tags"
      aria-label="Open the Tags Page"
      aria-current={current ? 'page' : undefined}
      data-tip="Open the Tags Page"
      data-testid="open-tags-page"
      onClick={linkHandler('/tags')}
    >
      <Icon name="list" size={14} />
    </a>
  );
}
