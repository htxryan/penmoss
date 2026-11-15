import { normaliseTag, tagMatches } from '@penmoss/core/tags';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  deleteCount,
  filterKey,
  mergeCounts,
  mergedDescription,
  mergeProblem,
  notesText,
  tagList,
  type TagRow,
} from './manage';

/** A modal confirm (`dialog.confirm`), open while mounted; Escape cancels. */
function ConfirmDialog({
  title,
  testId,
  wide = false,
  onCancel,
  onSubmit,
  children,
}: {
  readonly title: string;
  readonly testId: string;
  readonly wide?: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'confirm tags-dialog' : 'confirm'}
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </form>
    </dialog>
  );
}

/** The tag with the most notes (the first of those tied): the one a merge keeps at first. */
function mostNotes(tags: readonly string[], rows: readonly TagRow[]): string | null {
  let best: string | null = null;
  let most = -1;
  for (const tag of tags) {
    const count = rows.find((row) => row.tag === tag)?.count ?? 0;
    if (count > most) {
      best = tag;
      most = count;
    }
  }
  return best;
}

/** Runs a dialog's action: busy while it runs, its error shown in the dialog if it fails. */
function useAction(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    action().catch((caught: unknown) => {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  };
  return { busy, error, run };
}

/**
 * The one Merge dialog (finding 8 of Ryan's review of #192), however it opens: from a row's
 * Merge Into…, the top Merge… with one tag selected (a searchable list of the tags to merge it
 * into, with their note counts), the top Merge… with several (the one to keep, or a new name),
 * or a rename to a name that exists (that tag picked already). A preview says what changes
 * before anything does, counting notes that have both tags already.
 */
export function MergeDialog({
  sources,
  initialTarget,
  rows,
  notes,
  descriptions,
  onMerge,
  onCancel,
}: {
  /** The tags to merge: one, or several (the selection), in the table's order. */
  readonly sources: readonly string[];
  readonly initialTarget?: string | null;
  readonly rows: readonly TagRow[];
  /** Each note's tags, for the preview's counts. */
  readonly notes: readonly (readonly string[])[];
  readonly descriptions: Readonly<Record<string, string>>;
  readonly onMerge: (sources: readonly string[], target: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const single = sources.length === 1;
  const from = sources[0]!;
  const counts = useMemo(() => new Map(rows.map((row) => [row.tag, row.count])), [rows]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(
    initialTarget ?? (single ? null : mostNotes(sources, rows)),
  );
  const [typed, setTyped] = useState('');
  const newId = useId();

  // Single: any tag but the one merged and those inside it (they would move into themselves).
  const key = filterKey(query);
  const targets = single
    ? rows.filter((row) => !tagMatches(row.tag, from) && (!key || row.tag.includes(key)))
    : [];
  const newName = typed.trim() ? normaliseTag(typed) : null;
  const target = single ? picked : typed.trim() ? newName : picked;
  const problem =
    !single && typed.trim() && !newName
      ? 'Spaces and # are not allowed in a tag, as in a note.'
      : target
        ? mergeProblem(sources, target)
        : null;
  const ready = target !== null && problem === null;

  const merged = target ? sources.filter((source) => source !== target) : [];
  const preview = (() => {
    if (!target) return single ? `Pick the tag to merge #${from} into.` : 'Pick the tag to keep.';
    if (problem) return problem;
    const { retagged, had } = mergeCounts(notes, merged, target);
    const exists = counts.has(target);
    const described = mergedDescription(descriptions, merged, target);
    const description =
      described === null
        ? ''
        : described === target
          ? ` The description of #${target} is kept.`
          : exists
            ? ` #${target} has no description, so it takes the one from #${described}.`
            : ` It takes the description of #${described}.`;
    const gone = merged.length === 1 ? ` #${merged[0]!} is gone.` : '';
    return `${tagList(merged)} will be merged into #${target}: ${notesText(retagged)} retagged${
      had > 0 ? `, ${had} already had #${target}` : ''
    }.${description}${gone}`;
  })();

  const { busy, error, run } = useAction(() => onMerge(sources, target!));
  const title = single ? `Merge #${from} Into…` : `Merge ${sources.length} Tags`;

  return (
    <ConfirmDialog
      title={title}
      testId="tags-merge-dialog"
      wide
      onCancel={onCancel}
      onSubmit={() => {
        if (ready) run();
      }}
    >
      <p>
        {single
          ? `Every note tagged #${from} gets the tag you pick instead.`
          : 'Pick the tag to keep, or type a new name. The others are replaced by it in every note.'}
      </p>
      {single ? (
        <div className="tags-merge-grid">
          <span className="tags-merge-label">From</span>
          <span className="tags-merge-source">
            #{from} <span className="muted">{notesText(counts.get(from) ?? 0)}</span>
          </span>
          <span className="tags-merge-label">Into</span>
          <div className="tags-merge-pick">
            <label className="tags-filter tags-merge-find">
              <Icon name="search" size={14} />
              <input
                className="input"
                type="search"
                aria-label="Find a Tag"
                placeholder="Find a tag"
                value={query}
                autoFocus={!initialTarget}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="tags-merge-list" role="radiogroup" aria-label="Tags to Merge Into">
              {targets.map((row) => (
                <label key={row.tag} className="tags-merge-option" data-on={picked === row.tag}>
                  <input
                    type="radio"
                    name="merge-target"
                    checked={picked === row.tag}
                    autoFocus={initialTarget === row.tag}
                    onChange={() => setPicked(row.tag)}
                  />
                  <span className="tags-merge-tag">#{row.tag}</span>
                  <span className="muted">{notesText(row.count)}</span>
                </label>
              ))}
              {targets.length === 0 ? (
                <p className="muted tags-merge-none">
                  No tag matches. Rename #{from} instead to give it a new name.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="tags-merge-list" role="radiogroup" aria-label="Tag to Keep">
          {sources.map((source, index) => (
            <label
              key={source}
              className="tags-merge-option"
              data-on={!typed.trim() && picked === source}
            >
              <input
                type="radio"
                name="merge-keep"
                checked={!typed.trim() && picked === source}
                autoFocus={index === 0}
                onChange={() => {
                  setTyped('');
                  setPicked(source);
                }}
              />
              <span className="tags-merge-tag">#{source}</span>
              <span className="muted">{notesText(counts.get(source) ?? 0)}</span>
            </label>
          ))}
          <label className="tags-merge-option" data-on={Boolean(typed.trim())}>
            <input
              type="radio"
              name="merge-keep"
              aria-label="A New Name"
              checked={Boolean(typed.trim())}
              onChange={() => document.getElementById(newId)?.focus()}
            />
            <input
              id={newId}
              className="input"
              aria-label="New Name"
              placeholder="Or type a new name"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
        </div>
      )}
      <p className="tags-merge-preview" role="status" data-testid="tags-merge-preview">
        {preview}
      </p>
      {error ? (
        <p className="kb-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="btn" data-ui="dismiss" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" data-ui="submit" disabled={!ready || busy}>
          <Icon name="branch" size={14} />
          {busy ? 'Merging…' : 'Merge Tags'}
        </button>
      </div>
    </ConfirmDialog>
  );
}

/**
 * Asks before tags are deleted from every note that has them (finding 8 of Ryan's review of
 * #192), with the tags nested under them; the notes stay, and the toast after offers Undo.
 */
export function DeleteDialog({
  tags,
  rows,
  notes,
  onDelete,
  onCancel,
}: {
  readonly tags: readonly string[];
  readonly rows: readonly TagRow[];
  readonly notes: readonly (readonly string[])[];
  readonly onDelete: () => Promise<void>;
  readonly onCancel: () => void;
}) {
  const nested = new Set(
    rows
      .filter((row) => tags.includes(row.tag))
      .flatMap((row) => row.nested)
      .filter((tag) => !tags.includes(tag)),
  );
  const count = deleteCount(notes, tags);
  const { busy, error, run } = useAction(onDelete);
  const one = tags.length === 1;
  return (
    <ConfirmDialog
      title={one ? `Delete #${tags[0]!}` : `Delete ${tags.length} Tags`}
      testId="tags-delete-dialog"
      onCancel={onCancel}
      onSubmit={run}
    >
      <p>
        Removes {tagList(tags)}
        {nested.size > 0
          ? ` and the ${nested.size === 1 ? 'tag' : `${nested.size} tags`} inside ${one ? 'it' : 'them'}`
          : ''}{' '}
        from {notesText(count)}. The notes stay, and a tag in a note’s text keeps its word, without
        the #.
      </p>
      {error ? (
        <p className="kb-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="btn" data-ui="dismiss" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button type="submit" className="btn danger-fill" data-ui="submit" disabled={busy}>
          {busy ? 'Deleting…' : one ? 'Delete Tag' : 'Delete Tags'}
        </button>
      </div>
    </ConfirmDialog>
  );
}
