import {
  addDays,
  isoWeek,
  longDate,
  parseIsoWeek,
  parsePlainDate,
  startOfDayIn,
  todayIn,
  weekMonday,
  type PlainDate,
} from '@penmoss/core/periodic';
import type { DiffOp } from '@penmoss/core/diff';
import {
  commitAt,
  liveTree,
  type NoteChange,
  type NoteChangeKind,
  type TimelineChanges,
  type TimelineCommit,
  type TimelineNoteText,
  type TimelineTree,
} from '@penmoss/git-notebook';
import { copyNote } from '@penmoss/sync-client/records';
import { Icon } from '@penmoss/ui/icons';
import type { FolderNode, NoteEntry } from '@penmoss/core/workspace';
import { useEffect, useId, useMemo, useState } from 'react';
import { readerOf, restoreToCommit, HistoryRefused } from '../history/source';
import { Authors, DiffLines } from '../history/parts';
import { timeZoneOf } from '../journal/journal';
import { linkHandler, navigate, notePath } from '../router';
import type { GitSource } from '../sources/git-source';
import { useGitStatus, useSource, useSourcesState } from '../sources/hooks';
import { timelineOf, type TimelineClient } from './client';
import { timeMachinePath, type TimeMachineTab } from './path';
import './time-machine.css';

/** A moment in the notebook's time zone: `3 Nov 2026, 14:05`. */
function moment(ms: number, zone: string): string {
  return new Date(ms).toLocaleString(undefined, {
    timeZone: zone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The calendar day of `ms` in the notebook's time zone. */
const dayOf = (ms: number, zone: string): PlainDate => todayIn(zone, new Date(ms));

function failure(caught: unknown): string {
  if (caught instanceof HistoryRefused && caught.message !== `HTTP ${caught.status}`) {
    return caught.message;
  }
  return caught instanceof Error && caught.message
    ? `That did not work: ${caught.message}`
    : 'That did not work. Try again in a moment.';
}

/**
 * The Time Machine (PEN-21): a git notebook as it was at any moment, from its git history.
 * **Notebook Then** picks a date or scrubs over the notebook's commits and shows its folders and
 * notes then; a note's text then, read-only, comes back with Restore. **What Changed** lists the
 * notes created, edited, renamed, moved and deleted in a range (this week by default, Monday to
 * Sunday in the notebook's time zone), who did it, and a diff per note. History is read off the
 * page's thread (`client.ts`).
 */
export function TimeMachinePage({ params }: { params: URLSearchParams }) {
  const scope = useSource();
  const state = useSourcesState();
  const tab: TimeMachineTab = params.get('tab') === 'changes' ? 'changes' : 'then';
  const source = scope?.kind === 'git' ? scope : null;
  const sources = state?.all ?? [];
  const heading = useId();
  const go = (next: { source?: string; tab?: TimeMachineTab }) =>
    navigate(
      timeMachinePath(next.source ?? source?.id ?? null, {
        tab: next.tab ?? tab,
        week: params.get('week'),
      }),
      { replace: true },
    );
  return (
    <div className="time-machine" data-testid="time-machine" data-tab={tab}>
      <header className="tm-head">
        <h2 id={heading}>Time Machine</h2>
        <p className="tm-lede muted">
          Your notebook as it was at any moment, read from its git history on this Mac.
        </p>
        <div className="tm-bar">
          {sources.length > 1 ? (
            <label className="tm-notebook">
              <span>Notebook</span>
              <select
                value={source?.id ?? ''}
                onChange={(event) => go({ source: event.currentTarget.value })}
              >
                {sources.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="tm-tabs" role="tablist" aria-label="Time Machine">
            <button
              type="button"
              role="tab"
              className="tm-tab"
              data-ui="option"
              aria-selected={tab === 'then'}
              onClick={() => go({ tab: 'then' })}
            >
              <Icon name="history" />
              Notebook Then
            </button>
            <button
              type="button"
              role="tab"
              className="tm-tab"
              data-ui="option"
              aria-selected={tab === 'changes'}
              onClick={() => go({ tab: 'changes' })}
            >
              <Icon name="week" />
              What Changed
            </button>
          </div>
        </div>
      </header>
      {!source ? (
        <p className="tm-empty muted">
          The Time Machine reads a git notebook’s history, and none is open here.
        </p>
      ) : tab === 'then' ? (
        <NotebookThen key={source.id} source={source} />
      ) : (
        <WhatChanged
          key={`${source.id}:${params.get('week') ?? ''}`}
          source={source}
          week={params.get('week')}
        />
      )}
    </div>
  );
}

/**
 * The commits, read again each time the page opens and whenever the notebook's head moves: a
 * sync brought others' commits, or pushed this Mac's (the first sync after launch, too).
 */
function useCommits(client: TimelineClient, head: string | null) {
  const [commits, setCommits] = useState<TimelineCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void client
      .commits(true)
      .then((list) => current && setCommits(list))
      .catch((caught: unknown) => current && setError(failure(caught)));
    return () => {
      current = false;
    };
  }, [client, head]);
  return { commits, error };
}

function NotebookThen({ source }: { source: GitSource }) {
  const client = useMemo(() => timelineOf(source), [source]);
  const zone = timeZoneOf(source.workspace.settings());
  const head = useGitStatus(source).head;
  const { commits, error } = useCommits(client, head);
  /** The commit shown: its place in `commits`, -1 before the first; null: the newest. */
  const [picked, setPicked] = useState<number | null>(null);
  const index = commits ? (picked ?? commits.length - 1) : -1;
  const commit = commits && index >= 0 ? (commits[index] ?? null) : null;
  const commitId = commit?.id ?? null;
  const [tree, setTree] = useState<TimelineTree | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  /** The note's text read last, for the note and commit it was read at. */
  const [read, setRead] = useState<{
    readonly key: string;
    readonly text: TimelineNoteText | null;
  } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  useEffect(() => {
    if (!commits) return;
    let current = true;
    void client
      .tree(commitId)
      .then((next) => {
        if (!current) return;
        setTree(next);
        setReadError(null);
      })
      .catch((caught: unknown) => current && setReadError(failure(caught)));
    return () => {
      current = false;
    };
  }, [client, commits, commitId]);

  const textKey = noteId && commitId ? `${noteId}@${commitId}` : null;
  useEffect(() => {
    if (!noteId || !commitId) return;
    let current = true;
    const key = `${noteId}@${commitId}`;
    void client
      .note(noteId, commitId)
      .then((text) => current && setRead({ key, text }))
      .catch(() => current && setRead({ key, text: null }));
    return () => {
      current = false;
    };
  }, [client, noteId, commitId]);
  /** Undefined while it is read. */
  const text = textKey !== null && read?.key === textKey ? read.text : undefined;
  /** Another commit, or another note: what was said of the last one goes. */
  const pick = (at: number) => {
    setPicked(at);
    setStatus(null);
  };
  const choose = (id: string) => {
    setNoteId(id);
    setStatus(null);
  };

  const shown = useMemo(() => (tree ? liveTree(tree) : null), [tree]);
  const date = commit ? dayOf(commit.at, zone).toString() : '';
  const pickDate = (value: string) => {
    const day = parsePlainDate(value);
    if (!day || !commits) return;
    // The notebook at the end of that day, in its time zone.
    const found = commitAt(commits, startOfDayIn(addDays(day, 1), zone), { before: true });
    pick(found ? commits.indexOf(found) : -1);
  };

  if (error)
    return (
      <p className="tm-empty muted" role="status">
        {error}
      </p>
    );
  if (!commits) {
    return (
      <p className="tm-empty muted loading" role="status">
        <span className="spinner" aria-hidden="true" />
        Reading the notebook’s history…
      </p>
    );
  }
  if (commits.length === 0) {
    return <p className="tm-empty muted">No history yet: this notebook has not been pushed.</p>;
  }
  const first = commits[0]!;
  const live = noteId ? source.notes.list().some((entry) => entry.id === noteId) : false;
  const inTrash = noteId ? source.notes.localTrash().some((entry) => entry.id === noteId) : false;

  const restoreVersion = async () => {
    if (!noteId || !commit) return;
    setBusy(true);
    setStatus(null);
    try {
      const { changed } = await restoreToCommit(source, source.notes, noteId, commit.id);
      setStatus(
        changed
          ? `Restored the note as it was on ${moment(commit.at, zone)}, as a new change.`
          : 'The note already matches this version.',
      );
    } catch (caught) {
      setStatus(failure(caught));
    } finally {
      setBusy(false);
    }
  };

  const restoreNote = async () => {
    if (!noteId || !commit || !text) return;
    setBusy(true);
    setStatus(null);
    try {
      if (inTrash) {
        // Out of Trash with its id, so links to it resolve again; then its text then.
        await source.notes.restoreFromTrash(noteId);
        try {
          await restoreToCommit(source, source.notes, noteId, commit.id);
        } catch (caught) {
          setStatus(`Restored the note from Trash, but not its text then. ${failure(caught)}`);
          return;
        }
        navigate(notePath(noteId));
        return;
      }
      // Deleted for good (A828): its id is never used again, so it comes back as a copy.
      const state = await readerOf(source).stateAt(noteId, commit.id);
      if (!state) throw new Error('Its logs could not be read.');
      const record = copyNote(state, { title: text.title });
      const folderThen = tree?.notes.find((note) => note.id === noteId)?.folderId ?? null;
      const folders = source.workspace.getState().snapshot.folders;
      const folderId =
        folderThen !== null && folders.some((folder) => folder.id === folderThen)
          ? folderThen
          : null;
      const id = source.notes.addCopy(record);
      source.workspace.registerNote(id, folderId);
      navigate(notePath(id));
    } catch (caught) {
      setStatus(failure(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="tm-then"
      data-testid="tm-then"
      data-commit={commit?.id ?? ''}
      data-where={client.where()}
    >
      <div className="tm-moment">
        <label className="tm-date">
          <span>Date</span>
          <input
            type="date"
            value={date}
            min={dayOf(Math.min(...commits.map((each) => each.at)), zone).toString()}
            max={todayIn(zone).toString()}
            onChange={(event) => pickDate(event.currentTarget.value)}
          />
        </label>
        <div className="tm-scrub">
          <button
            type="button"
            className="icon-btn"
            data-ui="item"
            aria-label="Earlier Commit"
            data-tip="Earlier Commit"
            disabled={index <= 0}
            onClick={() => pick(Math.max(0, index - 1))}
          >
            <Icon name="chevL" />
          </button>
          <input
            type="range"
            className="tm-scrubber"
            min={0}
            max={commits.length - 1}
            value={Math.max(0, index)}
            aria-label="Commit"
            aria-valuetext={
              commit ? `Commit ${index + 1} of ${commits.length}, ${moment(commit.at, zone)}` : ''
            }
            onChange={(event) => pick(Number(event.currentTarget.value))}
          />
          <button
            type="button"
            className="icon-btn"
            data-ui="item"
            aria-label="Later Commit"
            data-tip="Later Commit"
            disabled={index >= commits.length - 1}
            onClick={() => pick(Math.min(commits.length - 1, index + 1))}
          >
            <Icon name="chevR" />
          </button>
        </div>
        <p className="tm-place" role="status" data-testid="tm-place">
          {commit ? (
            <>
              <span>
                Commit {index + 1} of {commits.length} · {moment(commit.at, zone)}
              </span>
              <Authors authors={[commit.author]} />
            </>
          ) : (
            <span>Before the notebook’s first commit, on {moment(first.at, zone)}.</span>
          )}
        </p>
      </div>
      {readError ? <p className="tm-empty muted">{readError}</p> : null}
      <div className="tm-panes">
        <nav className="tm-tree" aria-label="Folders and notes then" data-testid="tm-tree">
          {!shown ? (
            <p className="muted loading">
              <span className="spinner" aria-hidden="true" />
              Reading…
            </p>
          ) : shown.folders.length === 0 && shown.notes.length === 0 ? (
            <p className="muted">No notes then.</p>
          ) : (
            <TreeList
              folders={shown.folders}
              notes={shown.notes}
              selected={noteId}
              onSelect={choose}
            />
          )}
        </nav>
        <section className="tm-note" aria-label="The note then" data-testid="tm-note">
          {!noteId ? (
            <p className="muted">Choose a note to read it as it was then.</p>
          ) : text === undefined ? (
            <p className="muted loading">
              <span className="spinner" aria-hidden="true" />
              Reading the note…
            </p>
          ) : text === null ? (
            <p className="muted">This note did not exist then.</p>
          ) : (
            <>
              <h3 className="tm-note-title">{text.title || 'Untitled'}</h3>
              <p className="tm-note-when muted">
                As it was on {commit ? moment(commit.at, zone) : ''}
                {live ? '' : inTrash ? ' · In Trash now' : ' · Deleted since'}
              </p>
              <div className="tm-actions">
                {live ? (
                  <>
                    <button
                      type="button"
                      className="btn primary"
                      data-ui="submit"
                      disabled={busy}
                      onClick={() => void restoreVersion()}
                    >
                      <Icon name="undo" />
                      Restore This Version
                    </button>
                    <a
                      className="btn quiet"
                      href={notePath(noteId)}
                      data-ui="item"
                      onClick={linkHandler(notePath(noteId))}
                    >
                      Open the Note
                    </a>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn primary"
                    data-ui="submit"
                    disabled={busy}
                    onClick={() => void restoreNote()}
                  >
                    <Icon name="undo" />
                    Restore Note
                  </button>
                )}
              </div>
              {status ? (
                <p className="tm-status" role="status" data-testid="tm-status">
                  {status}
                </p>
              ) : null}
              <pre className="tm-text" data-testid="tm-note-text" aria-label="Its text then">
                {text.markdown}
              </pre>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function TreeList({
  folders,
  notes,
  selected,
  onSelect,
}: {
  folders: readonly FolderNode[];
  notes: readonly NoteEntry[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="tm-list">
      {folders.map((folder) => (
        <li key={folder.id} className="tm-folder" data-folder={folder.name}>
          <span className="tm-folder-name">
            <Icon name="folder" size={14} />
            {folder.name}
          </span>
          {folder.folders.length > 0 || folder.notes.length > 0 ? (
            <TreeList
              folders={folder.folders}
              notes={folder.notes}
              selected={selected}
              onSelect={onSelect}
            />
          ) : null}
        </li>
      ))}
      {notes.map((note) => (
        <li key={note.id}>
          <button
            type="button"
            className="tm-note-row"
            data-ui="item"
            data-note={note.id}
            aria-pressed={selected === note.id}
            onClick={() => onSelect(note.id)}
          >
            <Icon name="file" size={14} />
            {note.title || 'Untitled'}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Monday to Sunday of the week `week` names, else of today's in the zone. */
function weekOf(week: string | null, zone: string): { from: PlainDate; to: PlainDate } {
  const named = week ? parseIsoWeek(week) : null;
  const monday = weekMonday(named ?? isoWeek(todayIn(zone)));
  return { from: monday, to: addDays(monday, 6) };
}

const KIND_WORDS: Record<NoteChangeKind, string> = {
  created: 'Created',
  edited: 'Edited',
  renamed: 'Renamed',
  moved: 'Moved',
  deleted: 'Deleted',
  restored: 'Restored',
};

function WhatChanged({ source, week }: { source: GitSource; week: string | null }) {
  const client = useMemo(() => timelineOf(source), [source]);
  const zone = timeZoneOf(source.workspace.settings());
  const [range, setRange] = useState(() => weekOf(week, zone));
  const span = `${range.from.toString()}:${range.to.toString()}`;
  const head = useGitStatus(source).head;
  /** The changes read last, for the range they were read for. */
  const [result, setResult] = useState<{
    readonly span: string;
    readonly changes: TimelineChanges | null;
    readonly error: string | null;
  } | null>(null);

  useEffect(() => {
    let current = true;
    const read = span;
    void client
      .commits(true)
      .then(() =>
        client.changes(startOfDayIn(range.from, zone), startOfDayIn(addDays(range.to, 1), zone)),
      )
      .then((changes) => current && setResult({ span: read, changes, error: null }))
      .catch(
        (caught: unknown) =>
          current && setResult({ span: read, changes: null, error: failure(caught) }),
      );
    return () => {
      current = false;
    };
    // `span` stands for the range; `head` reads it again after a sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, span, zone, head]);
  // Another range shows "Reading…" until it is read; a sync only refreshes what is shown.
  const changes = result?.span === span ? result.changes : null;
  const error = result?.span === span ? result.error : null;

  const shift = (weeks: number) =>
    setRange((now) => ({ from: addDays(now.from, weeks * 7), to: addDays(now.to, weeks * 7) }));
  const setEnd = (end: 'from' | 'to', value: string) => {
    const day = parsePlainDate(value);
    if (!day) return;
    setRange((now) => {
      const next = { ...now, [end]: day };
      return next.from.toString() <= next.to.toString() ? next : { from: day, to: day };
    });
  };

  return (
    <div className="tm-changes" data-testid="tm-changes" data-where={client.where()}>
      <div className="tm-range">
        <label className="tm-date">
          <span>From</span>
          <input
            type="date"
            value={range.from.toString()}
            onChange={(event) => setEnd('from', event.currentTarget.value)}
          />
        </label>
        <label className="tm-date">
          <span>To</span>
          <input
            type="date"
            value={range.to.toString()}
            onChange={(event) => setEnd('to', event.currentTarget.value)}
          />
        </label>
        <div className="tm-weeks">
          <button type="button" className="btn quiet" data-ui="item" onClick={() => shift(-1)}>
            <Icon name="chevL" />
            Previous Week
          </button>
          <button
            type="button"
            className="btn quiet"
            data-ui="item"
            onClick={() => setRange(weekOf(null, zone))}
          >
            This Week
          </button>
          <button type="button" className="btn quiet" data-ui="item" onClick={() => shift(1)}>
            Next Week
            <Icon name="chevR" />
          </button>
        </div>
      </div>
      <p className="tm-summary" role="status" data-testid="tm-summary">
        {error
          ? error
          : !changes
            ? 'Reading the notebook’s history…'
            : changes.notes.length === 0
              ? `Nothing changed from ${longDate(range.from)} to ${longDate(range.to)}.`
              : `${changes.notes.length} ${changes.notes.length === 1 ? 'note' : 'notes'} changed in ${changes.commits} ${changes.commits === 1 ? 'commit' : 'commits'}, ${longDate(range.from)} to ${longDate(range.to)}.`}
      </p>
      {changes && changes.notes.length > 0 ? (
        <ul className="tm-change-list" aria-label="Changed notes">
          {changes.notes.map((change) => (
            <ChangeRow key={change.noteId} change={change} changes={changes} client={client} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ChangeRow({
  change,
  changes,
  client,
}: {
  change: NoteChange;
  changes: TimelineChanges;
  client: TimelineClient;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<DiffOp[] | null | undefined>(undefined);
  const id = useId();
  useEffect(() => {
    if (!open || diff !== undefined) return;
    let current = true;
    void client
      .diff(change.noteId, changes.from, changes.to)
      .then((read) => current && setDiff(read.diff))
      .catch(() => current && setDiff(null));
    return () => {
      current = false;
    };
  }, [open, diff, client, change.noteId, changes.from, changes.to]);
  const title = change.title || 'Untitled';
  return (
    <li className="tm-change" data-kinds={change.kinds.join(' ')} data-note={change.noteId}>
      <div className="tm-change-head">
        <span className="tm-change-title">
          {change.live ? (
            <a
              href={notePath(change.noteId)}
              data-ui="item"
              onClick={linkHandler(notePath(change.noteId))}
            >
              {title}
            </a>
          ) : (
            title
          )}
        </span>
        <span className="tm-change-folder muted">{change.folder || 'Top level'}</span>
        <ul className="tm-kinds" aria-label="What changed">
          {change.kinds.map((kind) => (
            <li key={kind} className="tm-kind" data-kind={kind}>
              {KIND_WORDS[kind]}
              {kind === 'renamed' && change.previousTitle !== null
                ? ` from “${change.previousTitle || 'Untitled'}”`
                : kind === 'moved' && change.previousFolder !== null
                  ? ` from ${change.previousFolder || 'the top level'}`
                  : ''}
            </li>
          ))}
        </ul>
        <Authors authors={change.authors} />
        <button
          type="button"
          className="btn quiet tm-show"
          data-ui="item"
          aria-expanded={open}
          aria-controls={`${id}-diff`}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide Changes' : 'Show Changes'}
        </button>
      </div>
      {open ? (
        <div id={`${id}-diff`} className="history-diff tm-diff" data-testid="tm-diff">
          {diff === undefined ? (
            <p className="muted loading">
              <span className="spinner" aria-hidden="true" />
              Reading…
            </p>
          ) : diff === null ? (
            <p className="muted">The changes could not be read.</p>
          ) : (
            <DiffLines diff={diff} />
          )}
        </div>
      ) : null}
    </li>
  );
}
