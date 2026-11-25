/** The first run's Create New Repo screen (3.x; FirstRunRepos.tsx has the others). */
import { defaultRepoName } from '@penmoss/git-notebook/github-browse';
import { Select } from '@penmoss/ui/controls/Select';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { DesktopGitHubBrowse } from '../desktop/bridge';
import { placeIn, type Hub, type Place } from './first-run-flow';
import { Action, Frame, LinkButton, Problem } from './FirstRunFrame';
import { NameField } from './FirstRunNameNotebook';

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
