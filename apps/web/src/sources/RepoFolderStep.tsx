/**
 * Add a Git Notebook's folder step (T81, #229; A1167, B4–B6, B10): one repository's folders as
 * an indented, searchable list, the root first and selected. A folder holding a notebook carries
 * its name; one this Penmoss has already added (by notebook id) can't be picked. New Folder adds a
 * subfolder of the selected one, made when the notebook first syncs.
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useMemo, useState } from 'react';
import { fuzzy } from '../commands/fuzzy';
import type { DesktopGitHubBrowse, GitHubRepo, RepoFolder, RepoFolders } from '../desktop/bridge';
import { folderNameProblem, listKeys } from './repo-words';

export interface FolderChoice {
  /** The folder ('' for the repository's root). */
  readonly dir: string;
  /** The notebook it holds, which Add then opens under its own name. */
  readonly notebook: { readonly id: string; readonly name: string } | null;
}

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly folders: RepoFolders }
  | { readonly state: 'failed'; readonly message: string };

const LOADING: Load = { state: 'loading' };

export function RepoFolderStep({
  github,
  repo,
  branch,
  added,
  chosen,
  onChoose,
}: {
  github: DesktopGitHubBrowse;
  repo: GitHubRepo;
  branch: string;
  /** Notebook ids already in this Penmoss: their folders show Already Added. */
  added: ReadonlySet<string>;
  chosen: FolderChoice;
  onChoose: (choice: FolderChoice) => void;
}) {
  const id = useId();
  /** What main answered, and for which repository and branch: another's answer is still loading. */
  const [answered, setAnswered] = useState<{ key: string; load: Load } | null>(null);
  const [query, setQuery] = useState('');
  const [made, setMade] = useState<readonly string[]>([]);
  const [newName, setNewName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const key = `${repo.fullName}\n${branch}`;
  const load: Load = answered?.key === key ? answered.load : LOADING;

  useEffect(() => {
    let live = true;
    void github
      .folders(repo.fullName, branch)
      .catch(() => null)
      .then((answer) => {
        if (!live) return;
        const loaded: Load = !answer
          ? { state: 'failed', message: 'This window cannot browse GitHub.' }
          : !answer.ok
            ? { state: 'failed', message: answer.error.message }
            : { state: 'ready', folders: answer.value };
        setAnswered({ key: `${repo.fullName}\n${branch}`, load: loaded });
      });
    return () => {
      live = false;
    };
  }, [github, repo.fullName, branch]);

  const rows = useMemo(() => {
    if (load.state !== 'ready') return [];
    const known = new Set(load.folders.folders.map((folder) => folder.path));
    const all: Array<RepoFolder & { isNew: boolean }> = [
      ...load.folders.folders.map((folder) => ({ ...folder, isNew: false })),
      ...made
        .filter((path) => !known.has(path))
        .map((path) => ({ path, notebook: null, isNew: true })),
    ];
    all.sort((a, b) => (a.path === '' ? -1 : b.path === '' ? 1 : a.path.localeCompare(b.path)));
    const q = query.trim();
    return q ? all.filter((folder) => folder.path === '' || fuzzy(q, folder.path) !== null) : all;
  }, [load, made, query]);

  if (load.state === 'loading') {
    return (
      <p className="muted" role="status" data-testid="repo-folders-loading">
        Reading the folders of {repo.fullName}…
      </p>
    );
  }
  if (load.state === 'failed') {
    return (
      <p role="status" data-testid="repo-folders-problem">
        {load.message} You can type the folder under More Options instead.
      </p>
    );
  }

  const addFolder = () => {
    const words = folderNameProblem(newName);
    if (words) {
      setProblem(words);
      return;
    }
    const path = chosen.dir ? `${chosen.dir}/${newName.trim()}` : newName.trim();
    setMade((now) => (now.includes(path) ? now : [...now, path]));
    setNewName('');
    setProblem(null);
    onChoose({ dir: path, notebook: null });
  };
  const inNotebook = chosen.notebook !== null;

  return (
    <div className="repo-folders" data-testid="repo-folders">
      {load.folders.empty ? (
        <p className="muted" data-testid="repo-folders-empty">
          This repository is empty, so the notebook starts at its root. You can still put it in a
          new folder.
        </p>
      ) : null}
      <label className="settings-field">
        <span>Folders</span>
        <input
          type="search"
          className="input"
          placeholder="Filter folders"
          value={query}
          aria-controls={`${id}-list`}
          data-testid="repo-folders-search"
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
      <div
        id={`${id}-list`}
        className="repo-list"
        role="listbox"
        aria-label={`Folders in ${repo.fullName}`}
        data-testid="repo-folder-list"
        onKeyDown={listKeys}
      >
        {rows.map((folder) => {
          const isAdded = folder.notebook !== null && added.has(folder.notebook.id);
          const depth = folder.path === '' ? 0 : folder.path.split('/').length;
          return (
            <button
              key={folder.path || '/'}
              type="button"
              role="option"
              data-ui="item"
              className="repo-row repo-folder"
              style={{ paddingInlineStart: `${0.6 + depth * 1.1}rem` }}
              aria-selected={chosen.dir === folder.path}
              aria-disabled={isAdded ? 'true' : undefined}
              title={isAdded ? 'This notebook is already in Penmoss' : undefined}
              data-testid="repo-folder"
              data-path={folder.path}
              onClick={() => {
                if (!isAdded) onChoose({ dir: folder.path, notebook: folder.notebook });
              }}
            >
              <span className="repo-row-name">
                <Icon name={folder.notebook ? 'notebook' : 'folder'} size={14} />
                {folder.path === '' ? (
                  <strong>{repo.name} (root)</strong>
                ) : (
                  folder.path.split('/').pop()
                )}
              </span>
              <span className="repo-row-facts">
                {folder.notebook ? (
                  <span className="chip repo-notebook">Notebook · {folder.notebook.name}</span>
                ) : null}
                {isAdded ? <span className="chip repo-readonly">Already Added</span> : null}
                {folder.isNew ? <span className="chip">New</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      <p className="muted repo-list-note">
        Folders starting with a dot, and the folders inside a notebook, aren’t listed.
        {load.folders.truncated
          ? ' Some folders aren’t shown; type the folder under More Options.'
          : ''}
      </p>
      {inNotebook ? null : (
        <div className="repo-new-folder">
          <label className="settings-field">
            <span>New folder in {chosen.dir ? chosen.dir : 'the root'}</span>
            <input
              className="input"
              placeholder="journal"
              spellCheck={false}
              value={newName}
              data-testid="repo-new-folder"
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
          <button
            type="button"
            className="btn"
            data-ui="item"
            data-testid="repo-new-folder-add"
            onClick={addFolder}
          >
            <Icon name="folderPlus" size={14} />
            Add Folder
          </button>
          <span className="muted" role="status" data-testid="repo-new-folder-message">
            {problem ?? 'Made when the notebook first syncs.'}
          </span>
        </div>
      )}
    </div>
  );
}
