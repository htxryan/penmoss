/**
 * Settings → Status → GitHub Token, in the Mac app (T57, A1012): the person's own GitHub token,
 * which Send feedback files issues with and updates read the Releases with (A1010, A1015). It is
 * typed here, checked by the main process with GitHub, and kept in the Keychain there; this page
 * only ever learns whether one is saved, whose it is, and what GitHub said is wrong with it.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { desktop, type DesktopGitHubToken, type DesktopGitHubTokenStatus } from '../desktop/bridge';

export function GitHubTokenSettings() {
  const token = desktop()?.githubToken;
  return token ? <TokenSection token={token} /> : null;
}

function TokenSection({ token }: { token: DesktopGitHubToken }) {
  const id = useId();
  const [status, setStatus] = useState<DesktopGitHubTokenStatus | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const refresh = useCallback(() => {
    void token.status().then((next) => setStatus(next));
  }, [token]);
  useEffect(() => {
    refresh();
    return token.onChange(refresh);
  }, [token, refresh]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const answer = await token.save(value);
      if (!answer) return;
      if (answer.ok) {
        setValue('');
        setStatus(answer.status);
        setMessage(answer.note ? { text: answer.note, error: false } : null);
      } else {
        setMessage({ text: answer.message, error: true });
      }
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const answer = await token.remove();
      if (answer?.ok) setStatus(answer.status);
      else if (answer) setMessage({ text: answer.message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby={`${id}-h`} data-testid="github-token">
      <h2 id={`${id}-h`}>GitHub Token</h2>
      <p className="muted">
        Send feedback files issues in htxryan/penmoss with your own GitHub token: the one Sign In
        with GitHub (in Add a Git Notebook) keeps here, a classic token with the public_repo scope
        or, as a collaborator, a fine-grained token for htxryan/penmoss with Issues and Contents
        (read and write). It is kept in this Mac’s Keychain and never shown again; Sign Out forgets
        it.
      </p>
      {status === null ? null : status.saved ? (
        <p data-testid="github-token-saved">
          {status.signedIn
            ? `Signed in to GitHub${status.login ? ` as ${status.login}` : ''}.`
            : `Saved${status.login ? ` for ${status.login}` : ''}.`}
          {status.problem ? (
            <span role="alert" className="field-error" data-testid="github-token-problem">
              {' '}
              {status.problem}
            </span>
          ) : null}
        </p>
      ) : (
        <p className="muted" data-testid="github-token-none">
          {status.keychain
            ? 'No token saved: feedback waits in the outbox.'
            : 'This Mac’s Keychain is not available, so no token can be kept.'}
        </p>
      )}
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) void save();
        }}
      >
        <label htmlFor={`${id}-input`} className="sr-only">
          GitHub token
        </label>
        <input
          id={`${id}-input`}
          type="password"
          className="input"
          autoComplete="off"
          spellCheck={false}
          placeholder={status?.saved ? 'Paste a new token to replace it' : 'github_pat_… or ghp_…'}
          value={value}
          disabled={busy || status?.keychain === false}
          onChange={(event) => setValue(event.target.value)}
          data-testid="github-token-input"
        />
        <button
          type="submit"
          className="btn primary"
          data-ui="submit"
          disabled={busy || !value.trim()}
          data-testid="github-token-save"
        >
          {busy ? 'Checking…' : 'Save'}
        </button>
        {status?.saved ? (
          <button
            type="button"
            className="btn quiet"
            data-ui="dismiss"
            disabled={busy}
            onClick={() => void remove()}
            data-testid="github-token-remove"
          >
            Sign Out
          </button>
        ) : null}
      </form>
      {message ? (
        <p
          role={message.error ? 'alert' : 'status'}
          className={message.error ? 'field-error' : 'muted'}
          data-testid="github-token-message"
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
