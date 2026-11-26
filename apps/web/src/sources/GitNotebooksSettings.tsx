/**
 * Settings → Notebooks (T50 G5, #153; A853–A857; rebuilt in PEN-146), in the Mac app: notebooks
 * kept in a git repository and synced by this Mac's own git. Adding one is the first run's flow
 * (A1030, A1562).
 *
 * - **All Notebooks** (`/settings/git-notebooks`): the notebooks, each a row with its sync dot,
 *   name, Primary chip, and its repository and last sync (or what stopped it), opening its page;
 *   Add Notebook…, which opens the first run's own screens in a sheet (FirstRun.tsx's
 *   `AddNotebook`, A1562); Between Notebooks (the one Primary Notebook picker, this Mac's choice,
 *   then Keep Settings in Step, Copy Tags When Copying Notes, Copy Settings…); and Commit
 *   Identity, this Mac's git identity.
 * - **A notebook's page** (`/settings/git-notebooks/<id>`, each notebook also an entry in the
 *   nav, NotebookNavEntries.tsx): a header with its name, the Primary chip, the sync dot and
 *   time, and Sync Now; a stopped sync's words under it on every tab; then three tabs, kept in
 *   the URL (`?tab=sync`, `?tab=git`):
 *   - **Overview**: Name (Rename writes `notebook.json`, so every device follows), Repository
 *     (Open on GitHub), how many notes, Copy Settings…, and Remove from This Mac… at the foot
 *     (Touch ID first; with changes not pushed, it says how many and offers to push first).
 *   - **Sync**: Push Changes and Pull Changes as menus in words, the sync's state, and the
 *     diagnostics (a full clone, cleared storage, unreadable copies, hand-edited files the render
 *     overwrote) under a closed Details.
 *   - **Git**: this notebook's own commit name and email, signing, and the sign-in it uses (a
 *     personal access token, written only: it never comes back to the page).
 *   Its agents are Settings → Agents, and what they changed Settings → Agent Activity: agents are
 *   not a notebook's, since the MCP server is to work across notebooks.
 */
import { Icon } from '@penmoss/ui/icons';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { desktop, type DesktopGit } from '../desktop/bridge';
import { AddNotebook } from './FirstRun';
import { gitNotebookPath, linkHandler, navigate, useLocation } from '../router';
import { NotebookBadge } from './NotebookBadge';
import { onGitControl, takeGitControl, type GitControl } from './git-commands';
import {
  useAllSources,
  useGitInfo,
  useGitStatus,
  useShownGitStatus,
  useSourcesRegistry,
  useSourcesState,
} from './hooks';
import type { GitSource } from './git-source';
import { GroupHead, SettingRow } from '../theme/look-rows';
import { dotState, syncLine } from './sync-words';
import {
  CONTROL_TAB,
  notebookTab,
  notebookTabPath,
  NOTEBOOK_TABS as TABS,
  type NotebookTab,
} from './notebook-tabs';
import './sources.css';
import './notebook-settings.css';
import { SettingsHeader } from '../pages/SettingsHeader';
import { useNow } from '../shell/use-now';
import { BetweenNotebooks } from './BetweenNotebooks';
import { type Answer, TICK_MS, when } from './notebook-settings-shared';
import { ReconfirmPurges } from './ReconfirmPurges';
import { OverviewTab } from './NotebookOverviewTab';
import { SyncTab } from './NotebookSyncTab';
import { GitTab } from './NotebookGitTab';

/**
 * Git's own name and email on this Mac, read again whenever Penmoss comes to the front or a
 * notebook changes (#170 F3): a `git config --global user.email` made meanwhile shows here, and
 * commits use it next.
 */
function useGitIdentity(git: DesktopGit | undefined) {
  const [identity, setIdentity] = useState<{ name: string; email: string } | null>(null);
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
  return identity;
}

export function GitNotebooksSettings({ item }: { item?: string | undefined }) {
  const git = desktop()?.git;
  const state = useAllSources();
  const id = useId();
  const identity = useGitIdentity(git);
  if (!git) return null;
  const sources = state.all;
  if (item !== undefined) {
    const source = sources.find((each) => each.id === item);
    return (
      <section
        className="settings-section nset-page"
        aria-labelledby={`${id}-h`}
        data-testid="git-notebooks-settings"
      >
        {source ? (
          <GitNotebookCard
            key={source.id}
            source={source}
            git={git}
            identity={identity}
            headingId={`${id}-h`}
          />
        ) : (
          <>
            <SettingsHeader id={`${id}-h`} title="Notebook" />
            <p className="muted" data-testid="git-notebook-missing">
              That notebook isn’t on this Mac.{' '}
              <a
                href="/settings/git-notebooks"
                data-command="app.gitNotebooks"
                onClick={linkHandler('/settings/git-notebooks')}
              >
                All Notebooks
              </a>
            </p>
          </>
        )}
      </section>
    );
  }
  return <AllNotebooks git={git} identity={identity} headingId={`${id}-h`} />;
}

/** All Notebooks: the list, Add Notebook…, Between Notebooks (Primary first), git's identity. */
function AllNotebooks({
  git,
  identity,
  headingId,
}: {
  git: DesktopGit;
  identity: { name: string; email: string } | null;
  headingId: string;
}) {
  const state = useAllSources();
  const sources = state.all;
  const [adding, setAdding] = useState(false);
  const close = useCallback(() => setAdding(false), []);
  return (
    <section
      className="settings-section nset-page"
      aria-labelledby={headingId}
      data-testid="git-notebooks-settings"
    >
      <SettingsHeader
        id={headingId}
        title="All Notebooks"
        actions={
          <button
            data-event="settings.git-notebooks.add"
            data-ui="item"
            type="button"
            className="btn primary"
            data-testid="git-add-open"
            data-setting="add-notebook"
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" size={14} />
            Add Notebook…
          </button>
        }
      />
      {sources.length === 0 ? (
        <p className="muted">No notebooks on this Mac yet.</p>
      ) : (
        <ul className="git-notebook-list" data-testid="git-notebook-list">
          {sources.map((source) => (
            <GitNotebookRow key={source.id} source={source} />
          ))}
        </ul>
      )}
      {/* The first run's own screens, in a sheet over Settings (A1562). */}
      {adding ? <AddNotebook git={git} onClose={close} /> : null}
      {sources.length > 0 ? (
        <>
          <BetweenNotebooks />
          <GroupHead scope>Commit Identity</GroupHead>
          <div className="lf-group">
            <SettingRow
              setting="commit-identity"
              testId="git-identity"
              label={identity ? identity.name : 'No Name Set'}
              help={
                identity
                  ? `${identity.email} · from git’s own configuration. A notebook can have its own on its Git tab.`
                  : 'Git on this Mac has no user.name and user.email yet: set them with git config --global.'
              }
            />
          </div>
        </>
      ) : null}
    </section>
  );
}

/** A notebook in the list: its sync dot, name, repository and last sync, opening its page. */
function GitNotebookRow({ source }: { source: GitSource }) {
  const primary = useSourcesState().journal.id === source.id;
  const status = useShownGitStatus(source);
  const info = useGitInfo(source);
  const now = useNow(TICK_MS);
  const path = gitNotebookPath(source.id);
  const stopped = status.phase === 'stopped' && status.detail;
  return (
    <li>
      <a
        data-event="settings.git-notebooks.row.open"
        href={path}
        data-ui="item"
        className="git-notebook-row"
        data-testid="git-notebook-row"
        data-notebook-id={source.id}
        data-phase={status.phase}
        onClick={linkHandler(path)}
      >
        {/* Its badge (PEN-140), its sync dot beside it; the name after them says it aloud. */}
        <NotebookBadge source={source} size={16} decorative />
        <span className="nset-dot" data-state={dotState(status)} aria-hidden="true" />
        <span className="git-notebook-row-text">
          <span className="git-notebook-row-name">
            {info.name}
            {primary ? (
              <span className="chip" data-testid="git-row-primary">
                Primary
              </span>
            ) : null}
          </span>
          <span
            className={`git-notebook-row-repo ${stopped ? 'nset-danger' : 'muted'}`}
            data-testid="git-row-state"
          >
            {stopped
              ? `${status.detail}${status.lastSyncAt ? ` · Last Synced ${when(status.lastSyncAt)}` : ''}`
              : `${info.repository} · ${syncLine(status, now)}`}
          </span>
        </span>
        <Icon name="chevR" size={14} />
      </a>
    </li>
  );
}

function GitNotebookCard({
  source,
  git,
  identity,
  headingId,
}: {
  source: GitSource;
  git: DesktopGit;
  identity: { name: string; email: string } | null;
  headingId: string;
}) {
  const status = useGitStatus(source);
  const info = useGitInfo(source);
  const location = useLocation();
  const tab = notebookTab(location.search);
  const now = useNow(TICK_MS);
  const card = useRef<HTMLElement>(null);
  /** The control a command asked for, focused once its tab shows. */
  const [wanted, setWanted] = useState<GitControl | null>(null);
  // A command took the person here (#170 F5): open that control's tab, then focus it.
  useEffect(() => {
    const show = () => {
      const control = takeGitControl(source.id);
      if (!control) return;
      const on = CONTROL_TAB[control];
      if (on) navigate(notebookTabPath(source.id, on), { replace: true });
      setWanted(control);
    };
    show();
    return onGitControl(show);
  }, [source.id]);
  useEffect(() => {
    if (!wanted) return;
    const frame = requestAnimationFrame(() => {
      const element = card.current?.querySelector<HTMLElement>(`[data-testid="${wanted}"]`);
      if (!element) return;
      element.scrollIntoView({ block: 'center' });
      element.focus();
      setWanted(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [wanted, tab]);
  const registry = useSourcesRegistry();
  const primary = useSourcesState().journal.id === source.id;
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const waiting = status.pending.filter((each) => each !== 'workspace').length;

  const answer: Answer = async (run, done) => {
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
      await registry.refresh();
    } finally {
      setBusy(false);
    }
  };

  const choose = (next: NotebookTab) =>
    navigate(notebookTabPath(source.id, next), { replace: true });
  /** Arrow keys move between the tabs, as a tab list's do. */
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((each) => each.id === tab);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const next =
      event.key === 'Home'
        ? TABS[0]
        : event.key === 'End'
          ? TABS[TABS.length - 1]
          : step
            ? TABS[(at + step + TABS.length) % TABS.length]
            : undefined;
    if (!next) return;
    event.preventDefault();
    choose(next.id);
    requestAnimationFrame(() =>
      card.current?.querySelector<HTMLElement>(`[data-testid="git-tab-${next.id}"]`)?.focus(),
    );
  };

  return (
    <article
      ref={card}
      className="git-notebook git-notebook-page"
      data-testid="git-notebook"
      data-notebook-id={source.id}
      data-phase={status.phase}
      data-tab={tab}
      aria-labelledby={headingId}
    >
      {/* A page on the settings' own background (T62 item 1), its header over three tabs. */}
      <SettingsHeader
        id={headingId}
        title={
          <>
            <NotebookBadge source={source} size={26} decorative />
            {info.name}
          </>
        }
        barTitle={info.name}
        beside={
          primary ? (
            <span className="chip" data-testid="git-primary-chip">
              Primary
            </span>
          ) : null
        }
        intro={
          <span
            className="git-notebook-row-state nset-head-state"
            data-testid="git-status"
            data-phase={status.phase}
          >
            <span className="nset-dot" data-state={dotState(status)} aria-hidden="true" />
            {syncLine(status, now)}
            {waiting > 0 ? ` · ${waiting} Waiting` : ''}
          </span>
        }
        actions={
          <button
            data-event="settings.git-notebooks.sync-now"
            data-ui="item"
            type="button"
            className="btn"
            data-testid="git-sync-now"
            data-setting="sync-now"
            onClick={() => {
              source.syncNow();
              setMessage('Syncing now.');
            }}
          >
            <Icon name="refresh" size={14} />
            Sync Now
          </button>
        }
      />
      <p role="status" className="git-message muted" data-testid="git-message">
        {message}
      </p>
      {status.detail ? (
        <div className="nset-error" data-testid="git-error">
          <span role="status">
            {status.detail}
            {status.hostMessage && !status.detail.includes(status.hostMessage) ? (
              <span className="muted"> The host said: {status.hostMessage}</span>
            ) : null}
            {status.nextRetryAt ? (
              <span className="muted"> Tries again {when(status.nextRetryAt)}.</span>
            ) : null}
          </span>
          {status.code === 'purge_unconfirmed' ? (
            <ReconfirmPurges source={source} onDone={setMessage} />
          ) : null}
        </div>
      ) : null}
      <div
        className="nset-tabs"
        role="tablist"
        aria-label={`${info.name} Settings`}
        onKeyDown={onTabKey}
      >
        {TABS.map((each) => (
          <button
            data-event="settings.git-notebooks.tab"
            key={each.id}
            type="button"
            role="tab"
            id={`${id}-tab-${each.id}`}
            className="nset-tab"
            data-ui="option"
            data-testid={`git-tab-${each.id}`}
            aria-selected={tab === each.id}
            aria-controls={`${id}-panel`}
            tabIndex={tab === each.id ? 0 : -1}
            onClick={() => choose(each.id)}
          >
            {each.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        className="nset-panel-body"
        aria-labelledby={`${id}-tab-${tab}`}
        data-testid={`git-panel-${tab}`}
      >
        {tab === 'overview' ? (
          <OverviewTab
            source={source}
            git={git}
            answer={answer}
            busy={busy}
            onMessage={setMessage}
          />
        ) : tab === 'sync' ? (
          <SyncTab source={source} git={git} answer={answer} now={now} />
        ) : (
          <GitTab source={source} git={git} identity={identity} answer={answer} busy={busy} />
        )}
      </div>
    </article>
  );
}
