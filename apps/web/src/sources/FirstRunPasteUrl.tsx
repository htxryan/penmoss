/** The first run's Paste a URL screen (5.x; FirstRunRepos.tsx has the others). */
import { useId, useState, type FormEvent } from 'react';
import {
  nameFromRepo,
  refusalWords,
  repoNameOf,
  type AddNotebook,
  type Place,
  type Setup,
} from './first-run-flow';
import { Action, Frame, MoreOptions, Problem, Working } from './FirstRunFrame';

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
