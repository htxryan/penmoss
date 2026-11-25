/** A tag's row while it is renamed on the Tags page (TagsPage.tsx). */
import { normaliseTag } from '@penmoss/core/tags';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { mergeCounts, notesText, renameProblem, type TagRow } from './manage';

/**
 * A tag's name edited in its own row (Tags D · Rename): Return, or clicking away, renames at
 * once, with Undo in the toast after; Escape cancels. The strip under the row says what will
 * change; a name that exists turns the rename into an offer to merge, with the counts, and a tag
 * with tags inside it offers to rename them too (on by default).
 */
export function RenameRow({
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
              data-ui="dismiss"
              data-event="tags.rename.pick-another"
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
              data-ui="submit"
              data-event="tags.rename.merge"
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
                data-event="tags.rename.nested"
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
            <button
              type="button"
              className="btn"
              data-ui="dismiss"
              data-event="tags.rename.cancel"
              onClick={cancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              data-ui="submit"
              data-event="tags.rename.submit"
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
