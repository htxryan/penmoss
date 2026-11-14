/**
 * Settings → Notebooks (T50 G5, #153; A853–A857), in the Mac app: notebooks kept in a git
 * repository and synced by this Mac's own git. The first run (A1030) shows the same Add form.
 *
 * - **Add** (remote, branch, optional directory; a name when the target holds no notebook yet).
 *   Any repository: Penmoss asks nobody whether it is private (D61), and git follows its own
 *   configuration, rewrites included (D62).
 * - **The list, then one notebook's own page** (Ryan's feedback, 5 Nov 2026; A1098): the section
 *   lists the notebooks, each a row with its repository and sync state that opens its page at
 *   `/settings/git-notebooks/<id>`; Add a Git Notebook opens the form under the list.
 * - **Per notebook**: its name (Rename writes `notebook.json`, so every device follows; Ryan's
 *   review of PR #192), the sync status (last sync, waiting changes, the last
 *   error with the host's own words and the next retry, a full clone, hand-edited files the
 *   render overwrote), Sync now, the push delay and pull interval, signing, a personal access
 *   token (written only: it never comes back to the page), and Remove (Touch ID first; this
 *   Mac's copy and clone go; with changes not pushed, it says how many and offers to push first).
 *   Its agents and the penmoss command are Settings → Agents (A1098: LocalAgents.tsx).
 * - **Copy to Notebook** (A1353), under the list: whether a note copied to another notebook
 *   takes its tags, as the picker's Copy Tags first says. Synced, in the primary notebook.
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  desktop,
  type DesktopGit,
  type BrowseError,
  type GitHubRepo,
  type GitHubVia,
  type GitNotebookInfo,
  type GitPendingPurge,
} from '../desktop/bridge';
import { GitHubSignIn } from './GitHubSignIn';
import { RepoFolderStep, type FolderChoice } from './RepoFolderStep';
import { RepoPicker } from './RepoPicker';
import { gitNotebookPath, linkHandler, navigate, notebookAgentsPath } from '../router';
import { GitAgentActivity } from './GitAgentActivity';
import { mcpName } from './agent-words';
import { repositoryLink } from './repository-link';
import { onGitControl, takeGitControl } from './git-commands';
import {
  useAllSources,
  useGitInfo,
  useGitStatus,
  useSourcesRegistry,
  useSourcesState,
} from './hooks';
import type { GitSyncStatus } from './engine-host';
import { forgetGitStores } from './forget';
import type { GitSource } from './git-source';
import { copySettings } from './copy-settings';
import { setSettingsInStep, useSettingsInStepChoice } from './settings-in-step';
import { useCopyTagsDefault } from '../workspace/copy-tags-state';
import { NameClash } from './NameClash';
import { freeName, nameClash, useNotebookRename, useOtherNotebookNames } from './notebook-names';
import './sources.css';

const when = (at: number | null) =>
  at === null
    ? 'never'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);

const PHASES: Record<GitSyncStatus['phase'], string> = {
  starting: 'Starting',
  syncing: 'Syncing',
  synced: 'Synced',
  offline: 'Offline',
  stopped: 'Sync Stopped',
};

/** “3 notes have changes”, “The folders have changes”, “2 notes and the folders have changes”. */
function unpushedWords(notes: number, folders: boolean): string {
  const counted = notes === 1 ? '1 note' : `${notes} notes`;
  if (notes === 0) return 'The folders have changes';
  return `${counted}${folders ? ' and the folders' : ''} ${notes === 1 && !folders ? 'has' : 'have'} changes`;
}

/**
 * Delete for good whose confirmation ran out before its sync (A855): first the notes it would
 * take, named by main from the branch, then one Touch ID for those this Mac confirmed once
 * already. A note never confirmed here (a page script marked it) is listed apart and never sent
 * in that list (main would refuse it): Keep note takes the mark back, deleting nothing (Undo marks
 * it again), and Delete for good asks Touch ID for that note, named by main from the branch.
 */
function ReconfirmPurges({
  source,
  onDone,
}: {
  source: GitSource;
  onDone: (message: string) => void;
}) {
  const [notes, setNotes] = useState<readonly GitPendingPurge[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** Notes kept here (Keep note), each with its Undo until the panel closes. */
  const [kept, setKept] = useState<readonly GitPendingPurge[]>([]);
  const title = (note: GitPendingPurge) => note.title.trim() || 'Untitled';
  if (notes === null) {
    return (
      <button
        data-ui="item"
        type="button"
        className="btn"
        data-testid="git-reconfirm-purges"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void source
            .purgesToConfirm()
            .then((listed) => {
              if (listed) setNotes(listed);
              else onDone('This window cannot change git notebooks.');
            })
            .finally(() => setBusy(false));
        }}
      >
        Confirm Delete for Good Again…
      </button>
    );
  }
  const again = notes.filter((note) => note.confirmedBefore);
  const never = notes.filter(
    (note) => !note.confirmedBefore && !kept.some((one) => one.id === note.id),
  );
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };
  return (
    <div className="git-reconfirm" data-testid="git-reconfirm-panel">
      {again.length > 0 ? (
        <>
          <p>
            {again.length === 1 ? 'This note goes' : `These ${again.length} notes go`} for good at
            this sync (git history keeps {again.length === 1 ? 'it' : 'them'}). You confirmed{' '}
            {again.length === 1 ? 'it' : 'them'} once already; the confirmation ran out before the
            sync.
          </p>
          <ul data-testid="git-reconfirm-notes">
            {again.map((note) => (
              <li key={note.id}>{title(note)}</li>
            ))}
          </ul>
        </>
      ) : never.length === 0 && kept.length === 0 ? (
        <p>Nothing here to confirm again.</p>
      ) : null}
      {never.length > 0 ? (
        <>
          <p>
            Marked deleted for good but never confirmed on this Mac, so the sync stays stopped until
            each is kept or confirmed. Keep note puts it back where it was and deletes nothing.
          </p>
          <ul data-testid="git-reconfirm-never">
            {never.map((note) => (
              <li key={note.id} data-testid="git-never-note">
                <span>{title(note)}</span>{' '}
                <button
                  data-ui="item"
                  type="button"
                  className="btn"
                  data-testid="git-keep-note"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const refused = await source.keepNote(note.id);
                      if (refused) {
                        setNotes((list) => (list ?? []).filter((one) => one.id !== note.id));
                        onDone(refused);
                        return;
                      }
                      setKept((list) => [...list, note]);
                    })
                  }
                >
                  Keep Note
                </button>{' '}
                <button
                  data-ui="item"
                  type="button"
                  className="btn"
                  data-testid="git-purge-note"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const refused = await source.confirmPurge(note.id);
                      if (refused) {
                        onDone(refused);
                        return;
                      }
                      setNotes((list) => (list ?? []).filter((one) => one.id !== note.id));
                      onDone('Confirmed: Delete for good goes at this sync.');
                    })
                  }
                >
                  <Icon name="key" size={14} />
                  {/* No "…": Trash's and Android's are "Delete for Good" too (T39 pass 3, A894). */}
                  Delete for Good
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {kept.length > 0 ? (
        <ul data-testid="git-kept-notes">
          {kept.map((note) => (
            <li key={note.id}>
              Kept {title(note)}.{' '}
              <button
                data-ui="item"
                type="button"
                className="btn"
                data-testid="git-keep-undo"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await source.undoKeep(note.id);
                    setKept((list) => list.filter((one) => one.id !== note.id));
                  })
                }
              >
                Undo
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="settings-actions">
        {again.length > 0 ? (
          <button
            data-ui="item"
            type="button"
            className="btn"
            data-testid="git-reconfirm-confirm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void source
                .reconfirmPurges(again.map((note) => note.id))
                .then((refused) => {
                  setNotes(null);
                  onDone(refused ?? 'Confirmed: Delete for good goes at this sync.');
                })
                .finally(() => setBusy(false));
            }}
          >
            <Icon name="key" size={14} />
            Confirm {again.length === 1 ? '1 note' : `${again.length} notes`} with Touch ID
          </button>
        ) : null}
        <button
          data-ui="item"
          type="button"
          className="btn"
          data-testid="git-reconfirm-cancel"
          disabled={busy}
          onClick={() => {
            setNotes(null);
            setKept([]);
          }}
        >
          {kept.length > 0 ? 'Done' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

export function GitNotebooksSettings({ item }: { item?: string | undefined }) {
  const git = desktop()?.git;
  const state = useAllSources();
  const id = useId();
  const [identity, setIdentity] = useState<{ name: string; email: string } | null>(null);
  // Read again whenever Penmoss comes to the front or a notebook changes (#170 F3): a
  // `git config --global user.email` made meanwhile shows here, and commits use it next.
  useEffect(() => {
    if (!git) return;
    const read = () => void git.identity().then(setIdentity, () => undefined);
    read();
    window.addEventListener('focus', read);
    const off = git.onChange(read);
    return () => {
      window.removeEventListener('focus', read);
      off();
    };
  }, [git]);
  if (!git || !state) return null;
  const sources = state.all;
  if (item !== undefined) {
    const source = sources.find((each) => each.id === item);
    return (
      <section
        className="settings-section"
        aria-labelledby={`${id}-h`}
        data-testid="git-notebooks-settings"
      >
        <a
          href="/settings/git-notebooks"
          data-command="app.gitNotebooks"
          className="back-link git-notebook-back"
          data-testid="git-notebook-back"
          onClick={linkHandler('/settings/git-notebooks')}
        >
          <Icon name="arrowL" size={14} />
          Notebooks
        </a>
        {source ? (
          <GitNotebookCard key={source.id} source={source} git={git} identity={identity} />
        ) : (
          <>
            <h2 id={`${id}-h`}>Notebooks</h2>
            <p className="muted" data-testid="git-notebook-missing">
              That notebook isn’t on this Mac.
            </p>
          </>
        )}
      </section>
    );
  }
  return (
    <section
      className="settings-section"
      aria-labelledby={`${id}-h`}
      data-testid="git-notebooks-settings"
    >
      <h2 id={`${id}-h`}>Notebooks</h2>
      <p>
        Notebooks kept in a git repository you choose, beside your code if you like, synced with
        this Mac’s own git. Who can read the repository is yours to choose.
      </p>
      {identity ? (
        <p className="muted" data-testid="git-identity">
          Commits as {identity.name} &lt;{identity.email}&gt;, from git’s own configuration, unless
          a notebook has its own name and email.
        </p>
      ) : null}
      {sources.length === 0 ? (
        <p className="muted">No git notebooks on this Mac yet.</p>
      ) : (
        <ul className="git-notebook-list" data-testid="git-notebook-list">
          {sources.map((source) => (
            <GitNotebookRow key={source.id} source={source} />
          ))}
        </ul>
      )}
      {sources.length > 0 ? <CopyToNotebookSettings /> : null}
      <AddGitNotebookToggle git={git} open={sources.length === 0} />
    </section>
  );
}

/**
 * Copy to Notebook (A1353): whether the picker's Copy Tags starts ticked. On by default, as a
 * copy took its tags before. Synced like the rest of the app's settings (A1136).
 */
function CopyToNotebookSettings() {
  const { copies, set, canChange } = useCopyTagsDefault();
  const id = useId();
  return (
    <section
      className="git-notebook-group"
      aria-labelledby={`${id}-h`}
      data-testid="copy-to-notebook-settings"
    >
      <h3 id={`${id}-h`} className="settings-subhead">
        Copy to Notebook
      </h3>
      <label className="display-toggle">
        <input
          type="checkbox"
          checked={copies}
          disabled={!canChange}
          aria-describedby={`${id}-help`}
          data-testid="copy-tags-default"
          onChange={(event) => set(event.target.checked)}
        />
        <span>Copy Tags When Copying Notes to Another Notebook</span>
      </label>
      <p id={`${id}-help`} className="muted git-notebook-note">
        Where Copy Tags starts in Copy to Notebook’s picker; you can still change it for each copy.
        Tags typed in a note’s text, like #idea, are part of it and always go with it. Move to
        Notebook always keeps the tags. Changes sync to your other devices.
      </p>
    </section>
  );
}

/** A notebook in the list: its name, repository and sync state, opening its own page (A1098). */
function GitNotebookRow({ source }: { source: GitSource }) {
  const primary = useSourcesState()?.journal.id === source.id;
  const status = useGitStatus(source);
  const info = useGitInfo(source);
  const path = gitNotebookPath(source.id);
  return (
    <li>
      <a
        href={path}
        data-ui="item"
        className="git-notebook-row"
        data-testid="git-notebook-row"
        data-notebook-id={source.id}
        data-phase={status.phase}
        onClick={linkHandler(path)}
      >
        <Icon name="notebook" />
        <span className="git-notebook-row-text">
          <span className="git-notebook-row-name">
            {info.name}
            {primary ? (
              <span className="chip" data-testid="git-row-primary">
                Primary
              </span>
            ) : null}
          </span>
          <span className="git-notebook-row-repo muted">
            {info.repository}
            {info.dir ? ` · ${info.dir}` : ''} · {info.branch}
          </span>
        </span>
        <span className="git-notebook-row-state" data-phase={status.phase}>
          <span className="dot" aria-hidden="true" />
          {status.closing ? 'Pushing…' : PHASES[status.phase]}
        </span>
        <Icon name="chevR" size={14} />
      </a>
    </li>
  );
}

/** Add a Git Notebook: a button under the list that opens the form (open with none yet). */
function AddGitNotebookToggle({ git, open }: { git: DesktopGit; open: boolean }) {
  const [shown, setShown] = useState(open);
  if (shown || open) return <AddGitNotebook git={git} />;
  return (
    <div className="settings-actions">
      <button
        data-ui="item"
        type="button"
        className="btn"
        data-testid="git-add-open"
        onClick={() => setShown(true)}
      >
        <Icon name="plus" size={14} />
        Add a Git Notebook…
      </button>
    </div>
  );
}

function GitNotebookCard({
  source,
  git,
  identity,
}: {
  source: GitSource;
  git: DesktopGit;
  identity: { name: string; email: string } | null;
}) {
  const status = useGitStatus(source);
  const info = useGitInfo(source);
  const card = useRef<HTMLElement>(null);
  // A command took the person here (#170 F5): show and focus that control.
  useEffect(() => {
    const show = () => {
      const control = takeGitControl(source.id);
      if (!control) return;
      requestAnimationFrame(() => {
        const element = card.current?.querySelector<HTMLElement>(`[data-testid="${control}"]`);
        element?.scrollIntoView({ block: 'center' });
        element?.focus();
      });
    };
    show();
    return onGitControl(show);
  }, [source.id]);
  const registry = useSourcesRegistry();
  const primary = useSourcesState()?.journal.id === source.id;
  const [message, setMessage] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const waiting = status.pending.filter((each) => each !== 'workspace').length;

  const answer = async <T,>(
    run: () => Promise<
      | { ok: true; value: T }
      | { ok: false; error: { message: string; hostMessage?: string } }
      | null
    >,
    done: (value: T) => string,
  ) => {
    setBusy(true);
    try {
      const result = await run();
      if (!result) setMessage('This window cannot change git notebooks.');
      else if (result.ok) setMessage(done(result.value));
      else
        setMessage(
          result.error.hostMessage
            ? `${result.error.message} The host said: ${result.error.hostMessage}`
            : result.error.message,
        );
      await registry?.refresh();
    } finally {
      setBusy(false);
    }
  };

  /** What Remove would lose (null: not asked yet), and whether that was known. */
  const [removing, setRemoving] = useState<{
    readonly known: boolean;
    readonly notes: number;
    readonly folders: boolean;
  } | null>(null);

  const removeNow = (lost: { notes: number; folders: boolean } | null) =>
    void answer(
      () => git.remove(info.localId, lost ? lost.notes + (lost.folders ? 1 : 0) : null),
      () =>
        lost && lost.notes === 0 && !lost.folders
          ? `Removed “${info.name}” from this Mac. Everything was pushed: the repository keeps it all.`
          : `Removed “${info.name}” from this Mac. Changes that were not pushed are gone; the repository keeps everything pushed before.`,
    ).then(() => {
      setRemoving(null);
      // Its source has stopped (the list was read again): its local data goes too, and its page.
      if (!registry?.gitSource(source.id)) {
        void forgetGitStores(source.id);
        navigate('/settings/git-notebooks');
      }
    });

  /** Remove: straight to Touch ID when everything is pushed; otherwise say what would be lost. */
  const remove = async () => {
    const lost = await source.unpushed();
    if (lost && lost.notes === 0 && !lost.folders) removeNow(lost);
    else
      setRemoving({
        known: lost !== null,
        notes: lost?.notes ?? 0,
        folders: lost?.folders ?? false,
      });
  };

  return (
    <article
      ref={card}
      className="git-notebook git-notebook-page"
      data-testid="git-notebook"
      data-notebook-id={source.id}
      data-phase={status.phase}
      aria-labelledby={`${id}-name`}
    >
      {/* A page on the settings' own background, in groups under quiet headings (T62 item 1):
          it was one raised card, darker than the page on most themes and hard to read. */}
      <header className="git-notebook-head">
        <h2 id={`${id}-name`} className="git-notebook-title">
          <Icon name="notebook" />
          {info.name}
        </h2>
        {primary ? (
          <span className="chip" data-testid="git-primary-chip">
            Primary Notebook
          </span>
        ) : null}
        <span className="git-notebook-row-state" data-phase={status.phase}>
          <span className="dot" aria-hidden="true" />
          {status.closing ? 'Pushing…' : PHASES[status.phase]}
        </span>
      </header>
      <div className="settings-actions">
        <button
          data-ui="item"
          type="button"
          className="btn"
          data-testid="git-sync-now"
          onClick={() => {
            source.syncNow();
            setMessage('Syncing now.');
          }}
        >
          <Icon name="refresh" size={14} />
          Sync Now
        </button>
        <button
          data-ui="item"
          type="button"
          className="btn danger"
          data-testid="git-remove"
          disabled={busy}
          onClick={() => void remove()}
        >
          <Icon name="trash" size={14} />
          Remove from This Mac
        </button>
      </div>
      <p role="status" className="git-message muted" data-testid="git-message">
        {message}
      </p>
      {removing ? (
        <div className="git-remove-confirm" role="alert" data-testid="git-remove-confirm">
          <p>
            {removing.known
              ? `${unpushedWords(removing.notes, removing.folders)} not pushed yet: removing now loses ${removing.notes + (removing.folders ? 1 : 0) === 1 ? 'it' : 'them'}.`
              : 'Penmoss cannot tell yet whether everything here is pushed: removing now may lose changes.'}
          </p>
          <div className="settings-actions">
            <button
              data-ui="item"
              type="button"
              className="btn primary"
              data-testid="git-remove-push"
              onClick={() => {
                setRemoving(null);
                source.syncNow();
                setMessage('Pushing first. Remove once it says Synced.');
              }}
            >
              <Icon name="refresh" size={14} />
              Push First
            </button>
            <button
              data-ui="item"
              type="button"
              className="btn danger"
              data-testid="git-remove-anyway"
              disabled={busy}
              onClick={() =>
                removeNow(
                  removing.known ? { notes: removing.notes, folders: removing.folders } : null,
                )
              }
            >
              Remove Anyway
            </button>
            <button data-ui="item" type="button" className="btn" onClick={() => setRemoving(null)}>
              Keep It
            </button>
          </div>
        </div>
      ) : null}
      <NotebookName source={source} />
      <section className="git-notebook-group" aria-labelledby={`${id}-about`}>
        <h3 id={`${id}-about`} className="settings-subhead">
          About
        </h3>
        <dl className="settings-facts">
          <dt>Repository</dt>
          <dd data-testid="git-repository">
            {/* Its page, to open (A1128); "Private" went: noise unless sync is stopped. */}
            {repositoryLink(info) ? (
              <a
                href={repositoryLink(info)!}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="git-repository-link"
              >
                {info.repository}
              </a>
            ) : (
              info.repository
            )}
            {info.dir ? ` · ${info.dir}` : ''} · {info.branch}
          </dd>
          <dt>Agents</dt>
          <dd data-testid="git-notebook-agents">
            <code>penmoss mcp --notebook {mcpName(info.name)}</code> ·{' '}
            <a
              href={notebookAgentsPath(source.id)}
              data-ui="item"
              data-testid="git-notebook-agents-link"
              onClick={linkHandler(notebookAgentsPath(source.id))}
            >
              Settings → Agents
            </a>
          </dd>
          <dt>Sync</dt>
          <dd data-testid="git-status" data-phase={status.phase}>
            {status.closing ? 'Pushing…' : PHASES[status.phase]}
            {waiting > 0 ? ` · ${waiting} waiting` : ''} · last synced {when(status.lastSyncAt)}
            {status.nextRetryAt ? ` · tries again ${when(status.nextRetryAt)}` : ''}
          </dd>
          {status.detail ? (
            <>
              <dt>Last error</dt>
              <dd data-testid="git-error">
                <span role="status">
                  {status.detail}
                  {status.hostMessage && !status.detail.includes(status.hostMessage) ? (
                    <span className="muted"> The host said: {status.hostMessage}</span>
                  ) : null}
                </span>
                {status.code === 'purge_unconfirmed' ? (
                  <ReconfirmPurges source={source} onDone={setMessage} />
                ) : null}
              </dd>
            </>
          ) : null}
          {status.cleared || status.storageKept === false ? (
            <>
              <dt>Storage</dt>
              <dd data-testid="git-storage">
                <span role="status">
                  {status.cleared === 'lost'
                    ? 'This Mac’s storage for the notebook was cleared since it last synced here (macOS or the app’s data was cleared). The notes were fetched again from git; changes not pushed before then could not be kept.'
                    : status.cleared === 'kept'
                      ? 'This Mac’s engine storage for the notebook was cleared since it last synced here; the windows’ copies were still here and were taken in again, so nothing was lost.'
                      : 'The Mac may clear this notebook’s storage when space runs low; push often.'}
                </span>
              </dd>
            </>
          ) : null}
          {status.unreadable && status.unreadable.length > 0 ? (
            <>
              <dt>Unreadable</dt>
              <dd data-testid="git-unreadable">
                <span role="status">
                  {status.unreadable.length === 1
                    ? '1 copy of a note in this Mac’s windows couldn’t be read, so it was not taken in. It is left as it is; the rest of the notebook syncs.'
                    : `${status.unreadable.length} copies of notes in this Mac’s windows couldn’t be read, so they were not taken in. They are left as they are; the rest of the notebook syncs.`}
                </span>
              </dd>
            </>
          ) : null}
          {info.filterIgnored ? (
            <>
              <dt>Clone</dt>
              <dd>
                The host ignored the partial-clone filter, so this Mac holds every file of the
                repository.
              </dd>
            </>
          ) : null}
          {status.handEdits.length > 0 ? (
            <>
              <dt>Edited by hand</dt>
              <dd data-testid="git-hand-edits">
                Penmoss wrote these again from the notes (edit them in Penmoss):{' '}
                {status.handEdits.join(', ')}
              </dd>
            </>
          ) : null}
        </dl>
      </section>
      <PrimaryNotebook source={source} />
      <section className="git-notebook-group" aria-labelledby={`${id}-sync`}>
        <h3 id={`${id}-sync`} className="settings-subhead">
          Sync
        </h3>
        <div className="git-notebook-fields">
          <label className="settings-field">
            <span>Push after (seconds)</span>
            <input
              type="number"
              className="input"
              min={5}
              max={3600}
              defaultValue={info.pushDelayS}
              data-testid="git-push-delay"
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (value !== info.pushDelayS) {
                  void answer(
                    () => git.update(info.localId, { pushDelayS: value }),
                    () => `Pushes ${value} s after edits settle.`,
                  );
                }
              }}
            />
          </label>
          <label className="settings-field">
            <span>Pull every (minutes)</span>
            <input
              type="number"
              className="input"
              min={1}
              max={1440}
              defaultValue={info.pullEveryMin}
              data-testid="git-pull-interval"
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (value !== info.pullEveryMin) {
                  void answer(
                    () => git.update(info.localId, { pullEveryMin: value }),
                    () => `Pulls every ${value} min, and when Penmoss comes to the front.`,
                  );
                }
              }}
            />
          </label>
        </div>
        <label className="display-toggle">
          <input
            type="checkbox"
            checked={info.sign}
            onChange={(event) =>
              void answer(
                () => git.update(info.localId, { sign: event.target.checked }),
                () =>
                  event.target.checked
                    ? 'Signs commits as git’s configuration says.'
                    : 'Never signs this notebook’s commits.',
              )
            }
          />
          <span>Sign commits as git is configured to</span>
        </label>
      </section>
      <section className="git-notebook-group" aria-labelledby={`${id}-commits`}>
        <h3 id={`${id}-commits`} className="settings-subhead">
          Commits
        </h3>
        <CommitIdentity info={info} git={git} identity={identity} answer={answer} busy={busy} />
      </section>
      <section className="git-notebook-group" aria-labelledby={`${id}-access`}>
        <h3 id={`${id}-access`} className="settings-subhead">
          Access
        </h3>
        <form
          className="git-notebook-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const value = token.trim();
            setToken('');
            void answer(
              () => git.setToken(info.localId, value),
              () => 'Kept in the Keychain. Penmoss never shows it again.',
            ).then(() => source.syncNow());
          }}
        >
          <label className="settings-field">
            <span>
              Use a personal access token{' '}
              <span className="muted">
                {info.hasToken ? '(one is set)' : '(git’s own credentials otherwise)'}
              </span>
            </span>
            <input
              type="password"
              className="input"
              autoComplete="off"
              value={token}
              data-testid="git-token"
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <div className="settings-actions">
            <button
              type="submit"
              className="btn"
              data-ui="submit"
              disabled={busy || token.trim() === ''}
            >
              Save Token
            </button>
            {info.hasToken ? (
              <button
                data-ui="item"
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void answer(
                    () => git.setToken(info.localId, null),
                    () => 'Forgot the token: git’s own credentials are used.',
                  )
                }
              >
                Forget Token
              </button>
            ) : null}
          </div>
        </form>
      </section>
      <section className="git-notebook-group" aria-labelledby={`${id}-activity`}>
        <h3 id={`${id}-activity`} className="settings-subhead">
          Agent Activity
        </h3>
        <GitAgentActivity source={source} />
      </section>
    </article>
  );
}

/**
 * The Primary Notebook (T62 item 9; A827's Journal notebook, renamed): the one whose daily and
 * weekly notes, Calendar, Inbox and Quick Capture the app uses, and whose settings (theme,
 * display, shortcuts) it reads. This Mac's choice, made on the notebook's page; the first
 * notebook until one is chosen.
 */
/**
 * The notebook's name (Ryan's review of PR #192): Rename writes it to `notebook.json` at the next
 * sync, so every device and agent follows; a name another notebook here has is warned about.
 */
function NotebookName({ source }: { source: GitSource }) {
  const info = useGitInfo(source);
  const id = useId();
  const { rename, clash, message, cancel } = useNotebookRename(source);
  const [draft, setDraft] = useState(info.name);
  // Renamed elsewhere (the sidebar, another device): the field shows the new name.
  const [shown, setShown] = useState(info.name);
  if (shown !== info.name) {
    setShown(info.name);
    setDraft(info.name);
  }
  const unchanged = draft.trim() === '' || draft.trim() === info.name;
  return (
    <section className="git-notebook-group" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="settings-subhead">
        Name
      </h3>
      <form
        className="git-notebook-rename"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void rename(draft);
        }}
      >
        <label className="settings-field">
          <span>Notebook Name</span>
          <input
            className="input"
            maxLength={80}
            value={draft}
            data-testid="git-notebook-name"
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="btn"
          data-ui="submit"
          data-testid="git-notebook-rename"
          disabled={unchanged}
        >
          Rename
        </button>
      </form>
      <p className="muted">
        Renames it on every device that syncs it. Agents keep working: its old name still finds it.
        {info.pendingName ? ' The new name goes to the repository at the next sync.' : ''}
      </p>
      {clash ? (
        <NameClash
          name={clash.name}
          other={clash.other}
          suggestion={clash.suggestion}
          onUse={(name) => {
            setDraft(name);
            void rename(name);
          }}
          onKeep={() => void rename(clash.name, true)}
          onCancel={() => {
            cancel();
            setDraft(info.name);
          }}
        />
      ) : null}
      <p role="status" className="git-message muted" data-testid="git-rename-message">
        {message}
      </p>
    </section>
  );
}

function PrimaryNotebook({ source }: { source: GitSource }) {
  const registry = useSourcesRegistry();
  const state = useSourcesState();
  const id = useId();
  if (!registry || !state) return null;
  const primary = state.journal.id === source.id;
  return (
    <section className="git-notebook-group" aria-labelledby={`${id}-h`} data-testid="git-primary">
      <h3 id={`${id}-h`} className="settings-subhead">
        Primary Notebook
      </h3>
      <p className="git-notebook-note">
        Daily and weekly notes, the Calendar, the Inbox and Quick Capture use the primary notebook,
        and your theme, display and shortcut settings are kept in it.
      </p>
      {primary ? (
        <p className="muted git-notebook-note" data-testid="git-primary-state">
          {state.all.length < 2
            ? 'This is your primary notebook: it is the only one on this Mac.'
            : state.journalPicked
              ? 'This is your primary notebook on this Mac.'
              : 'This is your primary notebook on this Mac, as the first one added.'}
        </p>
      ) : (
        <div className="settings-actions">
          <button
            data-ui="item"
            type="button"
            className="btn"
            data-testid="git-make-primary"
            onClick={() => registry.setJournal(source.id)}
          >
            <Icon name="star" size={14} />
            Make Primary Notebook
          </button>
        </div>
      )}
      <NotebookSettingsCopy source={source} />
    </section>
  );
}

/**
 * Copying settings between notebooks (Quanta feedback 3, item 10; A1137). On another notebook's
 * page: its settings made the primary's, once. On the primary's: the others' made its own, once,
 * or kept in step from now on, on this Mac.
 */
function NotebookSettingsCopy({ source }: { source: GitSource }) {
  const state = useSourcesState();
  const inStep = useSettingsInStepChoice();
  const [done, setDone] = useState<string | null>(null);
  if (!state || state.all.length < 2) return null;
  const primary = state.root.id === source.id;
  const others = state.all.filter((each) => each.id !== state.root.id);
  const copy = () => {
    const targets = primary ? others : [source];
    const changed = targets.reduce(
      (sum, target) => sum + copySettings(state.root.workspace, target.workspace),
      0,
    );
    const where = primary ? 'the other notebooks' : source.name;
    setDone(
      changed === 0
        ? `${primary ? 'The other notebooks' : source.name} already had these settings.`
        : `Copied ${state.root.name}’s settings to ${where}.`,
    );
  };
  return (
    <div className="git-settings-copy" data-testid="git-settings-copy">
      <p className="git-notebook-note">
        {primary
          ? 'Copy these settings to your other notebooks, so any of them reads the same as the primary one, here or on another device.'
          : `Copy the settings of ${state.root.name}, your primary notebook, into this one, replacing its own.`}{' '}
        Quick Access stays as it is.
      </p>
      <div className="settings-actions">
        <button
          data-ui="item"
          type="button"
          className="btn"
          data-testid="git-copy-settings"
          disabled={primary && inStep}
          onClick={copy}
        >
          <Icon name="copy" size={14} />
          {primary ? 'Copy Settings to Other Notebooks' : `Copy Settings from ${state.root.name}`}
        </button>
      </div>
      {primary ? (
        <label className="display-toggle">
          <input
            type="checkbox"
            checked={inStep}
            data-testid="git-settings-in-step"
            onChange={(event) => {
              setSettingsInStep(event.target.checked);
              setDone(null);
            }}
          />
          <span>Keep the other notebooks’ settings in step with this one on this Mac</span>
        </label>
      ) : null}
      {done ? (
        <p className="muted git-notebook-note" role="status" data-testid="git-copy-settings-done">
          {done}
        </p>
      ) : null}
    </div>
  );
}

/**
 * This notebook's own commit name and email (#170 F6), over git's: a GitHub no-reply address
 * when the account keeps its email private (GH007). Empty uses git's own again.
 */
function CommitIdentity({
  info,
  git,
  identity,
  answer,
  busy,
}: {
  info: GitNotebookInfo;
  git: DesktopGit;
  identity: { name: string; email: string } | null;
  answer: <T>(
    run: () => Promise<
      | { ok: true; value: T }
      | { ok: false; error: { message: string; hostMessage?: string } }
      | null
    >,
    done: (value: T) => string,
  ) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = useState(info.author?.name ?? '');
  const [email, setEmail] = useState(info.author?.email ?? '');
  const now = info.author ?? identity;
  return (
    <form
      className="git-notebook-form"
      data-testid="git-author"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        const author =
          name.trim() === '' && email.trim() === ''
            ? null
            : { name: name.trim() || (identity?.name ?? ''), email: email.trim() };
        void answer(
          () => git.update(info.localId, { author }),
          () =>
            author
              ? `Commits as ${author.name} <${author.email}> from the next one.`
              : 'Commits as git’s own configuration says from the next one.',
        );
      }}
    >
      <label className="settings-field">
        <span>Commit name</span>
        <input
          className="input"
          autoComplete="off"
          value={name}
          placeholder={identity?.name ?? ''}
          data-testid="git-author-name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="settings-field">
        <span>
          Commit email{' '}
          <span className="muted">
            (this notebook only; a GitHub no-reply address keeps yours private)
          </span>
        </span>
        <input
          type="email"
          className="input"
          autoComplete="off"
          value={email}
          placeholder={identity?.email ?? ''}
          data-testid="git-author-email"
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <div className="settings-actions">
        <button type="submit" className="btn" data-ui="submit" disabled={busy}>
          Save
        </button>
      </div>
      {now ? (
        <p className="muted" data-testid="git-author-now">
          Commits as {now.name} &lt;{now.email}&gt;
          {info.author ? ', this notebook’s own.' : ', from git’s own configuration.'}
        </p>
      ) : null}
    </form>
  );
}

/**
 * How the Add form is asked (T69, A1146): Settings' one form for both (`any`), or the first
 * run's two ways on, a new notebook (its name asked at once) or one that exists (its name only
 * if the repository turns out to hold none).
 */
export type AddMode = 'any' | 'new' | 'existing';

/** What was added, for the first run (T69): its welcome note goes in a notebook it made. */
export interface Added {
  readonly notebookId: string;
  readonly name: string;
  readonly created: boolean;
}

/** Adds a git notebook, or makes one (Settings → Notebooks, and the first run, A1030). */
export function AddGitNotebook({
  git,
  mode = 'any',
  onAdded,
}: {
  git: DesktopGit;
  mode?: AddMode;
  /** After the list has the notebook (the first run opens the app then). */
  onAdded?: (added: Added) => void;
}) {
  const registry = useSourcesRegistry();
  const others = useOtherNotebookNames();
  const github = git.github;
  const [remote, setRemote] = useState('');
  const [branch, setBranch] = useState('main');
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [needsName, setNeedsName] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // T81 (B9): the repository step opens on Your Repositories where main can browse GitHub.
  const [way, setWay] = useState<'browse' | 'type'>(github ? 'browse' : 'type');
  const [picked, setPicked] = useState<GitHubRepo | null>(null);
  /** The sign-in the pick was listed with (T82): Penmoss's gives the notebook its token. */
  const [pickedVia, setPickedVia] = useState<GitHubVia | null>(null);
  const [folder, setFolder] = useState<FolderChoice>({ dir: '', notebook: null });
  const [known, setKnown] = useState<ReadonlySet<string>>(() => new Set());
  /** No GitHub sign-in git can use (B8): typing, with the hint and Try Again. */
  const [signedOut, setSignedOut] = useState<BrowseError | null>(null);
  const id = useId();

  const readKnown = () =>
    void git
      .list()
      .then((list) => setKnown(new Set(list.map((each) => each.notebookId))))
      .catch(() => undefined);
  useEffect(readKnown, [git]);

  const add = async (
    fields: {
      remote: string;
      branch: string;
      dir: string;
      name: string;
      githubSignIn?: boolean;
    } = {
      remote,
      branch,
      dir,
      name,
    },
  ) => {
    setBusy(true);
    setMessage(null);
    const githubSignIn = fields.githubSignIn ?? (picked !== null && pickedVia === 'penmoss');
    try {
      const result = await git.add({
        remote: fields.remote.trim(),
        branch: fields.branch.trim() || 'main',
        dir: fields.dir.trim(),
        ...(fields.name.trim() ? { name: fields.name.trim() } : {}),
        ...(githubSignIn ? { githubSignIn: true } : {}),
      });
      if (!result) {
        setMessage('This window cannot add git notebooks.');
        return;
      }
      if (!result.ok) {
        setMessage(
          result.error.hostMessage
            ? `${result.error.message} The host said: ${result.error.hostMessage}`
            : result.error.message,
        );
        return;
      }
      const value = result.value;
      if (value.kind === 'needs-name') {
        setNeedsName(true);
        setMessage('The repository holds no notebook there yet: name the new one.');
        return;
      }
      setNeedsName(false);
      setRemote('');
      setDir('');
      setName('');
      setPicked(null);
      setFolder({ dir: '', notebook: null });
      readKnown();
      // A name another notebook here has (Ryan's review of PR #192): agents can't tell them
      // apart, so say how to rename one.
      const twin = nameClash(value.notebook.name, others);
      setMessage(
        (value.created
          ? `Made the notebook “${value.notebook.name}”. It is pushed at its first sync.`
          : `Added “${value.notebook.name}”.`) +
          (twin
            ? ` Another notebook on this Mac is named “${twin}” too: rename one in its settings (such as to “${freeName(value.notebook.name, others)}”), so agents can tell them apart.`
            : ''),
      );
      await registry?.refresh();
      onAdded?.({
        notebookId: value.notebook.notebookId,
        name: value.notebook.name,
        created: value.created === true,
      });
    } finally {
      setBusy(false);
    }
  };

  /** A repository picked from the list (B3): its HTTPS address and default branch, at its root. */
  const pick = (repo: GitHubRepo, via: GitHubVia) => {
    setPicked(repo);
    setPickedVia(via);
    setRemote(repo.cloneUrl);
    setBranch(repo.defaultBranch || 'main');
    setDir('');
    setFolder({ dir: '', notebook: null });
    setNeedsName(false);
    setMessage(null);
  };

  const placeFields = (
    <div className="settings-row">
      <label className="settings-field">
        <span>Branch</span>
        <input
          className="input"
          value={branch}
          data-testid="git-add-branch"
          onChange={(event) => {
            setBranch(event.target.value);
            // A folder chosen on another branch may hold no notebook here: start at the root.
            if (picked !== null) {
              setFolder({ dir: '', notebook: null });
              setDir('');
              setNeedsName(false);
            }
          }}
        />
      </label>
      <label className="settings-field">
        <span>
          Directory <span className="muted">(optional, such as docs/notes)</span>
        </span>
        <input
          className="input"
          value={dir}
          data-testid="git-add-dir"
          onChange={(event) => {
            setDir(event.target.value);
            setFolder({ dir: event.target.value.trim(), notebook: null });
          }}
        />
      </label>
    </div>
  );
  const twin = nameClash(name, others);
  const nameField = (
    <>
      <label className="settings-field">
        <span>
          {mode === 'new' ? 'Notebook Name' : 'Name'}{' '}
          <span className="muted">
            {mode === 'new'
              ? '(shown in the sidebar)'
              : needsName
                ? '(the repository holds none: name it)'
                : '(for a new notebook)'}
          </span>
        </span>
        <input
          className="input"
          required={needsName || mode === 'new'}
          maxLength={80}
          value={name}
          placeholder={mode === 'new' ? 'Notes' : undefined}
          data-testid="git-add-name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {twin ? (
        <NameClash
          name={name.trim()}
          other={twin}
          suggestion={freeName(name, others)}
          onUse={setName}
        />
      ) : null}
    </>
  );
  const moreOptions =
    mode === 'any' ? (
      placeFields
    ) : (
      // The first run keeps branch and folder out of the way (T69): most repositories use main.
      <details className="first-run-more" data-testid="git-add-more">
        <summary>More Options</summary>
        {placeFields}
      </details>
    );
  const status = (
    <span role="status" className="muted" data-testid="git-add-message">
      {message}
    </span>
  );

  const browsing = github !== undefined && way === 'browse';
  const opensNotebook = browsing && picked !== null && folder.notebook !== null;

  let body: ReactNode;
  if (browsing && picked === null) {
    body = (
      <>
        <RepoPicker
          github={github}
          startNew={mode === 'new'}
          picked={null}
          onPick={pick}
          onTypeAddress={() => setWay('type')}
          onSignedOut={(error) => {
            setSignedOut(error);
            setWay('type');
          }}
          onCreated={(repo, notebookName, via) => {
            // Create, then Add at its root (B7); a failed Add leaves it picked, so trying again
            // makes no second repository.
            pick(repo, via);
            setName(notebookName);
            void add({
              remote: repo.cloneUrl,
              branch: repo.defaultBranch || 'main',
              dir: '',
              name: notebookName,
              githubSignIn: via === 'penmoss',
            });
          }}
        />
        {message ? <div className="settings-actions">{status}</div> : null}
      </>
    );
  } else if (browsing && picked !== null) {
    body = (
      <>
        <div className="repo-picked">
          <button
            type="button"
            className="btn"
            data-ui="item"
            data-testid="git-add-repos"
            onClick={() => {
              setPicked(null);
              setMessage(null);
            }}
          >
            <Icon name="chevL" size={14} />
            Repositories
          </button>
          <span data-testid="git-add-picked">
            <strong>{picked.fullName}</strong> <span className="muted">· {branch}</span>
          </span>
        </div>
        <RepoFolderStep
          github={github}
          repo={picked}
          branch={branch.trim() || picked.defaultBranch}
          added={known}
          chosen={folder}
          onChoose={(choice) => {
            setFolder(choice);
            setDir(choice.dir);
            setNeedsName(false);
            setMessage(null);
          }}
        />
        {moreOptions}
        {opensNotebook ? (
          <p data-testid="git-add-opens">
            This folder holds “{folder.notebook?.name}”, so this opens the existing notebook.
          </p>
        ) : (
          nameField
        )}
        <div className="settings-actions">
          <button
            type="submit"
            className="btn primary"
            data-ui="submit"
            disabled={busy || remote.trim() === '' || (!opensNotebook && name.trim() === '')}
          >
            <Icon name="plus" size={14} />
            {busy ? 'Adding…' : opensNotebook ? 'Open Notebook' : 'Make Notebook'}
          </button>
          {status}
        </div>
      </>
    );
  } else {
    body = (
      <>
        {github && signedOut ? (
          <div
            className="repo-signed-out"
            data-testid="git-add-signin"
            data-reason={signedOut.reason}
          >
            <p>
              {signedOut.reason === 'no_credential'
                ? 'Git on this Mac isn’t signed in to GitHub. Type the repository’s address below, or sign in to pick it from your repositories.'
                : `${signedOut.message} Type the repository’s address instead.`}
            </p>
            {github.signIn ? (
              <GitHubSignIn
                signIn={github.signIn}
                again={signedOut.reason === 'unauthorized'}
                onSignedIn={() => {
                  setSignedOut(null);
                  setWay('browse');
                }}
              />
            ) : null}
            <p className="muted">
              To pick from your repositories, run <code>gh auth login</code> in Terminal, then{' '}
              <code>gh auth setup-git</code>, then Try Again.
            </p>
            <div className="settings-actions">
              <button
                type="button"
                className="btn"
                data-ui="item"
                data-testid="git-add-signin-retry"
                onClick={() => {
                  setSignedOut(null);
                  setWay('browse');
                }}
              >
                <Icon name="refresh" size={14} />
                Try Again
              </button>
            </div>
          </div>
        ) : null}
        {mode === 'new' ? nameField : null}
        <label className="settings-field">
          <span>{mode === 'any' ? 'Remote' : 'Repository address'}</span>
          <input
            className="input"
            required
            placeholder="git@github.com:you/notes.git"
            value={remote}
            data-testid="git-add-remote"
            onChange={(event) => {
              setRemote(event.target.value);
              setPicked(null);
              setNeedsName(false);
            }}
          />
        </label>
        {moreOptions}
        {mode === 'any' || (mode === 'existing' && needsName) ? nameField : null}
        <div className="settings-actions">
          <button
            type="submit"
            className="btn primary"
            data-ui="submit"
            disabled={busy || remote.trim() === '' || (mode === 'new' && name.trim() === '')}
          >
            <Icon name="plus" size={14} />
            {mode === 'new' || (mode === 'existing' && needsName)
              ? 'Make Notebook'
              : mode === 'existing'
                ? 'Open Notebook'
                : 'Add'}
          </button>
          {status}
        </div>
      </>
    );
  }

  return (
    <form
      className="settings-card"
      aria-labelledby={`${id}-h`}
      data-testid="git-add"
      onSubmit={(event) => {
        event.preventDefault();
        void add(opensNotebook ? { remote, branch, dir, name: '' } : undefined);
      }}
    >
      <h3 id={`${id}-h`}>
        {mode === 'new'
          ? 'Make a new notebook'
          : mode === 'existing'
            ? 'Open a notebook'
            : 'Add a git notebook'}
      </h3>
      {github ? (
        <div className="repo-way" role="group" aria-label="How to choose the repository">
          <button
            type="button"
            className="btn"
            data-ui="item"
            aria-pressed={way === 'browse'}
            data-testid="git-add-way-browse"
            onClick={() => {
              setSignedOut(null);
              setWay('browse');
            }}
          >
            Your Repositories
          </button>
          <button
            type="button"
            className="btn"
            data-ui="item"
            aria-pressed={way === 'type'}
            data-testid="git-add-way-type"
            onClick={() => setWay('type')}
          >
            Type an Address
          </button>
        </div>
      ) : null}
      {body}
    </form>
  );
}
