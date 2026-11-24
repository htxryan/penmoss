/**
 * The first run's repository screens (First Run C; Ryan's review of #192, findings 3 and 4):
 * Create New Repo (3.x), Use Existing Repo as a two-level tree of repositories and the notebooks
 * in them (Notebook List A, 4.1–4.4), one repository picked (4.5 empty, 4.6 one notebook, 4.7
 * several, 4.8 other files: Pick Folder), Paste a URL (5.x), Penmoss Needs Git (2.8) and Name
 * Your Notebook (6.x). Each asks one thing; the flow (FirstRun.tsx) says where each goes next.
 */
import { defaultRepoName } from '@penmoss/git-notebook/github-browse';
import { Icon } from '@penmoss/ui/icons';
import { Select } from '@penmoss/ui/controls/Select';
import { Menu, MenuItem } from '../shell/Menu';
import { accountChoices, type AccountChoice } from './github-choices';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { fuzzyMatch, highlightRuns } from '@penmoss/core/fuzzy';
import type {
  DesktopGitHubBrowse,
  GitHubAccountChoice,
  GitHubRepo,
  GitHubVia,
  RepoFolder,
  RepoFolders,
} from '../desktop/bridge';
import {
  nameFromRepo,
  placeIn,
  refusalWords,
  repoNameOf,
  type AddNotebook,
  type Goal,
  type Hub,
  type Place,
  type RepoRead,
  type Setup,
} from './first-run-flow';
import {
  Action,
  Frame,
  LinkButton,
  Location,
  MoreOptions,
  PlaceCard,
  Problem,
  Working,
} from './FirstRunFrame';
import { freeName, nameClash, useOtherNotebookNames } from './notebook-names';
import { folderNameProblem, pushedWords } from './repo-words';

/** The notebook name field, with a word when another notebook here has the name. */
function NameField({
  value,
  onChange,
  testId,
  placeholder,
}: {
  value: string;
  onChange: (name: string) => void;
  testId: string;
  placeholder?: string;
}) {
  const others = useOtherNotebookNames();
  const twin = nameClash(value, others);
  const suggestion = freeName(value, others);
  return (
    <label className="settings-field fr-field">
      <span>Notebook name</span>
      <input
        className="input"
        maxLength={80}
        required
        value={value}
        placeholder={placeholder}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
      {twin ? (
        // Allowed, but agents can't tell two notebooks with one name apart (Ryan's review of #192).
        <span className="fr-warn" role="status" data-testid="notebook-name-clash">
          Another notebook on this Mac is called {twin}.{' '}
          <LinkButton
            data-event="firstrun.name.use-suggestion"
            testId="notebook-name-clash-use"
            onClick={() => onChange(suggestion)}
          >
            Use {suggestion}
          </LinkButton>
        </span>
      ) : null}
    </label>
  );
}

/** Create New Repo (3.1–3.4): a private, empty repository on GitHub, named after the notebook. */
export function CreateRepo({
  github,
  hub,
  onCreated,
  onUseExisting,
  back,
  switcher,
}: {
  github: DesktopGitHubBrowse;
  hub: Hub;
  onCreated: (place: Place, name: string) => void;
  onUseExisting: () => void;
  back: () => void;
  /** Whose account the repository is made in, and another's (A1617). */
  switcher?: ReactNode;
}) {
  const formId = useId();
  const owners = hub.owners ?? [];
  const [notebook, setNotebook] = useState('');
  const [repoName, setRepoName] = useState('notes');
  const [edited, setEdited] = useState(false);
  const [owner, setOwner] = useState(owners[0]?.login ?? '');
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<
    { readonly taken: true } | { readonly taken: false; readonly message: string } | null
  >(null);
  const name = repoName.trim();
  const ready = notebook.trim() !== '' && name !== '' && owner !== '';

  const create = async (event?: FormEvent) => {
    event?.preventDefault();
    const chosen = owners.find((each) => each.login === owner);
    if (!chosen || !ready || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const answer = await github.create(chosen, name).catch(() => null);
      if (!answer) {
        setProblem({ taken: false, message: 'This window cannot create repositories.' });
      } else if (!answer.ok) {
        setProblem(
          answer.error.reason === 'exists'
            ? { taken: true }
            : { taken: false, message: answer.error.message },
        );
      } else {
        onCreated(placeIn(answer.value, answer.via), notebook.trim());
      }
    } finally {
      setBusy(false);
    }
  };

  const failed = problem !== null && !problem.taken;
  return (
    <Frame
      name="create"
      state={busy ? 'creating' : problem ? (problem.taken ? 'taken' : 'failed') : 'ready'}
      step={2}
      title="Create New Repo"
      back={back}
      actions={
        <>
          {failed && owners.length > 1 ? (
            <Action
              data-event="firstrun.create.change-owner"
              testId="first-run-change-owner"
              onClick={() => setChanging(true)}
            >
              Change Owner
            </Action>
          ) : null}
          <Action
            data-event="firstrun.create.make-notebook"
            primary
            form={formId}
            busy={busy}
            disabled={!ready}
            icon={failed ? 'refresh' : undefined}
            testId="first-run-create-submit"
          >
            {busy ? `Creating ${owner}/${name}…` : failed ? 'Try Again' : 'Make Notebook'}
          </Action>
        </>
      }
    >
      {switcher}
      <form id={formId} className="fr-form" onSubmit={(event) => void create(event)}>
        <fieldset className="fr-fields" disabled={busy}>
          <NameField
            value={notebook}
            placeholder="Field Notes"
            testId="first-run-create-notebook"
            onChange={(value) => {
              setNotebook(value);
              if (!edited) setRepoName(defaultRepoName(value));
            }}
          />
          <div className="settings-field fr-field">
            <span>Repository</span>
            <span className="fr-repo-name">
              <span className="muted" data-testid="first-run-create-owner-label">
                {owner || '…'} /
              </span>
              <label className="fr-grow">
                <span className="sr-only">Repository name</span>
                <input
                  className={problem?.taken ? 'input fr-invalid' : 'input'}
                  maxLength={100}
                  spellCheck={false}
                  value={repoName}
                  aria-invalid={problem?.taken || undefined}
                  data-testid="first-run-create-repo"
                  onChange={(event) => {
                    setRepoName(event.target.value);
                    setEdited(true);
                    setProblem(null);
                  }}
                />
              </label>
            </span>
            {problem?.taken ? (
              <span className="fr-invalid-words" role="alert" data-testid="first-run-create-taken">
                {owner}/{name} already exists.{' '}
                <LinkButton
                  data-event="firstrun.create.use-suggestion"
                  testId="first-run-create-suggest"
                  onClick={() => {
                    setRepoName(`${name}-2`);
                    setEdited(true);
                    setProblem(null);
                  }}
                >
                  Use {name}-2
                </LinkButton>
              </span>
            ) : null}
            <span className="fr-facts">
              <span className="chip">Private</span>
              <span className="muted">
                Owner {owner || '…'}
                {owners.length > 1 && !changing ? (
                  <>
                    {' · '}
                    <LinkButton
                      data-event="firstrun.create.change"
                      testId="first-run-create-change"
                      onClick={() => setChanging(true)}
                    >
                      Change
                    </LinkButton>
                  </>
                ) : null}
              </span>
            </span>
            {changing ? (
              <label className="fr-owner">
                <span className="sr-only">Owner</span>
                <Select
                  data-event="firstrun.owner"
                  value={owner}
                  data-testid="first-run-create-owner"
                  onChange={(event) => {
                    setOwner(event.target.value);
                    setProblem(null);
                  }}
                >
                  {owners.map((each) => (
                    <option key={each.login} value={each.login}>
                      {each.kind === 'user' ? `${each.login} (you)` : each.login}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
          </div>
        </fieldset>
      </form>
      {owners.length === 0 ? (
        <Problem testId="first-run-create-problem">
          GitHub didn’t say where a repository can be made. Go back and try again.
        </Problem>
      ) : null}
      {failed ? <Problem testId="first-run-create-problem">{problem.message}</Problem> : null}
      {problem?.taken ? (
        <LinkButton
          data-event="firstrun.create.use-existing-repo"
          testId="first-run-use-existing"
          onClick={onUseExisting}
        >
          Use Existing Repo
        </LinkButton>
      ) : null}
    </Frame>
  );
}

/** The account on the switcher's button: its login, else whose sign-in it is. */
const whoOf = (hub: Hub) =>
  hub.login ?? (hub.via === 'git' ? 'This Mac’s Git Sign-In' : 'GitHub Account');

/**
 * Whose repositories these are, as a control (Ryan's pick, option 2, 17 Nov 2026; A1617): the
 * account above Pick Repository and Create New Repo, and a menu of every account (the one in use
 * checked) with Add Another Account, Manage GitHub Accounts and Refresh.
 */
export function AccountSwitcher({
  github,
  hub,
  onPick,
  onAdd,
  onManage,
  onRefresh,
  line = 'Listing this account’s repositories',
}: {
  github: DesktopGitHubBrowse;
  hub: Hub;
  /** What the account is for here, under its name. */
  line?: string;
  onPick: (account: GitHubAccountChoice | undefined) => void;
  onAdd: () => void;
  onManage?: (() => void) | undefined;
  onRefresh: () => void;
}) {
  const [choices, setChoices] = useState<readonly AccountChoice[]>([]);
  useEffect(() => {
    let live = true;
    void accountChoices(github).then((all) => {
      if (live) setChoices(all);
    });
    return () => {
      live = false;
    };
  }, [github]);
  const who = whoOf(hub);
  // The account whose token read these; with none picked, git's, else the first (A1617).
  const current =
    hub.account !== undefined
      ? choices.find((each) => each.key !== 'git' && each.account === hub.account)
      : (choices.find((each) => each.key === 'git') ??
        choices.find((each) => hub.login !== null && each.login === hub.login));
  return (
    <Menu
      data-event="firstrun.account.open"
      label="GitHub Account"
      icon="users"
      className="fr-switcher"
      testId="first-run-account-switcher"
      face={
        <>
          <span className="fr-switcher-initial" aria-hidden="true">
            {(hub.login ?? 'G').slice(0, 1).toUpperCase()}
          </span>
          <span className="fr-switcher-text">
            <strong data-testid="first-run-via">{who}</strong>
            <span>{line}</span>
          </span>
          <Icon name="chevD" size={14} />
        </>
      }
    >
      {choices.map((each) => {
        const checked = each === current;
        return (
          <button
            key={each.key}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            data-testid={`first-run-switch-${each.key === 'git' ? 'git' : (each.login ?? '')}`}
            data-event="firstrun.account"
            onClick={() => {
              if (!checked) onPick(each.account);
            }}
          >
            <span className="menu-check" aria-hidden="true">
              {checked ? <Icon name="check" /> : null}
            </span>
            <span className="menu-label">
              {each.title}
              <span className="fr-switcher-line">{each.line}</span>
            </span>
          </button>
        );
      })}
      {choices.length > 0 ? <div className="menu-sep" role="separator" /> : null}
      <MenuItem
        data-event="firstrun.account.add"
        icon="userPlus"
        data-testid="first-run-switch-add"
        onClick={onAdd}
      >
        Add Another Account…
      </MenuItem>
      {onManage ? (
        <MenuItem
          data-event="firstrun.account.manage"
          icon="settings"
          data-testid="first-run-switch-manage"
          onClick={onManage}
        >
          Manage GitHub Accounts…
        </MenuItem>
      ) : null}
      <MenuItem
        data-event="firstrun.account.refresh"
        icon="refresh"
        data-testid="first-run-refresh"
        onClick={onRefresh}
      >
        Refresh Repositories
      </MenuItem>
    </Menu>
  );
}

/** Text with what the filter matched marked (4.3). */
function Marked({ text, query }: { text: string; query: string }) {
  const match = query ? fuzzyMatch(query, text, { scattered: false }) : null;
  if (!match || match.indices.length === 0) return text;
  return highlightRuns(text, match.indices).map((run, index) =>
    run.match ? <mark key={index}>{run.text}</mark> : run.text,
  );
}

/** The notebooks in one repository's folders. */
const notebooksIn = (folders: RepoFolders) =>
  folders.folders.filter(
    (folder): folder is RepoFolder & { notebook: NonNullable<RepoFolder['notebook']> } =>
      folder.notebook !== null,
  );

/** How many repositories the tree reads at once, as they come near the list's view. */
const READ_AT_ONCE = 3;

/** Whether this window can tell which rows are near the view; without it, every row is near. */
const seeing = typeof IntersectionObserver !== 'undefined';

/** Whether `row` shows, even in part, in `box` (the tree's visible box). */
const inView = (row: Element, box: DOMRect) => {
  const at = row.getBoundingClientRect();
  return at.bottom > box.top && at.top < box.bottom;
};

/**
 * Use Existing Repo (4.1–4.4): each repository with the notebooks in it beneath (Notebook List A).
 * A repository is read as it comes near the list's view, a few at a time, and opens by itself
 * when it holds a notebook; one with none (empty, or read and found none) stays closed until it
 * is opened (Ryan's review of #193). A notebook opens; a repository goes on to what it holds.
 */
export function RepoTree({
  hub,
  goal,
  added,
  reads,
  read,
  onRepo,
  onOpen,
  onUrl,
  onCreate,
  onRefresh,
  back,
  switcher,
}: {
  hub: Hub;
  goal: Goal;
  /** Notebook ids already on this Mac (Add Notebook, A1562): shown Already Added, not opened. */
  added: ReadonlySet<string>;
  reads: ReadonlyMap<string, RepoRead>;
  read: (repo: GitHubRepo) => void;
  onRepo: (repo: GitHubRepo) => void;
  onOpen: (repo: GitHubRepo, folder: RepoFolder) => void;
  onUrl: () => void;
  onCreate: (() => void) | null;
  onRefresh: () => void;
  back: () => void;
  /** Whose repositories these are, and another account's (A1617); else a line with Refresh. */
  switcher?: ReactNode;
}) {
  const repos = useMemo(() => {
    const all = [...hub.list.repos];
    // A new notebook wants an empty repository: those first (B7).
    if (goal === 'new') all.sort((a, b) => Number(b.empty) - Number(a.empty));
    return all;
  }, [hub, goal]);
  /** Opened or closed by hand: the tree never changes these itself. */
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  /** Opened by the tree, once read and found to hold a notebook. */
  const [found, setFound] = useState<ReadonlySet<string>>(() => new Set());
  /** The repositories in or near the list's view: the ones to read. */
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [tree, setTree] = useState<HTMLUListElement | null>(null);
  const watch = useRef<IntersectionObserver | null>(null);
  const pointerIn = useRef(false);
  /** Bumped when a row held closed may open now: the pointer left the list, or it scrolled. */
  const [retry, setRetry] = useState(0);
  /**
   * The list's height when a filter was first typed: the list keeps at least that while filtered,
   * so the centred card doesn't shrink and move as matches go (Ryan's review of #193).
   */
  const [floor, setFloor] = useState<number | null>(null);
  const filter = (next: string) => {
    if (!next.trim()) setFloor(null);
    else if (!query.trim() && tree) setFloor(tree.getBoundingClientRect().height);
    setQuery(next);
  };

  // Which rows are in or near the view. Those up to a list's height above or below it count, so
  // most are read, and open, before they scroll in.
  useEffect(() => {
    if (!tree || !seeing) return;
    const observer = new IntersectionObserver(
      (entries) =>
        setNear((now) => {
          const next = new Set(now);
          for (const entry of entries) {
            const name = (entry.target as HTMLElement).dataset['repo'];
            if (!name) continue;
            if (entry.isIntersecting) next.add(name);
            else next.delete(name);
          }
          return next.size === now.size && [...next].every((name) => now.has(name)) ? now : next;
        }),
      { root: tree, rootMargin: '100% 0px' },
    );
    watch.current = observer;
    for (const row of tree.children) observer.observe(row);
    return () => {
      observer.disconnect();
      watch.current = null;
    };
  }, [tree, repos]);
  /** Each row, watched while it is in the list. */
  const watchRow = useCallback((row: HTMLLIElement) => {
    watch.current?.observe(row);
    return () => watch.current?.unobserve(row);
  }, []);

  const q = query.trim();
  const shown = useMemo(() => {
    return repos.flatMap((repo) => {
      const loaded = reads.get(repo.fullName);
      const notebooks = loaded?.state === 'ready' ? notebooksIn(loaded.folders) : [];
      if (!q) return [{ repo, notebooks }];
      const repoMatch = fuzzyMatch(q, repo.fullName, { scattered: false }) !== null;
      const matching = notebooks.filter(
        (each) => fuzzyMatch(q, each.notebook.name, { scattered: false }) !== null,
      );
      if (!repoMatch && matching.length === 0) return [];
      return [{ repo, notebooks: repoMatch ? notebooks : matching }];
    });
  }, [repos, reads, q]);

  // Read what is near the view, a few at a time, in the list's order.
  useEffect(() => {
    let reading = [...reads.values()].filter((each) => each.state === 'loading').length;
    for (const { repo } of shown) {
      if (reading >= READ_AT_ONCE) break;
      const isNear = !seeing || near.has(repo.fullName);
      if (!isNear || !repo.canPush || repo.empty || reads.has(repo.fullName)) continue;
      read(repo);
      reading += 1;
    }
  }, [shown, near, reads, read]);

  /** Read and found to hold a notebook, but not yet opened by the tree. */
  const waiting = useMemo(
    () =>
      repos
        .filter((repo) => {
          const loaded = reads.get(repo.fullName);
          return (
            !found.has(repo.fullName) &&
            loaded?.state === 'ready' &&
            notebooksIn(loaded.folders).length > 0
          );
        })
        .map((repo) => repo.fullName),
    [repos, reads, found],
  );
  // Each opens as it is found, except a row in view while the pointer is over the list: opening it
  // would move the rows under the pointer, so it waits until the pointer leaves or it scrolls out
  // of view. A row above the view opens at once, since the browser keeps what is in view in place.
  useEffect(() => {
    if (waiting.length === 0) return;
    const box = pointerIn.current && tree ? tree.getBoundingClientRect() : null;
    const rows = new Map<string | undefined, Element>();
    for (const row of tree?.children ?? []) rows.set((row as HTMLElement).dataset['repo'], row);
    const now = waiting.filter((name) => {
      const row = rows.get(name);
      return !box || !row || !inView(row, box);
    });
    if (now.length > 0) setFound((was) => new Set([...was, ...now]));
  }, [waiting, tree, retry]);
  const tryHeld = () => {
    if (waiting.length > 0) setRetry((now) => now + 1);
  };

  const isAdded = (folder: RepoFolder) => folder.notebook !== null && added.has(folder.notebook.id);
  const firstNotebook = shown
    .flatMap(({ repo, notebooks }) => notebooks.map((folder) => ({ repo, folder })))
    .find(({ folder }) => !isAdded(folder));
  const chosen =
    selected ??
    (firstNotebook ? `${firstNotebook.repo.fullName}\n${firstNotebook.folder.path}` : null);

  const signedInLine = (
    <p className="fr-lead fr-small" data-testid="first-run-via">
      {hub.login
        ? `Signed in as ${hub.login}`
        : hub.via === 'git'
          ? 'Signed in through this Mac’s git'
          : 'Signed in to GitHub'}
      {' · '}
      <LinkButton data-event="firstrun.list.refresh" testId="first-run-refresh" onClick={onRefresh}>
        Refresh
      </LinkButton>
    </p>
  );
  // Whose repositories these are, and another account's, above the list (A1617).
  const accountLines = switcher ?? signedInLine;

  // 4.4: nothing to pick.
  if (repos.length === 0) {
    return (
      <Frame
        name="list"
        state="none"
        step={2}
        title="Pick Repository"
        back={back}
        actions={
          <>
            <Action
              data-event="firstrun.list.paste-a-url-instead"
              testId="first-run-url-instead"
              onClick={onUrl}
            >
              Paste a URL Instead
            </Action>
            {onCreate ? (
              <Action
                data-event="firstrun.list.create-new-repo"
                primary
                testId="first-run-create-instead"
                onClick={onCreate}
              >
                Create New Repo
              </Action>
            ) : null}
          </>
        }
      >
        <p className="fr-empty" data-testid="first-run-no-repos">
          GitHub lists no repository{hub.login ? ` for ${hub.login}` : ' for this sign-in'}.
        </p>
        {accountLines}
      </Frame>
    );
  }

  /** Open when opened by hand, or, unless closed by hand, once found to hold a notebook. */
  const isOpen = (name: string) => toggled.get(name) ?? found.has(name);
  const toggle = (repo: GitHubRepo) => {
    const opening = !isOpen(repo.fullName);
    setToggled((now) => new Map(now).set(repo.fullName, opening));
    if (opening && !repo.empty && !reads.has(repo.fullName)) read(repo);
  };

  return (
    <Frame name="list" state="ready" step={2} title="Pick Repository" back={back}>
      {accountLines}
      <label className="fr-filter">
        <span className="sr-only">Filter</span>
        <Icon name="search" size={14} />
        <input
          type="search"
          className="input"
          placeholder="Filter repositories and notebooks"
          value={query}
          data-testid="first-run-filter"
          onChange={(event) => filter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              event.stopPropagation();
              filter('');
            }
          }}
        />
      </label>
      {/* Always there, so the list never moves when the filter is typed in (Ryan's review of #193).
          A live region speaks only when its words change: as the filter is typed or cleared. */}
      <p className="fr-lead fr-small fr-count" role="status" data-testid="first-run-filter-count">
        {q
          ? `${shown.length} of ${repos.length} match.`
          : `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}.`}
      </p>
      <ul
        ref={setTree}
        className="fr-tree"
        style={floor === null ? undefined : { minHeight: floor }}
        aria-label="Repositories and notebooks"
        data-testid="first-run-tree"
        onPointerEnter={() => {
          pointerIn.current = true;
        }}
        onPointerLeave={() => {
          pointerIn.current = false;
          tryHeld();
        }}
        onScroll={tryHeld}
      >
        {shown.map(({ repo, notebooks }) => {
          // A filter shows what matched inside, opened or not.
          const expanded = isOpen(repo.fullName) || (q !== '' && notebooks.length > 0);
          const loaded = reads.get(repo.fullName);
          return (
            <li
              key={repo.fullName}
              ref={watchRow}
              data-testid="first-run-tree-repo"
              data-repo={repo.fullName}
            >
              <div className="fr-tree-repo">
                <button
                  type="button"
                  className="fr-tree-toggle"
                  data-ui="item"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? 'Hide' : 'Show'} what ${repo.fullName} holds`}
                  disabled={!repo.canPush}
                  data-testid="first-run-repo-toggle"
                  data-event="firstrun.repo.toggle"
                  onClick={() => toggle(repo)}
                >
                  <Icon name={expanded ? 'chevD' : 'chevR'} size={14} />
                </button>
                <button
                  type="button"
                  className="fr-tree-name"
                  data-ui="item"
                  disabled={!repo.canPush}
                  title={repo.canPush ? undefined : 'You can’t push to this repository'}
                  data-testid="first-run-repo-pick"
                  data-event="firstrun.repo"
                  onClick={() => onRepo(repo)}
                >
                  <span className="muted">
                    <Marked text={`${repo.owner}/`} query={q} />
                  </span>
                  <strong>
                    <Marked text={repo.name} query={q} />
                  </strong>
                </button>
                {repo.empty ? <span className="chip fr-chip">Empty</span> : null}
                {repo.visibility !== 'private' ? (
                  <span className="chip fr-chip">
                    {repo.visibility === 'public' ? 'Public' : 'Internal'}
                  </span>
                ) : null}
                {repo.canPush ? null : <span className="chip fr-chip">Read Only</span>}
                <span className="fr-when">{pushedWords(repo.pushedAt)}</span>
              </div>
              {expanded ? (
                <ul className="fr-tree-in">
                  {repo.empty || (loaded?.state === 'ready' && notebooks.length === 0) ? (
                    <li className="fr-tree-none" data-testid="first-run-no-notebook">
                      <span>No notebook yet</span>
                      <LinkButton
                        data-event="firstrun.list.start-one-here"
                        testId="first-run-start-here"
                        onClick={() => onRepo(repo)}
                      >
                        Start One Here
                      </LinkButton>
                    </li>
                  ) : loaded?.state === 'failed' ? (
                    <li className="fr-tree-none">
                      <span>Couldn’t read it: {loaded.message}</span>
                    </li>
                  ) : loaded?.state !== 'ready' ? (
                    <li className="fr-tree-none">
                      <span className="fr-spin" aria-hidden="true" />
                      <span>Looking for notebooks…</span>
                    </li>
                  ) : (
                    notebooks.map((folder) => {
                      const key = `${repo.fullName}\n${folder.path}`;
                      const here = isAdded(folder);
                      const isChosen = chosen === key && !here;
                      return (
                        <li
                          key={key}
                          className={isChosen ? 'fr-tree-notebook on' : 'fr-tree-notebook'}
                          data-testid="first-run-notebook"
                          data-repo={repo.fullName}
                          data-dir={folder.path}
                          aria-disabled={here || undefined}
                          onClick={here ? undefined : () => setSelected(key)}
                        >
                          <Icon name="notebook" size={16} />
                          <strong>
                            <Marked text={folder.notebook.name} query={q} />
                          </strong>
                          <Location dir={folder.path} />
                          {here ? (
                            <span className="chip fr-chip" data-testid="first-run-already-added">
                              Already Added
                            </span>
                          ) : (
                            <Action
                              data-event="firstrun.list.open"
                              primary={isChosen}
                              testId="first-run-notebook-open"
                              onClick={() => onOpen(repo, folder)}
                            >
                              Open
                            </Action>
                          )}
                        </li>
                      );
                    })
                  )}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {hub.list.more ? (
        <p className="fr-lead fr-small">
          Showing the 300 most recently pushed. Paste a URL for others.
        </p>
      ) : null}
      <LinkButton
        data-event="firstrun.list.paste-a-url-instead"
        testId="first-run-url-instead"
        onClick={onUrl}
      >
        Paste a URL Instead
      </LinkButton>
    </Frame>
  );
}

/**
 * One repository picked (4.5–4.8): empty, it starts at the root; holding a notebook, it opens
 * (never a second one silently); holding several, pick one; holding other files, pick a folder.
 */
export function RepoPicked({
  repo,
  via,
  added,
  loaded,
  read,
  onOpen,
  onName,
  onFolder,
  onUrl,
  back,
}: {
  repo: GitHubRepo;
  via: GitHubVia;
  /** Notebook ids already on this Mac: shown Already Added, not opened again. */
  added: ReadonlySet<string>;
  loaded: RepoRead | undefined;
  read: (repo: GitHubRepo, again?: boolean) => void;
  onOpen: (place: Place, name: string) => void;
  onName: (place: Place) => void;
  onFolder: () => void;
  onUrl: () => void;
  back: () => void;
}) {
  const [branch, setBranch] = useState(repo.defaultBranch || 'main');
  const [dir, setDir] = useState('');
  const [another, setAnother] = useState('');
  const [anotherProblem, setAnotherProblem] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const formId = useId();
  useEffect(() => {
    if (!loaded) read(repo);
  }, [loaded, read, repo]);

  if (!loaded || loaded.state === 'loading') {
    return (
      <Frame name="repo" state="loading" step={2} title="Pick Repository" back={back}>
        <Working>Reading {repo.fullName}…</Working>
      </Frame>
    );
  }
  if (loaded.state === 'failed') {
    return (
      <Frame
        name="repo"
        state="failed"
        step={2}
        title="Pick Repository"
        back={back}
        actions={
          <>
            <Action
              data-event="firstrun.repo.paste-a-url-instead"
              testId="first-run-url-instead"
              onClick={onUrl}
            >
              Paste a URL Instead
            </Action>
            <Action
              data-event="firstrun.repo.try-again"
              primary
              icon="refresh"
              testId="first-run-retry"
              onClick={() => read(repo, true)}
            >
              Try Again
            </Action>
          </>
        }
      >
        <Problem testId="first-run-repo-problem">
          Couldn’t read {repo.fullName}: {loaded.message}
        </Problem>
      </Frame>
    );
  }

  const { folders } = loaded;
  const notebooks = notebooksIn(folders);
  const isAdded = (each: { notebook: { id: string } }) => added.has(each.notebook.id);
  const branchNow = repo.defaultBranch || 'main';
  const rootIsNotebook = notebooks.some((each) => each.path === '');

  // 4.5: empty, so the notebook starts at its root.
  if (folders.empty) {
    return (
      <Frame
        name="repo"
        state="empty"
        step={2}
        title="Empty Repository"
        back={back}
        actions={
          <Action
            data-event="firstrun.continue"
            primary
            testId="first-run-continue"
            onClick={() =>
              onName(
                placeIn(repo, via, dir.trim().replace(/^\/+|\/+$/g, ''), branch.trim() || 'main'),
              )
            }
          >
            Continue
          </Action>
        }
      >
        <p className="fr-lead">A new notebook starts at its Root.</p>
        <PlaceCard label={repo.fullName} dir={dir.trim()} branch={branch.trim() || 'main'} />
        <MoreOptions branch={branch} dir={dir} onBranch={setBranch} onDir={setDir} />
      </Frame>
    );
  }

  // 4.6: one notebook: open it, or start another in a folder beside it.
  if (notebooks.length === 1) {
    const only = notebooks[0]!;
    const startAnother = (event: FormEvent) => {
      event.preventDefault();
      const words = folderNameProblem(another);
      if (words) {
        setAnotherProblem(words);
        return;
      }
      onName(placeIn(repo, via, another.trim()));
    };
    return (
      <Frame
        name="repo"
        state="one"
        step={2}
        title={`${only.notebook.name} Is Already Here`}
        back={back}
      >
        <p className="fr-lead">This repository already holds a notebook.</p>
        <PlaceCard
          label={repo.fullName}
          dir={only.path}
          branch={branchNow}
          notebook={only.notebook.name}
        />
        {isAdded(only) ? (
          <p className="fr-lead fr-small" data-testid="first-run-already-added">
            Already Added: it is on this Mac.
          </p>
        ) : (
          <Action
            data-event="firstrun.repo.open"
            primary
            testId="first-run-open"
            onClick={() => onOpen(placeIn(repo, via, only.path), only.notebook.name)}
          >
            Open {only.notebook.name}
          </Action>
        )}
        {rootIsNotebook ? null : (
          <form id={formId} className="fr-another" onSubmit={startAnother}>
            <p className="fr-or" aria-hidden="true">
              <span />
              or
              <span />
            </p>
            <strong>Start Another Notebook in a Folder</strong>
            <span className="fr-row">
              <label className="fr-grow">
                <span className="sr-only">Folder name</span>
                <input
                  className="input"
                  placeholder="journal"
                  spellCheck={false}
                  value={another}
                  data-testid="first-run-another"
                  onChange={(event) => {
                    setAnother(event.target.value);
                    setAnotherProblem(null);
                  }}
                />
              </label>
              <Action
                data-event="firstrun.repo.make-notebook"
                form={formId}
                testId="first-run-another-make"
              >
                Make Notebook
              </Action>
            </span>
            {anotherProblem ? (
              <span className="fr-invalid-words" role="alert">
                {anotherProblem}
              </span>
            ) : null}
          </form>
        )}
      </Frame>
    );
  }

  // 4.7: several notebooks: pick one.
  if (notebooks.length > 1) {
    const picked =
      notebooks.find((each) => each.path === pick) ??
      notebooks.find((each) => !isAdded(each)) ??
      notebooks[0]!;
    return (
      <Frame
        name="repo"
        state="several"
        step={2}
        title="Pick Notebook"
        back={back}
        actions={
          <Action
            data-event="firstrun.repo.open"
            primary
            disabled={isAdded(picked)}
            testId="first-run-open"
            onClick={() => onOpen(placeIn(repo, via, picked.path), picked.notebook.name)}
          >
            Open {picked.notebook.name}
          </Action>
        }
      >
        <p className="fr-lead">
          {repo.fullName} holds {notebooks.length} notebooks.
        </p>
        <div className="fr-choices" role="radiogroup" aria-label="Notebooks">
          {notebooks.map((each) => (
            <label key={each.path} className="fr-choice" data-testid="first-run-pick-notebook">
              <input
                type="radio"
                name={`${formId}-notebook`}
                checked={each.path === picked.path}
                disabled={isAdded(each)}
                data-event="firstrun.notebook"
                onChange={() => setPick(each.path)}
              />
              <strong className="fr-grow">{each.notebook.name}</strong>
              <Location dir={each.path} />
              {isAdded(each) ? (
                <span className="chip fr-chip" data-testid="first-run-already-added">
                  Already Added
                </span>
              ) : null}
            </label>
          ))}
        </div>
        {rootIsNotebook ? null : (
          <LinkButton
            data-event="firstrun.repo.start-another"
            testId="first-run-start-another"
            onClick={onFolder}
          >
            Start Another Notebook in a Folder
          </LinkButton>
        )}
      </Frame>
    );
  }

  // 4.8: other files: pick where the notebook goes.
  return <FolderPick repo={repo} via={via} folders={folders} onName={onName} back={back} />;
}

/** Pick Folder (4.8): the root or a folder with no notebook in it, or a new folder. */
export function FolderPick({
  repo,
  via,
  folders,
  beside = false,
  onName,
  back,
}: {
  repo: GitHubRepo;
  via: GitHubVia;
  folders: RepoFolders;
  /** Another notebook beside the ones the repository holds (4.7's Start Another). */
  beside?: boolean;
  onName: (place: Place) => void;
  back: () => void;
}) {
  const id = useId();
  const [made, setMade] = useState<readonly string[]>([]);
  const free = useMemo(() => {
    const listed = folders.folders.filter((folder) => folder.notebook === null).map((f) => f.path);
    const all = [...new Set([...listed, ...made])];
    all.sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    return all;
  }, [folders, made]);
  const [chosen, setChosen] = useState<string>(() => free[0] ?? '');
  const [newName, setNewName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const branch = repo.defaultBranch || 'main';

  const addFolder = () => {
    const words = folderNameProblem(newName);
    if (words) {
      setProblem(words);
      return;
    }
    const path = chosen ? `${chosen}/${newName.trim()}` : newName.trim();
    setMade((now) => (now.includes(path) ? now : [...now, path]));
    setNewName('');
    setProblem(null);
    setChosen(path);
  };

  return (
    <Frame
      name="folder"
      state="pick"
      step={2}
      title="Pick Folder"
      back={back}
      actions={
        <Action
          data-event="firstrun.continue"
          primary
          disabled={free.length === 0}
          testId="first-run-continue"
          onClick={() => onName(placeIn(repo, via, chosen))}
        >
          Continue
        </Action>
      }
    >
      <p className="fr-lead">
        {beside
          ? 'Pick where the new notebook goes.'
          : `${repo.fullName} holds other files. Pick where the notebook goes.`}
      </p>
      <div className="fr-choices" role="radiogroup" aria-label={`Folders in ${repo.fullName}`}>
        {free.map((path) => (
          <label
            key={path || '/'}
            className="fr-choice"
            style={{
              paddingInlineStart: `${0.75 + (path ? path.split('/').length - 1 : 0) * 1.1}rem`,
            }}
            data-testid="first-run-folder-option"
            data-path={path}
          >
            <input
              type="radio"
              name={`${id}-folder`}
              checked={chosen === path}
              data-event="firstrun.folder"
              onChange={() => setChosen(path)}
            />
            <Icon name="folder" size={14} />
            <span className="fr-grow fr-choice-text">
              <strong>{path ? `${path.split('/').pop()}/` : 'Root'}</strong>
              {path === '' ? <span className="muted">{repo.fullName}</span> : null}
              {made.includes(path) ? (
                <span className="muted">New, made at the first sync</span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      <span className="fr-row">
        <label className="fr-grow">
          <span className="sr-only">New folder</span>
          <input
            className="input"
            placeholder="New folder, such as journal"
            spellCheck={false}
            value={newName}
            data-testid="first-run-new-folder"
            onChange={(event) => {
              setNewName(event.target.value);
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addFolder();
              }
            }}
          />
        </label>
        <Action
          data-event="firstrun.folder.add-folder"
          icon="folderPlus"
          testId="first-run-new-folder-add"
          onClick={addFolder}
        >
          Add Folder
        </Action>
      </span>
      {problem ? (
        <span className="fr-invalid-words" role="alert" data-testid="first-run-new-folder-problem">
          {problem}
        </span>
      ) : null}
      <p className="fr-lead fr-small">
        <Location dir={chosen} branch={branch} />
      </p>
      <p className="fr-lead fr-small">
        Folders starting with a dot, and folders inside a notebook, aren’t listed.
        {folders.truncated ? ' Some folders aren’t shown: Paste a URL to give the folder.' : ''}
      </p>
    </Frame>
  );
}

/** Paste a URL (5.1–5.3): any repository this Mac's git can push to, asked of git itself. */
export function PasteUrl({
  add,
  onAdded,
  onName,
  onGitMissing,
  back,
}: {
  add: AddNotebook;
  onAdded: (setup: Setup) => void;
  onName: (place: Place) => void;
  onGitMissing: () => void;
  back: () => void;
}) {
  const formId = useId();
  const [remote, setRemote] = useState('');
  const [branch, setBranch] = useState('main');
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !remote.trim()) return;
    setBusy(true);
    setProblem(null);
    const place: Place = {
      remote: remote.trim(),
      branch: branch.trim() || 'main',
      dir: dir.trim().replace(/^\/+|\/+$/g, ''),
      label: remote.trim(),
      githubSignIn: false,
      suggested: nameFromRepo(
        dir.trim() ? (dir.trim().split('/').pop() ?? '') : repoNameOf(remote),
      ),
    };
    try {
      // Added without a name, it opens the notebook the address holds, or says it holds none.
      const result = await add({ remote: place.remote, branch: place.branch, dir: place.dir });
      if (!result) {
        setProblem('This window cannot add git notebooks.');
      } else if (!result.ok) {
        if (result.error.code === 'git_missing') onGitMissing();
        else setProblem(refusalWords(result.error));
      } else if (result.value.kind === 'needs-name') {
        onName(place);
      } else {
        onAdded({
          kind: 'added',
          place,
          name: result.value.notebook.name,
          notebookId: result.value.notebook.notebookId,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame
      name="url"
      state={busy ? 'checking' : problem ? 'failed' : 'ready'}
      step={2}
      title="Paste a URL"
      back={back}
      actions={
        <Action
          data-event="firstrun.continue"
          primary
          form={formId}
          busy={busy}
          disabled={!remote.trim()}
          icon={problem ? 'refresh' : undefined}
          testId="first-run-continue"
        >
          {busy ? 'Checking…' : problem ? 'Try Again' : 'Continue'}
        </Action>
      }
    >
      <form id={formId} className="fr-form" onSubmit={(event) => void check(event)}>
        <fieldset className="fr-fields" disabled={busy}>
          <label className="settings-field fr-field">
            <span>Repository URL</span>
            <input
              className={problem ? 'input fr-invalid' : 'input'}
              required
              spellCheck={false}
              placeholder="git@github.com:you/notes.git"
              value={remote}
              aria-invalid={problem ? true : undefined}
              data-testid="first-run-url-input"
              onChange={(event) => {
                setRemote(event.target.value);
                setProblem(null);
              }}
            />
          </label>
          {busy ? null : (
            <p className="fr-lead fr-small">SSH or HTTPS, anywhere this Mac’s git can push to.</p>
          )}
          <MoreOptions branch={branch} dir={dir} onBranch={setBranch} onDir={setDir} />
        </fieldset>
      </form>
      {busy ? <Working>Asking git about the repository…</Working> : null}
      {problem ? <Problem testId="first-run-url-problem">{problem}</Problem> : null}
    </Frame>
  );
}

/** Penmoss Needs Git (2.8): git, or the Mac's command-line tools it comes with, is missing. */
export function GitMissing({ back }: { back: () => void }) {
  return (
    <Frame
      name="git-missing"
      step={2}
      title="Penmoss Needs Git"
      back={back}
      actions={
        <Action
          data-event="firstrun.git-missing.try-again"
          primary
          icon="refresh"
          testId="first-run-retry"
          onClick={back}
        >
          Try Again
        </Action>
      }
    >
      <p className="fr-lead">git needs the Mac’s command-line tools.</p>
      <p className="fr-lead fr-small">
        In Terminal, run <code>xcode-select --install</code> to open Apple’s installer. It takes a
        few minutes; then Try Again.
      </p>
    </Frame>
  );
}

/** Name Your Notebook (6.1, 6.2): only when a new notebook is made. */
export function NameNotebook({
  place,
  onMake,
  back,
}: {
  place: Place;
  onMake: (name: string) => void;
  back: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState(place.suggested);
  return (
    <Frame
      name="name"
      step={3}
      title="Name Your Notebook"
      back={back}
      actions={
        <Action
          data-event="firstrun.name.make-notebook"
          primary
          form={formId}
          disabled={!name.trim()}
          testId="first-run-make"
        >
          Make Notebook
        </Action>
      }
    >
      <p className="fr-lead">It shows in the sidebar. Rename it any time.</p>
      <form
        id={formId}
        className="fr-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onMake(name.trim());
        }}
      >
        <NameField value={name} onChange={setName} testId="first-run-name-input" />
      </form>
      <PlaceCard label={place.label} dir={place.dir} branch={place.branch} />
    </Frame>
  );
}
