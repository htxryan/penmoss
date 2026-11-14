import { Icon } from '@penmoss/ui/icons';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { useCommand, useCommands } from '../commands/hooks';
import { desktop } from '../desktop/bridge';
import { useNotes } from '../notes/hooks';
import { PaneResizer } from '../shell/PaneResizer';
import { PANE_LIMITS, usePaneSize } from '../shell/pane-widths';
import { useSource } from '../sources/hooks';
import { authorName, bodyOf, clock, dayLabel, lineCounts, startOfDay, time } from './format';
import { AuthorMark, DiffLines } from './parts';
import { revertible } from './revertible';
import {
  gitHistory,
  noHistory,
  HistoryRefused,
  type HistoryChange,
  type HistoryConflict,
  type HistoryDetail,
  type HistoryList,
  type HistorySource,
  type HistorySummary,
  type HistoryVersion,
} from './source';

type History = HistoryList;
type Detail = HistoryDetail;
type Conflict = HistoryConflict;

const REASONS: Record<string, string> = {
  auto: '',
  manual: 'Saved by hand',
  // Their summaries say what was restored or reverted.
  restore: '',
  revert: '',
  // Agent edit engine (T24): the summary names the operation.
  edit: '',
};

/** Copies `text` (the click is the gesture the Mac app's clipboard needs). */
async function copy(text: string): Promise<boolean> {
  const app = desktop();
  if (app) return app.clipboard.write({ text });
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}

/** Versions whose summaries are read first: about the rows on screen; the rest follow in one read. */
const FIRST_SUMMARIES = 20;
const NO_SUMMARIES: ReadonlyMap<number, HistorySummary> = new Map();
/** The list's least height while its handle is dragged, in rem: a few rows. */
const LIST_MIN_REM = 6;

/** Why the history did not load, in words (T39: a server error used to read as offline). */
function loadFailure(caught: unknown, source: HistorySource): string {
  return caught instanceof HistoryRefused
    ? `The server could not load the history (error ${caught.status}). Try again in a moment.`
    : source.offline;
}

/**
 * Version history of the open note (T21): the versions the NoteDoc keeps
 * (newest first, each naming the devices and agents behind it), what each
 * changed as a line diff of its markdown, Restore (the old content comes back
 * as a new change that syncs everywhere) and, for an agent's edit, Revert (a
 * three-way merge that keeps later edits and reports overlaps). The versions
 * are the note's git notebook's commits (A858), read through the Mac app.
 * Since T51 (A936) it is the History tab of the note's side panel, not an
 * overlay of its own: the panel's tabs open and close it.
 *
 * Laid out as "List over a Docked Preview" (Ryan's review of #192, finding 13): one line per
 * version (who, when, what), grouped by day, ↑ and ↓ to move through them; under a handle that
 * resizes the two, the chosen version's changes with Restore, Revert and Copy Text. How versions
 * are made is the head's ⓘ (`AboutVersions`); Sync Now is on the Now row.
 */
export function HistoryPanel({ noteId }: { noteId: string }) {
  const notes = useNotes();
  const scope = useSource();
  // A note is always a git notebook's (D49); without one in scope (a test's lone source) there
  // is no history to read.
  const source = useMemo<HistorySource>(
    () => (scope ? gitHistory(scope, notes, noteId) : noHistory()),
    [scope, notes, noteId],
  );
  const commands = useCommands();
  const [history, setHistory] = useState<History | null>(null);
  /** When the list was read: its days are named from then (Today, Yesterday). */
  const [listedAt, setListedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<readonly Conflict[]>([]);
  const [busy, setBusy] = useState(false);
  const heading = useId();
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [previewHeight, setPreviewHeight] = usePaneSize('historyPreview');

  /** Bumped to read the list again (Try Again). */
  const [generation, setGeneration] = useState(0);
  const load = useCallback(() => setGeneration((n) => n + 1), []);
  /** The source shown now: a list read for another note's is dropped when it lands. */
  const live = useRef(source);
  useLayoutEffect(() => {
    live.current = source;
  }, [source]);

  /** Shows a list just read, keeping the version picked when it is still there. */
  const apply = useCallback((next: History) => {
    setHistory(next);
    setListedAt(Date.now());
    setError(null);
    setSelected((selection) =>
      selection !== null && next.versions.some((v) => v.id === selection)
        ? selection
        : (next.versions[0]?.id ?? null),
    );
  }, []);

  useEffect(() => {
    let current = true;
    void source
      .list()
      .then((next) => current && apply(next))
      .catch((caught: unknown) => current && setError(loadFailure(caught, source)));
    return () => {
      current = false;
    };
  }, [source, generation, apply]);

  /** Reads the list again after a save, a restore or a revert. */
  const reread = useCallback(async () => {
    const from = source;
    try {
      const next = await from.list();
      if (live.current === from) apply(next);
    } catch (caught) {
      if (live.current === from) setError(loadFailure(caught, from));
    }
  }, [source, apply]);

  // The Now row follows the note (Ryan's review of #192, finding 13): a change waiting to sync
  // shows it, and a sync that made a version lists it.
  useEffect(() => source.watch?.(() => void reread()), [source, reread]);

  // What each version changed, filled in once the list shows (Ryan's review of #192): the list
  // comes from the log alone, and the summaries take reading every version's text.
  // Kept with the source they were read from: another note's are never shown.
  const [read, setRead] = useState<{
    readonly of: HistorySource;
    readonly summaries: ReadonlyMap<number, HistorySummary>;
  }>(() => ({ of: source, summaries: new Map() }));
  const summaries = read.of === source ? read.summaries : NO_SUMMARIES;
  /** The summaries read so far, for the read below to skip (it runs on a new list, not on these). */
  const known = useRef(summaries);
  useLayoutEffect(() => {
    known.current = summaries;
  });
  useEffect(() => {
    if (!history) return;
    const wanted = history.versions.filter((v) => !known.current.has(v.id)).map((v) => v.id);
    if (wanted.length === 0) return;
    let current = true;
    void (async () => {
      for (const part of [wanted.slice(0, FIRST_SUMMARIES), wanted.slice(FIRST_SUMMARIES)]) {
        if (part.length === 0) continue;
        const got = await source.summaries(part).catch(() => null);
        if (!current || !got) return;
        setRead((before) => ({
          of: source,
          summaries: new Map([...(before.of === source ? before.summaries : []), ...got]),
        }));
      }
    })();
    return () => {
      current = false;
    };
  }, [source, history]);

  useEffect(() => {
    if (selected === null) return;
    let current = true;
    void source
      .detail(selected)
      .then((next) => current && setDetail(next))
      .catch(() => current && setDetail(null));
    return () => {
      current = false;
    };
  }, [source, selected]);

  const act = async <T,>(run: () => Promise<T>, done: (body: T) => string) => {
    setBusy(true);
    setStatus(null);
    setConflicts([]);
    try {
      const said = done(await run());
      // The list as it is now before the status says what was done (A1180): "Saved a version"
      // over a list that does not show it yet invites a click on the version before it.
      await reread();
      setStatus(said);
    } catch (caught) {
      setStatus(
        caught instanceof HistoryRefused
          ? // Its own words when it has them (a git notebook's note not saved first, A858).
            caught.message !== `HTTP ${caught.status}`
            ? caught.message
            : `The server could not do that (error ${caught.status}). Try again in a moment.`
          : 'That did not work. Check the connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const saveNow = () =>
    act(
      () => source.save(),
      () => {
        setSelected(null);
        return 'Saved a version of the note as it is now.';
      },
    );
  useCommand('note.saveVersion', () => void saveNow());

  const version = history?.versions.find((v) => v.id === selected) ?? null;
  const canRevert = version ? revertible(version) : false;
  const shown = detail && version && detail.id === version.id ? detail : null;

  /** The versions by day, newest first. */
  const days = useMemo(() => {
    const out: { key: number; label: string; versions: HistoryVersion[] }[] = [];
    for (const v of history?.versions ?? []) {
      const key = startOfDay(v.createdAt);
      const last = out.at(-1);
      if (last?.key === key) last.versions.push(v);
      else out.push({ key, label: dayLabel(v.createdAt, listedAt), versions: [v] });
    }
    return out;
  }, [history, listedAt]);

  /** ↑ and ↓ (Home and End) move to the version before or after, and show it. */
  const onListKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>('.history-entry') ?? []),
    ];
    const from = rows.indexOf(event.target as HTMLButtonElement);
    if (from < 0) return;
    const to =
      event.key === 'ArrowDown'
        ? Math.min(rows.length - 1, from + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, from - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? rows.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    const row = rows[to]!;
    row.focus();
    setSelected(Number(row.dataset['version']));
  };

  const copyText = () => {
    if (!shown) return;
    void copy(bodyOf(shown.markdown)).then((done) =>
      setStatus(done ? 'Copied the text of this version.' : 'Could not copy the text.'),
    );
  };

  const statusLine = status ? (
    <p className="history-status" role="status" data-testid="history-status">
      {status}
    </p>
  ) : null;

  return (
    <section
      ref={panelRef}
      className="history-panel"
      aria-labelledby={heading}
      data-testid="history-panel"
      style={{ '--history-preview': `${previewHeight}rem` } as CSSProperties}
    >
      <h2 id={heading} className="info-heading">
        Version History
      </h2>
      {/* How versions are made: the head's ⓘ says it, and it describes Sync Now (A79, A574). */}
      <p id={`${heading}-auto`} className="sr-only" data-testid="history-auto">
        {source.automatic}
      </p>
      {error ? (
        <div className="history-empty muted" role="status">
          <p>{error}</p>
          <button
            type="button"
            className="btn"
            data-ui="submit"
            onClick={() => {
              // Shows "Loading versions…" while it tries (T39 review).
              setError(null);
              setHistory(null);
              load();
            }}
          >
            <Icon name="refresh" />
            Try Again
          </button>
        </div>
      ) : !history ? (
        <p className="history-empty muted loading" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading versions…
        </p>
      ) : (
        <>
          <div className="history-scroll">
            {/* Now: what this Mac has not synced yet, and Sync Now, quiet (finding 13). */}
            <div
              className="history-now"
              data-testid="history-now"
              data-pending={history.unversioned ? 'true' : undefined}
            >
              <AuthorMark authors={history.unversioned?.authors ?? []} />
              <span className="history-time">Now</span>
              <span className="history-summary">
                {history.unversioned ? 'Not saved as a version yet' : 'Synced'}
              </span>
              <button
                type="button"
                className="btn quiet history-save"
                data-ui="item"
                data-command="note.saveVersion"
                aria-describedby={`${heading}-auto`}
                disabled={busy}
                onClick={() => commands.run('note.saveVersion')}
              >
                {source.saveLabel}
              </button>
            </div>
            <ol
              ref={listRef}
              className="history-list"
              aria-label="Versions"
              onKeyDown={onListKeyDown}
            >
              {days.map((day) => (
                <li key={day.key} className="history-day-group">
                  <h3 className="history-day" id={`${heading}-day-${day.key}`}>
                    {day.label}
                  </h3>
                  <ol aria-labelledby={`${heading}-day-${day.key}`}>
                    {day.versions.map((v) => {
                      const described =
                        summaries.get(v.id) ??
                        (v.summary ? { summary: v.summary, gist: '' } : null);
                      const lines = described ? lineCounts(described.summary) : null;
                      const words = [
                        REASONS[v.reason] ?? v.reason,
                        described?.gist || (lines ? '' : described?.summary),
                      ]
                        .filter(Boolean)
                        .join(' · ');
                      const picked = selected === v.id;
                      return (
                        <li key={v.id} className="history-item">
                          <button
                            type="button"
                            className="history-entry"
                            data-ui="item"
                            data-version={v.id}
                            data-dim={described?.summary === 'No text changes' ? '' : undefined}
                            aria-pressed={picked}
                            tabIndex={v.id === (selected ?? history.versions[0]?.id) ? 0 : -1}
                            onClick={() => setSelected(v.id)}
                          >
                            <AuthorMark authors={v.authors} />
                            <span className="history-time">{clock(v.createdAt)}</span>
                            <span
                              className="history-summary"
                              aria-busy={described ? undefined : true}
                            >
                              {described ? (
                                words
                              ) : (
                                <span className="history-summary-pending" aria-hidden="true" />
                              )}
                            </span>
                            <span className="history-lines">
                              {lines ? (
                                <>
                                  {lines.added > 0 || lines.removed === 0 ? (
                                    <span className="history-added">+{lines.added}</span>
                                  ) : null}
                                  {lines.removed > 0 ? (
                                    <span className="history-removed">−{lines.removed}</span>
                                  ) : null}
                                </>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </li>
              ))}
              {history.versions.length === 0 ? (
                <li className="history-none muted">No versions yet.</li>
              ) : null}
            </ol>
            {version ? null : statusLine}
          </div>
          {version ? (
            <>
              <PaneResizer
                kind="historyPreview"
                orientation="horizontal"
                label="Resize the Versions and the Changes"
                width={previewHeight}
                edge="start"
                room={() => {
                  const panel = panelRef.current;
                  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
                  // Not laid out (hidden): the kind's own limit.
                  return panel && panel.clientHeight > 0
                    ? panel.clientHeight / rem - LIST_MIN_REM
                    : PANE_LIMITS.historyPreview.max;
                }}
                preview={(rem) =>
                  panelRef.current?.style.setProperty('--history-preview', `${rem}rem`)
                }
                commit={setPreviewHeight}
                testId="history-resizer"
              />
              <section className="history-detail" aria-label="Selected Version">
                <div className="history-detail-head">
                  <h3>{time(version.createdAt)}</h3>
                  <span className="muted">
                    {[
                      version.authors.map(authorName).join(', '),
                      shown?.previousId === null ? 'The first version' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <div className="history-diff" data-testid="history-diff">
                  {shown ? (
                    <DiffLines diff={shown.diff} />
                  ) : (
                    <p className="muted history-diff-loading">Reading the changes…</p>
                  )}
                </div>
                {statusLine}
                {conflicts.length > 0 ? (
                  <ul
                    className="history-conflicts"
                    aria-label="Conflicts"
                    data-testid="history-conflicts"
                  >
                    {conflicts.map((conflict, i) => (
                      <li key={i}>
                        <span className="muted">
                          {conflict.part === 'title' ? 'Title' : 'Text'} now:
                        </span>{' '}
                        <code>{conflict.ours.join('\n') || '(empty)'}</code>
                        <br />
                        <span className="muted">Before the edit:</span>{' '}
                        <code>{conflict.theirs.join('\n') || '(empty)'}</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="history-actions">
                  <button
                    type="button"
                    className="btn primary"
                    data-ui="submit"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => source.restore(version.id),
                        (body: HistoryChange) =>
                          body.changed
                            ? `Restored the version of ${time(version.createdAt)} as a new change.`
                            : 'The note already matches this version.',
                      )
                    }
                  >
                    <Icon name="history" />
                    Restore This Version
                  </button>
                  {canRevert ? (
                    <button
                      type="button"
                      className="btn"
                      data-ui="submit"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => source.revert(version.id),
                          (result: HistoryChange) => {
                            setConflicts(result.conflicts ?? []);
                            const n = result.conflicts?.length ?? 0;
                            if (n > 0) {
                              return `Reverted what did not overlap later edits. ${n} ${
                                n === 1 ? 'part was' : 'parts were'
                              } changed again since, and kept.`;
                            }
                            return result.changed
                              ? 'Reverted the agent’s edit; later edits are kept.'
                              : 'Nothing to revert: the note no longer has this edit.';
                          },
                        )
                      }
                    >
                      <Icon name="undo" />
                      Revert This Edit
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    data-ui="submit"
                    disabled={!shown}
                    onClick={copyText}
                  >
                    <Icon name="copy" />
                    Copy Text
                  </button>
                  <span
                    className="history-keys muted"
                    aria-hidden="true"
                    data-tip="↑ ↓ Move Between Versions"
                    data-tip-on="hover"
                  >
                    <span className="keys">
                      <kbd>↑</kbd>
                      <kbd>↓</kbd>
                    </span>
                    <span className="history-keys-word">versions</span>
                  </span>
                </div>
              </section>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
