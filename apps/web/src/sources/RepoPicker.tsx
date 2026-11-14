/**
 * Add a Git Notebook's repository step (T81, #229; A1166, B1–B3, B7–B10): the GitHub
 * repositories git's credential reaches, most recently pushed first, searchable, each labelled
 * Private, Public or Internal. Read-only ones are greyed and can't be picked. Start New lists
 * empty repositories first and can create a private one. Main asks git for the credential on
 * each call; the page never sees it.
 */
import { defaultRepoName } from '@penmoss/git-notebook/github-browse';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import { fuzzy } from '../commands/fuzzy';
import { NameClash } from './NameClash';
import { freeName, nameClash, useOtherNotebookNames } from './notebook-names';
import { listKeys, pushedWords, SIGNED_OUT } from './repo-words';
import type {
  BrowseError,
  DesktopGitHubBrowse,
  GitHubOwner,
  GitHubRepo,
  GitHubVia,
  RepoList,
} from '../desktop/bridge';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly list: RepoList; readonly via: GitHubVia }
  | { readonly state: 'failed'; readonly error: BrowseError };

const VISIBILITY: Record<GitHubRepo['visibility'], string> = {
  private: 'Private',
  public: 'Public',
  internal: 'Internal',
};

/** The words for a browse refusal, and whether Try Again can help. */
function failureWords(error: BrowseError): { title: string; hint: string | null } {
  switch (error.reason) {
    case 'no_credential':
    case 'timeout':
      return {
        title:
          error.reason === 'timeout'
            ? 'Git took too long to answer for its GitHub sign-in.'
            : 'Git on this Mac isn’t signed in to GitHub.',
        hint: 'gh',
      };
    case 'unauthorized':
      return { title: error.message, hint: 'gh' };
    default:
      return { title: error.message, hint: null };
  }
}

export function RepoPicker({
  github,
  startNew,
  picked,
  onPick,
  onCreated,
  onTypeAddress,
  onSignedOut,
}: {
  github: DesktopGitHubBrowse;
  /** Start New (B7): empty repositories first, and Create Private Repository. */
  startNew: boolean;
  /** The repository picked already, marked in the list. */
  picked: string | null;
  /** The repository, and the sign-in it was listed with (Penmoss's gives the notebook its token). */
  onPick: (repo: GitHubRepo, via: GitHubVia) => void;
  /** A repository Create just made, and the notebook name given for it. */
  onCreated: (repo: GitHubRepo, notebookName: string, via: GitHubVia) => void;
  onTypeAddress: () => void;
  /**
   * No credential, or one GitHub refuses (B8): the form goes to Type an Address with the
   * sign-in hint. Without it the picker says so itself.
   */
  onSignedOut?: (error: BrowseError) => void;
}) {
  const id = useId();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [query, setQuery] = useState('');
  const live = useRef(true);
  const [asked, setAsked] = useState(0);
  /** Whose Penmoss's GitHub sign-in is (T82), for the line above the list. */
  const [login, setLogin] = useState<string | null>(null);
  const signedOut = useEffectEvent((error: BrowseError) => {
    if (!onSignedOut) return false;
    onSignedOut(error);
    return true;
  });

  // Asks main for the list once per open form, and again on Refresh or Try Again (`asked`).
  useEffect(() => {
    live.current = true;
    void github
      .repos()
      .catch(() => null)
      .then((answer) => {
        if (!live.current) return;
        if (!answer) {
          setLoad({
            state: 'failed',
            error: { reason: 'github', message: 'This window cannot browse GitHub.' },
          });
          return;
        }
        if (!answer.ok && SIGNED_OUT.has(answer.error.reason) && signedOut(answer.error)) return;
        setLoad(
          answer.ok
            ? { state: 'ready', list: answer.value, via: answer.via }
            : { state: 'failed', error: answer.error },
        );
      });
    return () => {
      live.current = false;
    };
  }, [github, asked]);

  const viaPenmoss = load.state === 'ready' && load.via === 'penmoss';
  useEffect(() => {
    if (!viaPenmoss || !github.signIn) return;
    let live = true;
    void github.signIn
      .status()
      .catch(() => null)
      .then((status) => {
        if (live) setLogin(status?.login ?? null);
      });
    return () => {
      live = false;
    };
  }, [github, viaPenmoss]);

  const refresh = () => {
    setLoad({ state: 'loading' });
    setAsked((now) => now + 1);
  };

  const shown = useMemo(() => {
    if (load.state !== 'ready') return [];
    const q = query.trim();
    const matched = load.list.repos
      .map((repo, index) => ({ repo, index, match: fuzzy(q, repo.fullName) }))
      .filter((each) => each.match !== null);
    if (q) matched.sort((a, b) => b.match!.score - a.match!.score || a.index - b.index);
    else if (startNew)
      matched.sort((a, b) => Number(b.repo.empty) - Number(a.repo.empty) || a.index - b.index);
    return matched.map((each) => each.repo);
  }, [load, query, startNew]);

  if (load.state === 'loading') {
    return (
      <div className="repo-picker" data-testid="repo-picker" aria-busy="true">
        <p className="muted" role="status">
          Asking GitHub for your repositories…
        </p>
      </div>
    );
  }

  if (load.state === 'failed') {
    const words = failureWords(load.error);
    return (
      <div
        className="repo-picker repo-signed-out"
        data-testid="repo-picker"
        data-reason={load.error.reason}
      >
        <p data-testid="repo-picker-problem" role="status">
          {words.title}
        </p>
        {words.hint === 'gh' ? (
          <p className="muted" data-testid="repo-picker-hint">
            In Terminal, run <code>gh auth login</code>, then <code>gh auth setup-git</code>, then
            Try Again.
          </p>
        ) : null}
        <div className="settings-actions">
          <button
            type="button"
            className="btn"
            data-ui="item"
            data-testid="repo-picker-retry"
            onClick={refresh}
          >
            <Icon name="refresh" size={14} />
            Try Again
          </button>
          <button
            type="button"
            className="btn"
            data-ui="item"
            data-testid="repo-picker-type"
            onClick={onTypeAddress}
          >
            Type an Address
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="repo-picker" data-testid="repo-picker">
      <p className="muted repo-signed-in" data-testid="repo-picker-via">
        {load.via === 'git'
          ? 'Signed in to GitHub through git on this Mac.'
          : `Signed in to GitHub${login ? ` as ${login}` : ''} in Penmoss.`}{' '}
        <button
          type="button"
          className="btn repo-inline"
          data-ui="item"
          data-testid="repo-picker-refresh"
          onClick={refresh}
        >
          Refresh
        </button>
      </p>
      {startNew ? (
        <CreateRepository
          github={github}
          onCreated={(repo, notebookName) => onCreated(repo, notebookName, load.via)}
        />
      ) : null}
      <label className="settings-field">
        <span>{startNew ? 'Or pick an empty repository you made' : 'Pick the repository'}</span>
        <input
          type="search"
          className="input"
          placeholder="Search by owner or name"
          value={query}
          aria-controls={`${id}-list`}
          data-testid="repo-picker-search"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery('');
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              document
                .getElementById(`${id}-list`)
                ?.querySelector<HTMLButtonElement>('[role="option"]:not([aria-disabled="true"])')
                ?.focus();
            }
          }}
        />
      </label>
      <div
        id={`${id}-list`}
        className="repo-list"
        role="listbox"
        aria-label="Your GitHub repositories"
        data-testid="repo-list"
        onKeyDown={listKeys}
      >
        {shown.length === 0 ? (
          <p className="muted repo-none">
            {query.trim()
              ? `No repository matches “${query.trim()}”.`
              : 'GitHub lists no repository for this sign-in.'}
          </p>
        ) : (
          shown.map((repo) => (
            <button
              key={repo.fullName}
              type="button"
              role="option"
              data-ui="item"
              className="repo-row"
              aria-selected={picked === repo.fullName}
              aria-disabled={repo.canPush ? undefined : 'true'}
              title={repo.canPush ? undefined : 'You can’t push to this repository'}
              data-testid="repo-row"
              data-repo={repo.fullName}
              onClick={() => {
                if (repo.canPush) onPick(repo, load.via);
              }}
            >
              <span className="repo-row-name">
                <span className="muted">{repo.owner}/</span>
                <strong>{repo.name}</strong>
              </span>
              <span className="repo-row-facts">
                <span className={`chip repo-visibility repo-${repo.visibility}`}>
                  {VISIBILITY[repo.visibility]}
                </span>
                {repo.canPush ? null : <span className="chip repo-readonly">Read only</span>}
                {repo.empty ? <span className="chip">Empty</span> : null}
                <span className="muted">{pushedWords(repo.pushedAt)}</span>
              </span>
            </button>
          ))
        )}
      </div>
      <p className="muted repo-list-note">
        Most recently pushed first{startNew ? ', empty repositories on top' : ''}.
        {load.list.more ? ' Showing the 300 most recently pushed; type an address for others.' : ''}
      </p>
    </div>
  );
}

/** Create Private Repository (B7): the notebook's name, the repository's name and an owner. */
function CreateRepository({
  github,
  onCreated,
}: {
  github: DesktopGitHubBrowse;
  onCreated: (repo: GitHubRepo, notebookName: string) => void;
}) {
  const [notebook, setNotebook] = useState('');
  const others = useOtherNotebookNames();
  const twin = nameClash(notebook, others);
  const [repoName, setRepoName] = useState('notes');
  const [edited, setEdited] = useState(false);
  const [owners, setOwners] = useState<readonly GitHubOwner[] | null>(null);
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void github.owners().then((answer) => {
      if (!live || !answer?.ok) return;
      setOwners(answer.value);
      setOwner((now) => now || answer.value[0]?.login || '');
    });
    return () => {
      live = false;
    };
  }, [github]);

  const create = async () => {
    const chosen = owners?.find((each) => each.login === owner);
    if (!chosen) return;
    setBusy(true);
    setMessage(null);
    try {
      const answer = await github.create(chosen, repoName.trim());
      if (!answer) {
        setMessage('This window cannot create repositories.');
        return;
      }
      if (!answer.ok) {
        setMessage(answer.error.message);
        return;
      }
      onCreated(answer.value, notebook.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="repo-create" data-testid="repo-create">
      <legend>Create a private repository on GitHub</legend>
      <div className="settings-row">
        <label className="settings-field">
          <span>
            Notebook Name <span className="muted">(shown in the sidebar)</span>
          </span>
          <input
            className="input"
            maxLength={80}
            placeholder="Field Notes"
            value={notebook}
            data-testid="repo-create-notebook"
            onChange={(event) => {
              setNotebook(event.target.value);
              if (!edited) setRepoName(defaultRepoName(event.target.value));
            }}
          />
        </label>
        <label className="settings-field">
          <span>Repository name</span>
          <input
            className="input"
            maxLength={100}
            spellCheck={false}
            value={repoName}
            data-testid="repo-create-name"
            onChange={(event) => {
              setRepoName(event.target.value);
              setEdited(true);
            }}
          />
        </label>
        <label className="settings-field">
          <span>Owner</span>
          <select
            className="input"
            value={owner}
            disabled={!owners}
            data-testid="repo-create-owner"
            onChange={(event) => setOwner(event.target.value)}
          >
            {(owners ?? []).map((each) => (
              <option key={each.login} value={each.login}>
                {each.kind === 'user' ? `${each.login} (you)` : each.login}
              </option>
            ))}
          </select>
        </label>
      </div>
      {twin ? (
        <NameClash
          name={notebook.trim()}
          other={twin}
          suggestion={freeName(notebook, others)}
          onUse={(name) => {
            setNotebook(name);
            if (!edited) setRepoName(defaultRepoName(name));
          }}
        />
      ) : null}
      <p className="muted">
        Private, empty, no README.{' '}
        {edited
          ? 'Name kept as you typed it.'
          : 'The name follows the notebook’s until you edit it.'}
      </p>
      <div className="settings-actions">
        <button
          type="button"
          className="btn primary"
          data-ui="submit"
          data-testid="repo-create-submit"
          disabled={busy || !owners || notebook.trim() === '' || repoName.trim() === ''}
          onClick={() => void create()}
        >
          <Icon name="plus" size={14} />
          {busy
            ? 'Creating…'
            : `Create ${owner ? `${owner}/` : ''}${repoName.trim() || '…'} and Add`}
        </button>
        <span role="status" className="muted" data-testid="repo-create-message">
          {message ?? (notebook.trim() === '' ? 'Name the notebook first.' : null)}
        </span>
      </div>
    </fieldset>
  );
}
