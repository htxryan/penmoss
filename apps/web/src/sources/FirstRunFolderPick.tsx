/** The first run's Pick Folder screen (4.8; FirstRunRepos.tsx has the others). */
import { Icon } from '@penmoss/ui/icons';
import { useId, useMemo, useState } from 'react';
import type { GitHubRepo, GitHubVia, RepoFolders } from '../desktop/bridge';
import { placeIn, type Place } from './first-run-flow';
import { Action, Frame, Location } from './FirstRunFrame';
import { folderNameProblem } from './repo-words';

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
