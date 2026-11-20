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
 *   the URL (`?tab=sync`, `?tab=git`) as the Time Machine keeps its own:
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
import { Select } from '@penmoss/ui/controls/Select';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  desktop,
  type DesktopGit,
  type GitNotebookInfo,
  type GitPendingPurge,
} from '../desktop/bridge';
import { AddNotebook } from './FirstRun';
import { gitNotebookPath, linkHandler, navigate, useLocation } from '../router';
import { BadgeSettings } from './BadgeSettings';
import { NotebookBadge } from './NotebookBadge';
import { repositoryLink } from './repository-link';
import { onGitControl, takeGitControl, type GitControl } from './git-commands';
import {
  useAllSources,
  useGitInfo,
  useGitStatus,
  useShownGitStatus,
  useSourcesRegistry,
  useSourcesState,
} from './hooks';
import { forgetGitStores } from './forget';
import type { GitSource } from './git-source';
import { copySettings } from './copy-settings';
import { setSettingsInStep, useSettingsInStepChoice } from './settings-in-step';
import { useCopyTagsDefault } from '../workspace/copy-tags-state';
import { NameClash } from './NameClash';
import { useNotebookRename } from './notebook-names';
import { GroupHead, SettingRow, Switch } from '../theme/look-rows';
import { NotebookAiRow } from './NotebookAiRow';
import {
  PHASE_WORDS,
  agoWords,
  dotState,
  pullChoices,
  pullWords,
  pushChoices,
  pushWords,
  syncLine,
} from './sync-words';
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
import { ConfirmBlock } from '../shell/ConfirmBlock';
import { withoutRecording } from '../analytics/track';

const when = (at: number | null) =>
  at === null
    ? 'never'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);

/** “3 notes have changes”, “The folders have changes”, “2 notes and the folders have changes”. */
function unpushedWords(notes: number, folders: boolean): string {
  const counted = notes === 1 ? '1 note' : `${notes} notes`;
  if (notes === 0) return 'The folders have changes';
  return `${counted}${folders ? ' and the folders' : ''} ${notes === 1 && !folders ? 'has' : 'have'} changes`;
}

/** Now, again every half minute, so "Synced 2 min ago" keeps up. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

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

/** How many notes a notebook holds, as its list changes. */
function useNoteCount(source: GitSource): number {
  return useSyncExternalStore(
    (listener) => source.notes.subscribe(listener),
    () => source.notes.list().length,
    () => source.notes.list().length,
  );
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
        data-event="settings.git-notebooks.reconfirm.open"
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
    <ConfirmBlock className="git-reconfirm" title="Delete for Good?" testId="git-reconfirm-panel">
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
                  data-event="settings.git-notebooks.reconfirm.keep-note"
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
                  data-event="settings.git-notebooks.reconfirm.purge-note"
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
                data-event="settings.git-notebooks.reconfirm.undo-keep"
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
            data-event="settings.git-notebooks.reconfirm.confirm"
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
            Confirm {again.length === 1 ? '1 Note' : `${again.length} Notes`} with Touch ID
          </button>
        ) : null}
        <button
          data-event="settings.git-notebooks.reconfirm.cancel"
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
    </ConfirmBlock>
  );
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
        intro="The notebooks on this Mac, and what goes between them."
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
  const now = useNow();
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

/**
 * The Primary Notebook (A1101; PEN-146): the one whose daily and weekly notes, Calendar, Inbox
 * and Quick Capture the app uses, and whose settings it reads. This Mac's choice, made here once
 * for all the notebooks; the first notebook until one is chosen. Between Notebooks' first row
 * (A1558), since it is where the settings the other rows copy come from.
 */
function PrimaryPicker() {
  const registry = useSourcesRegistry();
  const state = useSourcesState();
  const id = useId();
  return (
    <SettingRow
      setting="primary-notebook"
      label="Primary Notebook"
      labelFor={`${id}-select`}
      help="Holds your journal, Inbox and these settings"
      helpId={`${id}-help`}
      testId="git-primary"
      scope
    >
      <Select
        id={`${id}-select`}
        value={state.journal.id}
        aria-describedby={`${id}-help`}
        data-testid="git-primary-picker"
        disabled={state.all.length < 2}
        onChange={(event) => registry.setJournal(event.currentTarget.value)}
      >
        {state.all.map((source) => (
          <option key={source.id} value={source.id}>
            {source.name}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}

/**
 * Between Notebooks: the Primary Notebook first, then what goes from one notebook to another.
 * Keep Settings in Step (A1137, this
 * Mac's choice) copies each change of the primary's settings to the others; Copy Tags When
 * Copying Notes (A1353, synced) is where Copy to Notebook's Copy Tags starts; Copy Settings…
 * copies one notebook's settings into another, once.
 */
function BetweenNotebooks() {
  const state = useSourcesState();
  const inStep = useSettingsInStepChoice();
  const { copies, set, canChange } = useCopyTagsDefault();
  const [copying, setCopying] = useState(false);
  const id = useId();
  const several = state.all.length > 1;
  return (
    <>
      <GroupHead>Between Notebooks</GroupHead>
      <div className="lf-group">
        <PrimaryPicker />
        {several ? (
          <SettingRow
            setting="keep-settings-in-step"
            label="Keep Settings in Step"
            labelFor={`${id}-step`}
            help={`A change to ${state.journal.name}’s settings goes to the other notebooks`}
            scope
          >
            <Switch
              id={`${id}-step`}
              checked={inStep}
              data-testid="git-settings-in-step"
              onChange={(event) => setSettingsInStep(event.target.checked)}
            />
          </SettingRow>
        ) : null}
        <SettingRow
          setting="copy-tags-when-copying-notes"
          label="Copy Tags When Copying Notes"
          labelFor={`${id}-tags`}
          help="Where Copy Tags starts in Copy to Notebook; tags typed in a note’s text always go with it"
          testId="copy-to-notebook-settings"
        >
          <Switch
            id={`${id}-tags`}
            checked={copies}
            disabled={!canChange}
            data-testid="copy-tags-default"
            onChange={(event) => set(event.target.checked)}
          />
        </SettingRow>
        {several ? (
          <SettingRow
            setting="copy-settings"
            label="Copy Settings…"
            help="From one notebook to another, once"
          >
            <button
              data-event="settings.git-notebooks.copy-settings.open"
              data-ui="item"
              type="button"
              className="btn"
              aria-expanded={copying}
              data-testid="git-copy-settings-open"
              onClick={() => setCopying((was) => !was)}
            >
              <Icon name="copy" size={14} />
              Copy…
            </button>
          </SettingRow>
        ) : null}
        {several && copying ? (
          <CopySettingsPanel
            from={state.journal.id}
            to={ALL_OTHERS}
            onClose={() => setCopying(false)}
          />
        ) : null}
      </div>
    </>
  );
}

const ALL_OTHERS = '*';

/**
 * Copy Settings… (A1137; PEN-146): one notebook's settings written into another, or into every
 * other, replacing theirs, once. Quick Access stays as it is: its pins are each notebook's own.
 */
function CopySettingsPanel({
  from: firstFrom,
  to: firstTo,
  onClose,
}: {
  from: string;
  to: string;
  onClose: () => void;
}) {
  const state = useSourcesState();
  const [from, setFrom] = useState(firstFrom);
  const [to, setTo] = useState(firstTo);
  const [done, setDone] = useState<string | null>(null);
  const id = useId();
  const source = state.all.find((each) => each.id === from) ?? state.journal;
  const others = state.all.filter((each) => each.id !== source.id);
  // Every other notebook, or one: the only other one when there is one, the first when the one
  // chosen became From.
  const target =
    to === ALL_OTHERS
      ? others.length === 1
        ? others[0]!
        : null
      : (others.find((each) => each.id === to) ?? others[0] ?? null);
  const targets = target ? [target] : others;
  const copy = () => {
    const changed = targets.reduce(
      (sum, each) => sum + withoutRecording(() => copySettings(source.workspace, each.workspace)),
      0,
    );
    const where = target ? target.name : 'the other notebooks';
    setDone(
      changed === 0
        ? `${target ? target.name : 'The other notebooks'} already had these settings.`
        : `Copied ${source.name}’s settings to ${where}.`,
    );
  };
  return (
    <div className="nset-panel" data-testid="git-settings-copy">
      <div className="nset-panel-fields">
        <label className="settings-field" htmlFor={`${id}-from`}>
          <span>From</span>
        </label>
        <Select
          id={`${id}-from`}
          value={source.id}
          data-testid="git-copy-from"
          onChange={(event) => {
            setFrom(event.currentTarget.value);
            setDone(null);
          }}
        >
          {state.all.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </Select>
        <label className="settings-field" htmlFor={`${id}-to`}>
          <span>To</span>
        </label>
        <Select
          id={`${id}-to`}
          value={target ? target.id : ALL_OTHERS}
          data-testid="git-copy-to"
          onChange={(event) => {
            setTo(event.currentTarget.value);
            setDone(null);
          }}
        >
          {others.length > 1 ? <option value={ALL_OTHERS}>Every Other Notebook</option> : null}
          {others.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </Select>
      </div>
      <p className="t-help nset-panel-note">
        Replaces {target ? `${target.name}’s` : 'their'} settings with {source.name}’s: the theme,
        the sidebar, shortcuts and the rest. Quick Access stays as it is.
      </p>
      <div className="settings-actions">
        <button
          data-event="settings.git-notebooks.copy-settings.copy"
          data-ui="item"
          type="button"
          className="btn primary"
          data-testid="git-copy-settings"
          disabled={targets.length === 0}
          onClick={copy}
        >
          <Icon name="copy" size={14} />
          Copy Settings
        </button>
        <button
          data-event="settings.git-notebooks.copy-settings.cancel"
          data-ui="item"
          type="button"
          className="btn"
          onClick={onClose}
        >
          {done ? 'Done' : 'Cancel'}
        </button>
      </div>
      {done ? (
        <p className="t-help" role="status" data-testid="git-copy-settings-done">
          {done}
        </p>
      ) : null}
    </div>
  );
}

type Answer = <T>(
  run: () => Promise<
    { ok: true; value: T } | { ok: false; error: { message: string; hostMessage?: string } } | null
  >,
  done: (value: T) => string,
) => Promise<void>;

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
  const now = useNow();
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

/** Overview: Name, Repository, its notes, Copy Settings…, and Remove from This Mac… at the foot. */
function OverviewTab({
  source,
  git,
  answer,
  busy,
  onMessage,
}: {
  source: GitSource;
  git: DesktopGit;
  answer: Answer;
  busy: boolean;
  onMessage: (message: string) => void;
}) {
  const info = useGitInfo(source);
  const state = useSourcesState();
  const registry = useSourcesRegistry();
  const notes = useNoteCount(source);
  const [copying, setCopying] = useState(false);
  const primary = state.journal.id === source.id;
  const link = repositoryLink(info);

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
      if (!registry.gitSource(source.id)) {
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
    <>
      <div className="lf-group nset-first-group">
        <NotebookName source={source} />
        {/* Its badge (PEN-140, ac17), right after its name. */}
        <BadgeSettings source={source} />
        <SettingRow
          setting="repository"
          label="Repository"
          help={
            <span className="selectable" data-testid="git-repository">
              {info.repository} · branch {info.branch}
              {info.dir ? ` · folder ${info.dir}` : ''}
            </span>
          }
        >
          {link ? (
            // The help keeps the remote's own words (an SSH alias stays the alias); the link
            // goes to the host's real name (A1565).
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
              data-ui="item"
              data-testid="git-repository-link"
            >
              <Icon name="globe" size={14} />
              {link.github ? 'Open on GitHub' : 'Open in Browser'}
            </a>
          ) : null}
        </SettingRow>
        <SettingRow
          setting="notebook-notes"
          label="Notes"
          testId="git-note-count"
          help={notes === 1 ? '1 note' : `${notes.toLocaleString()} notes`}
        />
        <NotebookAiRow source={source} />
        {state.all.length > 1 ? (
          <SettingRow
            setting="notebook-copy-settings"
            label="Settings"
            help="Copy from or to other notebooks"
          >
            <button
              data-event="settings.git-notebooks.copy-settings.open"
              data-ui="item"
              type="button"
              className="btn"
              aria-expanded={copying}
              data-testid="git-copy-settings-open"
              onClick={() => setCopying((was) => !was)}
            >
              <Icon name="copy" size={14} />
              Copy Settings…
            </button>
          </SettingRow>
        ) : null}
        {copying ? (
          <CopySettingsPanel
            from={primary ? source.id : state.journal.id}
            to={primary ? ALL_OTHERS : source.id}
            onClose={() => setCopying(false)}
          />
        ) : null}
      </div>
      <div className="nset-foot" data-setting="remove-from-this-mac">
        <button
          data-event="settings.git-notebooks.remove"
          data-ui="item"
          type="button"
          className="btn danger"
          data-testid="git-remove"
          disabled={busy}
          onClick={() => void remove()}
        >
          <Icon name="trash" size={14} />
          Remove from This Mac…
        </button>
        {removing ? (
          <ConfirmBlock
            className="git-remove-confirm"
            title="Remove This Notebook?"
            testId="git-remove-confirm"
          >
            <p>
              {removing.known
                ? `${unpushedWords(removing.notes, removing.folders)} not pushed yet: removing now loses ${removing.notes + (removing.folders ? 1 : 0) === 1 ? 'it' : 'them'}.`
                : 'Penmoss cannot tell yet whether everything here is pushed: removing now may lose changes.'}
            </p>
            <div className="settings-actions">
              <button
                data-event="settings.git-notebooks.remove.push-first"
                data-ui="item"
                type="button"
                className="btn primary"
                data-testid="git-remove-push"
                onClick={() => {
                  setRemoving(null);
                  source.syncNow();
                  onMessage('Pushing first. Remove once it says Synced.');
                }}
              >
                <Icon name="refresh" size={14} />
                Push First
              </button>
              <button
                data-event="settings.git-notebooks.remove.anyway"
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
              <button
                data-event="settings.git-notebooks.remove.keep"
                data-ui="item"
                type="button"
                className="btn"
                onClick={() => setRemoving(null)}
              >
                Keep It
              </button>
            </div>
          </ConfirmBlock>
        ) : (
          <p className="muted nset-foot-note">
            Removes this Mac’s copy, after Touch ID. The repository keeps everything pushed.
          </p>
        )}
      </div>
    </>
  );
}

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
    <>
      <SettingRow
        setting="notebook-name"
        label="Name"
        labelFor={`${id}-name`}
        help={
          <>
            Renames it on every device that syncs it. Agents still find it by its old name.
            {info.pendingName ? ' The new name goes to the repository at the next sync.' : ''}
          </>
        }
      >
        <form
          className="git-notebook-rename"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void rename(draft);
          }}
        >
          <input
            id={`${id}-name`}
            className="input nset-name-input"
            maxLength={80}
            value={draft}
            data-testid="git-notebook-name"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            data-event="settings.git-notebooks.rename"
            type="submit"
            className="btn"
            data-ui="submit"
            data-testid="git-notebook-rename"
            disabled={unchanged}
          >
            Rename
          </button>
        </form>
      </SettingRow>
      {clash ? (
        <div className="nset-row-note">
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
        </div>
      ) : null}
      <p role="status" className="git-message muted nset-row-note" data-testid="git-rename-message">
        {message}
      </p>
    </>
  );
}

/** Sync: the cadence as menus in words, the sync's state, and the diagnostics under Details. */
function SyncTab({
  source,
  git,
  answer,
  now,
}: {
  source: GitSource;
  git: DesktopGit;
  answer: Answer;
  now: number;
}) {
  const info = useGitInfo(source);
  const status = useGitStatus(source);
  const id = useId();
  const waiting = status.pending.filter((each) => each !== 'workspace').length;
  const notices =
    (status.cleared || status.storageKept === false ? 1 : 0) +
    (status.unreadable && status.unreadable.length > 0 ? 1 : 0) +
    (info.filterIgnored ? 1 : 0) +
    (status.handEdits.length > 0 ? 1 : 0);
  return (
    <>
      <div className="lf-group nset-first-group">
        <SettingRow
          setting="push-changes"
          label="Push Changes"
          labelFor={`${id}-push`}
          help="After your edits settle"
        >
          <Select
            id={`${id}-push`}
            value={info.pushDelayS}
            data-testid="git-push-delay"
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (value !== info.pushDelayS) {
                void answer(
                  () => git.update(info.localId, { pushDelayS: value }),
                  () => `Pushes ${pushWords(value).toLowerCase()} your edits settle.`,
                );
              }
            }}
          >
            {pushChoices(info.pushDelayS).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          setting="pull-changes"
          label="Pull Changes"
          labelFor={`${id}-pull`}
          help="While Penmoss is open, and whenever it comes to the front"
        >
          <Select
            id={`${id}-pull`}
            value={info.pullEveryMin}
            data-testid="git-pull-interval"
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (value !== info.pullEveryMin) {
                void answer(
                  () => git.update(info.localId, { pullEveryMin: value }),
                  () =>
                    `Pulls ${pullWords(value).toLowerCase()}, and when Penmoss comes to the front.`,
                );
              }
            }}
          >
            {pullChoices(info.pullEveryMin).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          setting="sync-status"
          label="Status"
          testId="git-sync-state"
          help={[
            status.closing ? 'Pushing…' : PHASE_WORDS[status.phase],
            waiting === 0
              ? 'Nothing Waits to Be Pushed'
              : `${waiting === 1 ? '1 Note Waits' : `${waiting} Notes Wait`} to Be Pushed`,
            status.lastSyncAt === null
              ? 'Never Synced'
              : `Last Synced ${agoWords(status.lastSyncAt, now)}`,
            ...(status.nextRetryAt ? [`Tries Again ${when(status.nextRetryAt)}`] : []),
          ].join(' · ')}
        />
      </div>
      <details className="nset-details" data-testid="git-details">
        <summary data-event="settings.git-notebooks.details">
          Details
          {notices > 0 ? (
            <span className="chip" data-testid="git-details-count">
              {notices === 1 ? '1 Notice' : `${notices} Notices`}
            </span>
          ) : null}
        </summary>
        <dl className="settings-facts">
          <dt>Remote</dt>
          <dd>{info.remote}</dd>
          <dt>Branch</dt>
          <dd>{info.branch}</dd>
          <dt>Folder</dt>
          <dd>{info.dir || 'The repository’s root'}</dd>
          <dt>Last Sync</dt>
          <dd>{when(status.lastSyncAt)}</dd>
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
              <dt>Edited by Hand</dt>
              <dd data-testid="git-hand-edits">
                Penmoss wrote these again from the notes (edit them in Penmoss):{' '}
                {status.handEdits.join(', ')}
              </dd>
            </>
          ) : null}
        </dl>
      </details>
    </>
  );
}

/** Git: this notebook's commit name and email, signing, and the sign-in it uses. */
function GitTab({
  source,
  git,
  identity,
  answer,
  busy,
}: {
  source: GitSource;
  git: DesktopGit;
  identity: { name: string; email: string } | null;
  answer: Answer;
  busy: boolean;
}) {
  const info = useGitInfo(source);
  const [token, setToken] = useState('');
  const id = useId();
  return (
    <div className="lf-group nset-first-group">
      <div className="lf-row nset-stack" data-setting="commit-name-and-email">
        <div className="lf-row-text">
          <span className="lf-row-label">Commit Name and Email</span>
          <span className="lf-row-help">
            This notebook’s own, over git’s; a GitHub no-reply address keeps yours private
          </span>
        </div>
        <CommitIdentity info={info} git={git} identity={identity} answer={answer} busy={busy} />
      </div>
      <SettingRow
        setting="sign-commits"
        label="Sign Commits"
        labelFor={`${id}-sign`}
        help={
          info.sign
            ? 'With the key git is configured to sign with'
            : 'Never signs this notebook’s commits'
        }
      >
        <Switch
          id={`${id}-sign`}
          checked={info.sign}
          data-testid="git-sign"
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
      </SettingRow>
      <div className="lf-row nset-stack" data-setting="sign-in">
        <div className="lf-row-text">
          <label className="lf-row-label" htmlFor={`${id}-token`}>
            Sign-In
          </label>
          <span className="lf-row-help" data-testid="git-sign-in">
            {info.hasToken
              ? 'A personal access token, kept in the Keychain'
              : 'Git’s own credentials, or a personal access token for an HTTPS host that needs one'}
          </span>
        </div>
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
          <input
            id={`${id}-token`}
            type="password"
            className="input"
            autoComplete="off"
            placeholder={
              info.hasToken ? 'A new token replaces the one set' : 'Personal access token'
            }
            value={token}
            data-testid="git-token"
            onChange={(event) => setToken(event.target.value)}
          />
          <div className="settings-actions">
            <button
              data-event="settings.git-notebooks.token.save"
              type="submit"
              className="btn"
              data-ui="submit"
              disabled={busy || token.trim() === ''}
            >
              Save Token
            </button>
            {info.hasToken ? (
              <button
                data-event="settings.git-notebooks.token.forget"
                data-ui="item"
                type="button"
                className="btn"
                data-testid="git-forget-token"
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
      </div>
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
        <span>Commit Name</span>
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
        <span>Commit Email</span>
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
        <button
          data-event="settings.git-notebooks.author.save"
          type="submit"
          className="btn"
          data-ui="submit"
          disabled={busy}
        >
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
