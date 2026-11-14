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
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { fuzzy } from '../commands/fuzzy';
import type {
  DesktopGitHubBrowse,
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
          <LinkButton testId="notebook-name-clash-use" onClick={() => onChange(suggestion)}>
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
}: {
  github: DesktopGitHubBrowse;
  hub: Hub;
  onCreated: (place: Place, name: string) => void;
  onUseExisting: () => void;
  back: () => void;
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
            <Action testId="first-run-change-owner" onClick={() => setChanging(true)}>
              Change Owner
            </Action>
          ) : null}
          <Action
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
                <span className="fr-hidden">Repository name</span>
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
                    <LinkButton testId="first-run-create-change" onClick={() => setChanging(true)}>
                      Change
                    </LinkButton>
                  </>
                ) : null}
              </span>
            </span>
            {changing ? (
              <label className="fr-owner">
                <span className="fr-hidden">Owner</span>
                <Select
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
        <LinkButton testId="first-run-use-existing" onClick={onUseExisting}>
          Use Existing Repo
        </LinkButton>
      ) : null}
    </Frame>
  );
}

/** The notebooks in one repository's folders. */
const notebooksIn = (folders: RepoFolders) =>
  folders.folders.filter(
    (folder): folder is RepoFolder & { notebook: NonNullable<RepoFolder['notebook']> } =>
      folder.notebook !== null,
  );

/** How many repositories the tree reads by itself, most recently pushed first. */
const READ_AHEAD = 8;

/**
 * Use Existing Repo (4.1–4.4): each repository with the notebooks in it beneath (Notebook List A).
 * The most recently pushed ones are read at once; another is read when it is opened. A notebook
 * opens; a repository goes on to what it holds.
 */
export function RepoTree({
  hub,
  goal,
  reads,
  read,
  onRepo,
  onOpen,
  onUrl,
  onCreate,
  onRefresh,
  back,
}: {
  hub: Hub;
  goal: Goal;
  reads: ReadonlyMap<string, RepoRead>;
  read: (repo: GitHubRepo) => void;
  onRepo: (repo: GitHubRepo) => void;
  onOpen: (repo: GitHubRepo, folder: RepoFolder) => void;
  onUrl: () => void;
  onCreate: (() => void) | null;
  onRefresh: () => void;
  back: () => void;
}) {
  const repos = useMemo(() => {
    const all = [...hub.list.repos];
    // A new notebook wants an empty repository: those first (B7).
    if (goal === 'new') all.sort((a, b) => Number(b.empty) - Number(a.empty));
    return all;
  }, [hub, goal]);
  const ahead = useMemo(
    () => repos.filter((repo) => repo.canPush && !repo.empty).slice(0, READ_AHEAD),
    [repos],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        ...ahead.map((repo) => repo.fullName),
        ...repos.filter((repo) => repo.empty && repo.canPush).map((repo) => repo.fullName),
      ]),
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    for (const repo of ahead) if (!reads.has(repo.fullName)) read(repo);
    // Once, for what the list first shows; Refresh reads again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ahead]);

  const q = query.trim();
  const shown = useMemo(() => {
    return repos.flatMap((repo) => {
      const loaded = reads.get(repo.fullName);
      const notebooks = loaded?.state === 'ready' ? notebooksIn(loaded.folders) : [];
      if (!q) return [{ repo, notebooks }];
      const repoMatch = fuzzy(q, repo.fullName) !== null;
      const matching = notebooks.filter((each) => fuzzy(q, each.notebook.name) !== null);
      if (!repoMatch && matching.length === 0) return [];
      return [{ repo, notebooks: repoMatch ? notebooks : matching }];
    });
  }, [repos, reads, q]);
  const firstNotebook = shown.find((each) => each.notebooks.length > 0);
  const chosen =
    selected ??
    (firstNotebook ? `${firstNotebook.repo.fullName}\n${firstNotebook.notebooks[0]!.path}` : null);

  const signedInLine = (
    <p className="fr-lead fr-small" data-testid="first-run-via">
      {hub.login
        ? `Signed in to GitHub as ${hub.login}`
        : hub.via === 'git'
          ? 'Signed in to GitHub through this Mac’s git'
          : 'Signed in to GitHub in Penmoss'}
      {' · '}
      <LinkButton testId="first-run-refresh" onClick={onRefresh}>
        Refresh
      </LinkButton>
    </p>
  );

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
            <Action testId="first-run-url-instead" onClick={onUrl}>
              Paste a URL Instead
            </Action>
            {onCreate ? (
              <Action primary testId="first-run-create-instead" onClick={onCreate}>
                Create New Repo
              </Action>
            ) : null}
          </>
        }
      >
        <p className="fr-empty" data-testid="first-run-no-repos">
          GitHub lists no repository{hub.login ? ` for ${hub.login}` : ' for this sign-in'}.
        </p>
        {signedInLine}
      </Frame>
    );
  }

  const toggle = (repo: GitHubRepo) => {
    const isOpen = open.has(repo.fullName);
    setOpen((now) => {
      const next = new Set(now);
      if (isOpen) next.delete(repo.fullName);
      else next.add(repo.fullName);
      return next;
    });
    if (!isOpen && !repo.empty && !reads.has(repo.fullName)) read(repo);
  };

  return (
    <Frame name="list" state="ready" step={2} title="Pick Repository" back={back}>
      <label className="fr-filter">
        <span className="fr-hidden">Filter</span>
        <Icon name="search" size={14} />
        <input
          type="search"
          className="input"
          placeholder="Filter repositories and notebooks"
          value={query}
          data-testid="first-run-filter"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery('');
            }
          }}
        />
      </label>
      {q ? (
        <p className="fr-lead fr-small" role="status" data-testid="first-run-filter-count">
          {shown.length} of {repos.length} match.
        </p>
      ) : null}
      <ul className="fr-tree" aria-label="Repositories and notebooks" data-testid="first-run-tree">
        {shown.map(({ repo, notebooks }) => {
          // A filter shows what matched inside, opened or not.
          const expanded = open.has(repo.fullName) || (q !== '' && notebooks.length > 0);
          const loaded = reads.get(repo.fullName);
          return (
            <li key={repo.fullName} data-testid="first-run-tree-repo" data-repo={repo.fullName}>
              <div className="fr-tree-repo">
                <button
                  type="button"
                  className="fr-tree-toggle"
                  data-ui="item"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? 'Hide' : 'Show'} what ${repo.fullName} holds`}
                  disabled={!repo.canPush}
                  data-testid="first-run-repo-toggle"
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
                  onClick={() => onRepo(repo)}
                >
                  <span className="muted">{repo.owner}/</span>
                  <strong>{repo.name}</strong>
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
                      <LinkButton testId="first-run-start-here" onClick={() => onRepo(repo)}>
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
                      const isChosen = chosen === key;
                      return (
                        <li
                          key={key}
                          className={isChosen ? 'fr-tree-notebook on' : 'fr-tree-notebook'}
                          data-testid="first-run-notebook"
                          data-repo={repo.fullName}
                          data-dir={folder.path}
                          onClick={() => setSelected(key)}
                        >
                          <Icon name="notebook" size={16} />
                          <strong>{folder.notebook.name}</strong>
                          <Location dir={folder.path} />
                          <Action
                            primary={isChosen}
                            testId="first-run-notebook-open"
                            onClick={() => onOpen(repo, folder)}
                          >
                            Open
                          </Action>
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
      <LinkButton testId="first-run-url-instead" onClick={onUrl}>
        Paste a URL Instead
      </LinkButton>
      {signedInLine}
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
            <Action testId="first-run-url-instead" onClick={onUrl}>
              Paste a URL Instead
            </Action>
            <Action
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
        <Action
          primary
          testId="first-run-open"
          onClick={() => onOpen(placeIn(repo, via, only.path), only.notebook.name)}
        >
          Open {only.notebook.name}
        </Action>
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
                <span className="fr-hidden">Folder name</span>
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
              <Action form={formId} testId="first-run-another-make">
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
    const picked = notebooks.find((each) => each.path === pick) ?? notebooks[0]!;
    return (
      <Frame
        name="repo"
        state="several"
        step={2}
        title="Pick Notebook"
        back={back}
        actions={
          <Action
            primary
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
                onChange={() => setPick(each.path)}
              />
              <strong className="fr-grow">{each.notebook.name}</strong>
              <Location dir={each.path} />
            </label>
          ))}
        </div>
        {rootIsNotebook ? null : (
          <LinkButton testId="first-run-start-another" onClick={onFolder}>
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
          <span className="fr-hidden">New folder</span>
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
        <Action icon="folderPlus" testId="first-run-new-folder-add" onClick={addFolder}>
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
        <Action primary icon="refresh" testId="first-run-retry" onClick={back}>
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
        <Action primary form={formId} disabled={!name.trim()} testId="first-run-make">
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
