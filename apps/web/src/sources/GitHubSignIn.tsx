/**
 * Sign in with GitHub (T82, #229; D63, A1170): when git on this Mac has no GitHub sign-in, Add a
 * Git Notebook offers Penmoss's own. Main asks GitHub for a short code and opens
 * github.com/login/device; the person enters the code there and approves, and main keeps the
 * token. This shows the code (with Copy), waits, and says how it ended. Nothing shows in a build
 * without Penmoss's OAuth app.
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useEffectEvent, useState } from 'react';
import type { DesktopGitHubSignIn, GitHubSignInState } from '../desktop/bridge';

/** What a sign-in that did not finish says, and the button's words then. */
const ENDED: Partial<Record<GitHubSignInState['state'], string>> = {
  denied: 'GitHub says the sign-in was not approved.',
  expired: 'The code ran out before it was approved. Ask for a new one.',
  cancelled: 'Sign-in cancelled.',
};

export function GitHubSignIn({
  signIn,
  again = false,
  onSignedIn,
}: {
  signIn: DesktopGitHubSignIn;
  /** GitHub refused Penmoss's earlier sign-in: the button says Sign In Again. */
  again?: boolean;
  /** The sign-in this started finished: list the repositories with it. */
  onSignedIn: () => void;
}) {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<GitHubSignInState>({ state: 'idle' });
  const [started, setStarted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Main is asking GitHub for a code. */
  const [asking, setAsking] = useState(false);
  const finished = useEffectEvent((next: GitHubSignInState) => {
    setState(next);
    if (next.state === 'signed-in' && started) onSignedIn();
  });

  useEffect(() => {
    let live = true;
    void signIn
      .status()
      .catch(() => null)
      .then((status) => {
        if (!live || !status) return;
        setAvailable(status.available);
        // A sign-in still waiting from before (the form was closed and opened again) is shown,
        // and its approval lists the repositories as one started here would (review).
        if (status.state.state === 'waiting') {
          setState(status.state);
          setStarted(true);
        }
      });
    const stop = signIn.onChange((next) => finished(next));
    return () => {
      live = false;
      stop();
    };
  }, [signIn]);

  if (!available) return null;

  const start = async () => {
    // One start at a time: a second click would ask GitHub for a second code (review).
    if (asking) return;
    setAsking(true);
    setProblem(null);
    setCopied(false);
    setStarted(true);
    try {
      const answer = await signIn.start().catch(() => null);
      if (!answer) {
        setProblem('This window can’t sign in to GitHub.');
      } else if ('ok' in answer) {
        setProblem(answer.ok ? null : answer.error.message);
      } else {
        setState(answer);
      }
    } finally {
      setAsking(false);
    }
  };

  if (state.state === 'waiting') {
    return (
      <div className="repo-sign-in" data-testid="github-signin" data-state="waiting">
        <p>Enter this code on GitHub, in the page that opened in your browser:</p>
        <div className="repo-sign-in-code">
          <code data-testid="github-signin-code" aria-label={`Code ${state.userCode}`}>
            {state.userCode}
          </code>
          <button
            type="button"
            className="btn"
            data-ui="item"
            data-testid="github-signin-copy"
            onClick={() =>
              void navigator.clipboard
                .writeText(state.userCode)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          >
            <Icon name="copy" size={14} />
            {copied ? 'Copied' : 'Copy Code'}
          </button>
        </div>
        <p className="muted" role="status" data-testid="github-signin-waiting">
          Waiting for you to approve Penmoss on GitHub…{' '}
          <a href={state.verificationUri} target="_blank" rel="noreferrer">
            Open the page again
          </a>
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="btn quiet"
            data-ui="dismiss"
            data-testid="github-signin-cancel"
            onClick={() => void signIn.cancel()}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const ended = state.state === 'failed' ? state.message : (ENDED[state.state] ?? null);
  return (
    <div className="repo-sign-in" data-testid="github-signin" data-state={state.state}>
      {ended || problem ? (
        <p role="status" data-testid="github-signin-ended">
          {problem ?? ended}
        </p>
      ) : null}
      <div className="settings-actions">
        <button
          type="button"
          className="btn primary"
          data-ui="item"
          data-testid="github-signin-start"
          disabled={asking}
          onClick={() => void start()}
        >
          <Icon name="logIn" size={14} />
          {asking
            ? 'Asking GitHub…'
            : ended
              ? 'Try Again'
              : again
                ? 'Sign In to GitHub Again'
                : 'Sign In with GitHub'}
        </button>
        <span className="muted">Penmoss keeps the sign-in in this Mac’s Keychain.</span>
      </div>
    </div>
  );
}
