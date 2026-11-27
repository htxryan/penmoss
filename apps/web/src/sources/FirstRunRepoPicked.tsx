/** The first run's one-repository-picked screen (4.5–4.8; FirstRunRepos.tsx has the others). */
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { GitHubRepo, GitHubVia } from '../desktop/bridge';
import { notebooksIn, placeIn, type Place, type RepoRead } from './first-run-flow';
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
import { folderNameProblem } from './repo-words';
import { FolderPick } from './FirstRunFolderPick';
import { hostWords } from './host-words';

/**
 * One repository picked (4.5–4.8): empty, it starts at the root; holding a notebook, it opens
 * (never a second one silently); holding several, pick one; holding other files, pick a folder.
 */
export function RepoPicked({
  repo,
  via,
  added,
  loaded,
  branch: picked,
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
  read: (repo: GitHubRepo, again?: boolean, branch?: string) => void;
  /** The branch Pick Branch chose (A1621): its folders are the ones shown, and the notebook syncs it. */
  branch: string;
  onOpen: (place: Place, name: string) => void;
  onName: (place: Place) => void;
  onFolder: () => void;
  onUrl: () => void;
  back: () => void;
}) {
  const [branch, setBranch] = useState(picked);
  const [dir, setDir] = useState('');
  const [another, setAnother] = useState('');
  const [anotherProblem, setAnotherProblem] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const formId = useId();
  useEffect(() => {
    if (!loaded) read(repo, false, picked);
  }, [loaded, read, repo, picked]);

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
              onClick={() => read(repo, true, picked)}
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
  const branchNow = picked;
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
      onName(placeIn(repo, via, another.trim(), branchNow));
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
            Already Added: it is on {hostWords().here}.
          </p>
        ) : (
          <Action
            data-event="firstrun.repo.open"
            primary
            testId="first-run-open"
            onClick={() => onOpen(placeIn(repo, via, only.path, branchNow), only.notebook.name)}
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
    const chosen =
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
            disabled={isAdded(chosen)}
            testId="first-run-open"
            onClick={() => onOpen(placeIn(repo, via, chosen.path, branchNow), chosen.notebook.name)}
          >
            Open {chosen.notebook.name}
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
                checked={each.path === chosen.path}
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
  return (
    <FolderPick
      repo={repo}
      via={via}
      folders={folders}
      branch={branchNow}
      onName={onName}
      back={back}
    />
  );
}
