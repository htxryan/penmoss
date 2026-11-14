import { Icon } from '@penmoss/ui/icons';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCommand, useCommands } from '../commands/hooks';
import { useNotes } from '../notes/hooks';
import { useSource } from '../sources/hooks';
import { Authors, DiffLines } from './parts';
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

const time = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Versions whose summaries are read first: about the rows on screen; the rest follow in one read. */
const FIRST_SUMMARIES = 20;
const NO_SUMMARIES: ReadonlyMap<number, string> = new Map();

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
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<readonly Conflict[]>([]);
  const [busy, setBusy] = useState(false);
  const heading = useId();

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
  const reread = async () => {
    const from = source;
    try {
      const next = await from.list();
      if (live.current === from) apply(next);
    } catch (caught) {
      if (live.current === from) setError(loadFailure(caught, from));
    }
  };

  // What each version changed, filled in once the list shows (Ryan's review of #192): the list
  // comes from the log alone, and the summaries take reading every version's text.
  // Kept with the source they were read from: another note's are never shown.
  const [read, setRead] = useState<{
    readonly of: HistorySource;
    readonly summaries: ReadonlyMap<number, string>;
  }>(() => ({ of: source, summaries: new Map() }));
  const summaries = read.of === source ? read.summaries : NO_SUMMARIES;
  useEffect(() => {
    if (!history) return;
    const wanted = history.versions.filter((v) => !v.summary).map((v) => v.id);
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

  return (
    <section className="history-panel" aria-labelledby={heading} data-testid="history-panel">
      <h2 id={heading} className="info-heading">
        Version History
      </h2>
      {/* Versions are automatic (A79); saving one by hand is the exception (T42, A574). */}
      <div className="history-auto" data-testid="history-auto">
        <p id={`${heading}-auto`} className="muted">
          {source.automatic}
        </p>
        <button
          type="button"
          className="btn quiet history-save"
          data-ui="item"
          data-command="note.saveVersion"
          aria-describedby={`${heading}-auto`}
          disabled={busy || !history}
          onClick={() => commands.run('note.saveVersion')}
        >
          {source.saveLabel}
        </button>
      </div>
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
        <div className="history-body">
          <ol className="history-list" aria-label="Versions">
            {history.unversioned ? (
              <li className="history-item" data-current="true">
                <div className="history-entry" aria-current="true">
                  <span className="history-time">Now</span>
                  <Authors authors={history.unversioned.authors} />
                  <span className="history-summary muted">Not saved as a version yet</span>
                </div>
              </li>
            ) : null}
            {history.versions.map((v) => {
              const summary = v.summary || summaries.get(v.id);
              return (
                <li key={v.id} className="history-item">
                  <button
                    type="button"
                    className="history-entry"
                    data-ui="item"
                    aria-pressed={selected === v.id}
                    onClick={() => setSelected(v.id)}
                  >
                    <span className="history-time">{time(v.createdAt)}</span>
                    <Authors authors={v.authors} />
                    <span className="history-summary muted" aria-busy={summary ? undefined : true}>
                      {[REASONS[v.reason] ?? v.reason, summary].filter(Boolean).join(' · ')}
                      {summary ? null : (
                        <span className="history-summary-pending" aria-hidden="true" />
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
            {history.versions.length === 0 && !history.unversioned ? (
              <li className="muted">No versions yet.</li>
            ) : null}
          </ol>
          {version ? (
            <section className="history-detail" aria-label="Changes in this version">
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
                  <Icon name="undo" />
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
                    Revert This Edit
                  </button>
                ) : null}
              </div>
              {status ? (
                <p className="history-status" role="status" data-testid="history-status">
                  {status}
                </p>
              ) : null}
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
              {detail && detail.id === version.id ? (
                <div className="history-diff" data-testid="history-diff">
                  <p className="muted history-diff-caption">
                    {detail.previousId === null
                      ? 'The first version'
                      : 'Changes since the version before'}
                  </p>
                  <DiffLines diff={detail.diff} />
                </div>
              ) : null}
            </section>
          ) : status ? (
            <p className="history-status" role="status" data-testid="history-status">
              {status}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
