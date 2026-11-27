/**
 * Pick Branch (Ryan, 18 Nov 2026; A1621): after the repository and before its folders, since each
 * branch can hold other folders, and the notebook syncs the one picked. Android's screen, the same
 * here: the default branch first, marked Default and picked, the rest by name, with Filter
 * Branches past eight. With one branch (or none yet, an empty repository) there is nothing to
 * pick, so it goes straight on.
 */
import { useEffect, useRef, useState } from 'react';
import type { DesktopGitHubBrowse, GitHubRepo } from '../desktop/bridge';
import { Action, Filter, Frame, Options, Problem, Working } from './FirstRunFrame';

/** More branches than this and Pick Branch has a filter. */
const BRANCH_FILTER_AT = 8;

type BranchRead =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly names: readonly string[] }
  | { readonly state: 'failed'; readonly message: string };

export function BranchPick({
  repo,
  browse,
  onOnly,
  onPick,
  back,
}: {
  repo: GitHubRepo;
  browse: DesktopGitHubBrowse;
  /** One branch, or none yet: its folders, in this screen's place. */
  onOnly: (branch: string) => void;
  onPick: (branch: string) => void;
  back: () => void;
}) {
  const fallback = repo.defaultBranch || 'main';
  const [read, setRead] = useState<BranchRead>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [pick, setPick] = useState(fallback);
  const [filter, setFilter] = useState('');
  /** Moves on once, whatever the parent passes on a later render. */
  const only = useRef(onOnly);

  useEffect(() => {
    let live = true;
    void browse
      .branches(repo.fullName, fallback)
      .catch(() => null)
      .then((answer) => {
        if (!live) return;
        if (!answer) {
          setRead({ state: 'failed', message: 'This window cannot browse GitHub.' });
        } else if (!answer.ok) {
          setRead({ state: 'failed', message: answer.error.message });
        } else if (answer.value.length <= 1) {
          only.current(answer.value[0] ?? fallback);
        } else {
          setRead({ state: 'ready', names: answer.value });
        }
      });
    return () => {
      live = false;
    };
  }, [browse, repo.fullName, fallback, attempt]);

  if (read.state === 'loading') {
    return (
      <Frame name="branch" state="loading" step={2} title="Pick Branch" back={back}>
        <Working>Reading {repo.fullName}’s branches…</Working>
      </Frame>
    );
  }
  if (read.state === 'failed') {
    return (
      <Frame
        name="branch"
        state="failed"
        step={2}
        title="Pick Branch"
        back={back}
        actions={
          <>
            <Action
              data-event="firstrun.branch.use-default"
              icon="branch"
              testId="first-run-branch-default"
              onClick={() => onPick(fallback)}
            >
              Use {fallback}
            </Action>
            <Action
              data-event="firstrun.branch.try-again"
              primary
              icon="refresh"
              testId="first-run-retry"
              onClick={() => {
                setRead({ state: 'loading' });
                setAttempt((now) => now + 1);
              }}
            >
              Try Again
            </Action>
          </>
        }
      >
        <Problem testId="first-run-branch-problem">
          Couldn’t read {repo.fullName}’s branches: {read.message}
        </Problem>
      </Frame>
    );
  }

  const query = filter.trim().toLowerCase();
  const shown = query
    ? read.names.filter((name) => name.toLowerCase().includes(query))
    : read.names;
  return (
    <Frame
      name="branch"
      state="ready"
      step={2}
      title="Pick Branch"
      back={back}
      actions={
        <Action
          data-event="firstrun.continue"
          primary
          disabled={!read.names.includes(pick)}
          testId="first-run-continue"
          onClick={() => onPick(pick)}
        >
          Continue
        </Action>
      }
    >
      <p className="fr-lead">
        {repo.fullName} has {read.names.length} branches. Each can hold other folders, and the
        notebook syncs the one you pick.
      </p>
      {read.names.length > BRANCH_FILTER_AT ? (
        <Filter
          label="Filter Branches"
          placeholder="Filter Branches"
          value={filter}
          onChange={setFilter}
          testId="first-run-branch-filter"
        />
      ) : null}
      <Options
        label={`Branches of ${repo.fullName}`}
        value={pick}
        onChange={setPick}
        items={shown.map((name) => ({
          value: name,
          title: name,
          line: name === fallback ? 'The repository’s default branch' : '',
          ...(name === fallback ? { chip: 'Default' } : {}),
          testId: 'first-run-pick-branch',
          event: 'firstrun.branch',
        }))}
      />
      {shown.length === 0 ? (
        <p className="fr-lead fr-small">No branch matches “{filter.trim()}”.</p>
      ) : null}
    </Frame>
  );
}
