/**
 * Sign in with GitHub (T82, #229; D63, A1170), as Settings → GitHub shows it: main asks GitHub
 * for a short code and opens github.com/login/device; the person enters the code there and
 * approves, and main keeps the token. This shows the code (with Copy), waits, and says how it
 * ended. Nothing shows in a build without Penmoss's OAuth app. The notebook steps (the first run
 * and Add Notebook, A1562) draw the same sign-in (`useDeviceSignIn`) as screens of their own
 * (Ryan's review of #192, findings 3 and 4).
 */
import { Icon } from '@penmoss/ui/icons';
import type { DesktopGitHubSignIn } from '../desktop/bridge';
import { useDeviceSignIn } from './device-sign-in';

export function GitHubSignIn({
  signIn,
  again = false,
  adding = false,
  onSignedIn,
}: {
  signIn: DesktopGitHubSignIn;
  /** GitHub refused Penmoss's earlier sign-in: the button says Sign In Again. */
  again?: boolean;
  /** Another account beside the ones kept (A1617): Add Account, and which account GitHub signs in. */
  adding?: boolean;
  /** The sign-in this started finished: list the repositories with it. */
  onSignedIn: () => void;
}) {
  const { available, state, ended, asking, copied, start, cancel, copy } = useDeviceSignIn(
    signIn,
    onSignedIn,
  );
  if (!available) return null;

  if (state.state === 'waiting') {
    return (
      <div className="repo-sign-in" data-testid="github-signin" data-state="waiting">
        <p>Enter this code on GitHub, in the page that opened in your browser:</p>
        {adding ? (
          <p className="muted" data-testid="github-signin-which">
            GitHub signs in the account its page shows at the top right: switch there first to add
            another one, such as a work account.
          </p>
        ) : null}
        <div className="repo-sign-in-code">
          <code data-testid="github-signin-code" aria-label={`Code ${state.userCode}`}>
            {state.userCode}
          </code>
          <button
            type="button"
            className="btn"
            data-ui="item"
            data-testid="github-signin-copy"
            onClick={copy}
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
            onClick={cancel}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="repo-sign-in" data-testid="github-signin" data-state={state.state}>
      {ended ? (
        <p role="status" data-testid="github-signin-ended">
          {ended}
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
          <Icon name={adding && !again ? 'userPlus' : 'logIn'} size={14} />
          {asking
            ? 'Asking GitHub…'
            : ended
              ? 'Try Again'
              : again
                ? 'Sign In to GitHub Again'
                : adding
                  ? 'Add Account'
                  : 'Sign In with GitHub'}
        </button>
        <span className="muted">Penmoss keeps the sign-in in this Mac’s Keychain.</span>
      </div>
    </div>
  );
}
