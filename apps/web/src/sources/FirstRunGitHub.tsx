/**
 * The first run's GitHub Access (First Run C, 2.1–2.9): git's own GitHub sign-in is tried first
 * (GitHub Desktop, gh or the Keychain); with none, Sign In with GitHub (D63, the device code), or
 * Terminal's `gh auth login`. Refused, offline or rate-limited, it says so with Try Again, and
 * Paste a URL Instead goes on without GitHub. Once a sign-in answers, the flow goes straight on to
 * the next screen, which names the sign-in in a line (2.2 is not a stop). With two GitHub
 * accounts or more (git's and Penmoss's, A1617) it never asks which: the first one's repositories,
 * and the switcher above them changes it or adds another (A1618).
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useState } from 'react';
import type { BrowseError, DesktopGitHubBrowse, GitHubAccountChoice } from '../desktop/bridge';
import { accountChoices } from './github-choices';
import { useDeviceSignIn } from './device-sign-in';
import { FIRST_RUN_DOCS, readHub, type Hub } from './first-run-flow';
import { Action, Frame, LinkButton, Problem, Working } from './FirstRunFrame';

type Check =
  { readonly state: 'checking' } | { readonly state: 'failed'; readonly error: BrowseError };

export function GitHubAccess({
  github,
  onReady,
  onUrl,
  back,
  keep,
  add = false,
}: {
  github: DesktopGitHubBrowse;
  onReady: (hub: Hub) => void;
  onUrl: () => void;
  back: () => void;
  /** Refresh, or an account picked in the switcher: read it (A1618). Add's Back comes back to it. */
  keep?: { readonly account: GitHubAccountChoice | undefined };
  /** The switcher's Add Another Account: straight to the sign-in, nothing read until it ends. */
  add?: boolean;
}) {
  const [check, setCheck] = useState<Check>({ state: 'checking' });
  /** -1: Add Another Account came first, so nothing is read yet. */
  const [asked, setAsked] = useState(add ? -1 : 0);
  /** Penmoss's own sign-in just finished: 2.5, then Continue. */
  const [signedIn, setSignedIn] = useState(false);
  const device = useDeviceSignIn(github.signIn, () => setSignedIn(true));
  /** The account picked, or just signed in to: its repositories are read (A1617). */
  const [picked, setPicked] = useState<{ account: GitHubAccountChoice | undefined } | null>(
    keep ?? null,
  );
  /** Add Another Account: the sign-in, with the other accounts kept. */
  const [adding, setAdding] = useState(add);

  useEffect(() => {
    if (asked < 0) return;
    let live = true;
    void (async () => {
      // Never Pick GitHub Account (Ryan, 18 Nov 2026; A1618): the one picked, else the first.
      const choices = await accountChoices(github);
      if (!live) return;
      const kept = picked && choices.some((each) => each.account === picked.account);
      // With one account or none, no choice: git's sign-in, else Penmoss's.
      const account = kept ? picked.account : choices.length >= 2 ? choices[0]!.account : undefined;
      const answer = await readHub(github, account);
      if (!live) return;
      if (answer.ok) onReady(answer.hub);
      else setCheck({ state: 'failed', error: answer.error });
    })();
    return () => {
      live = false;
    };
    // onReady is the flow's; a new one each render must not ask GitHub again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [github, asked]);

  const again = () => {
    setSignedIn(false);
    setCheck({ state: 'checking' });
    setAsked((now) => now + 1);
  };
  const urlInstead = (
    <Action testId="first-run-url-instead" onClick={onUrl}>
      Paste a URL Instead
    </Action>
  );
  const signInButton = (words: string) =>
    device.available ? (
      <Action
        primary
        icon="logIn"
        busy={device.asking}
        testId="first-run-signin"
        onClick={() => void device.start()}
      >
        {device.asking ? 'Asking GitHub…' : words}
      </Action>
    ) : (
      <Action primary icon="refresh" testId="first-run-retry" onClick={again}>
        Try Again
      </Action>
    );

  // 2.5: Penmoss's sign-in was approved.
  if (signedIn !== false) {
    const login = device.state.state === 'signed-in' ? device.state.login : null;
    return (
      <Frame
        name="github"
        state="signed-in"
        step={2}
        title="Signed In to GitHub"
        back={back}
        actions={
          <Action
            primary
            testId="first-run-continue"
            onClick={() => {
              // The account just signed in to: its repositories (A1617).
              if (login) setPicked({ account: login });
              setAdding(false);
              again();
            }}
          >
            Continue
          </Action>
        }
      >
        <p className="fr-ok" role="status" data-testid="first-run-signed-in">
          {login ? (
            <>
              Signed in as <strong>{login}</strong>
            </>
          ) : (
            'Signed in'
          )}
        </p>
        <p className="fr-lead fr-small">
          Kept in this Mac’s Keychain. Sign out in Settings → GitHub.
        </p>
      </Frame>
    );
  }

  // 2.4: the device code.
  if (device.state.state === 'waiting') {
    const waiting = device.state;
    return (
      <Frame
        name="github"
        state="code"
        step={2}
        title="Enter This Code on GitHub"
        back={() => {
          device.cancel();
          back();
        }}
        actions={
          <Action testId="github-signin-cancel" onClick={device.cancel}>
            Cancel
          </Action>
        }
      >
        <p className="fr-lead">GitHub’s sign-in page opened in your browser.</p>
        <code
          className="fr-code"
          data-testid="github-signin-code"
          aria-label={`Code ${waiting.userCode}`}
        >
          {waiting.userCode}
        </code>
        <div className="fr-row fr-even">
          <Action icon="copy" testId="github-signin-copy" onClick={device.copy}>
            {device.copied ? 'Copied' : 'Copy Code'}
          </Action>
          <a className="btn" href={waiting.verificationUri} target="_blank" rel="noreferrer">
            <Icon name="link" size={14} />
            Open {waiting.verificationUri.replace(/^https?:\/\//, '')}
          </a>
        </div>
        <Working testId="github-signin-waiting">Waiting for you to approve…</Working>
      </Frame>
    );
  }

  // Add Another Account (A1617): Penmoss's sign-in, as another GitHub account.
  if (adding) {
    return (
      <Frame
        name="github"
        state="adding"
        step={2}
        title="Add GitHub Account"
        back={() => {
          setAdding(false);
          if (device.ended) device.cancel();
          // Opened from the switcher: the account listed before, its repositories again.
          if (asked < 0) again();
        }}
        actions={
          <>
            {urlInstead}
            {signInButton('Sign In with GitHub')}
          </>
        }
      >
        {device.ended ? <Problem testId="github-signin-ended">{device.ended}</Problem> : null}
        <p className="fr-lead">
          Sign in as your other GitHub account. Your other accounts, and the notebooks added with
          them, stay as they are.
        </p>
        <p className="fr-lead fr-small" data-testid="first-run-add-account-hint">
          On GitHub’s page, check the account shown at the top right is the one you want; switch
          accounts there if it isn’t.
        </p>
      </Frame>
    );
  }

  if (check.state === 'checking') {
    return (
      <Frame name="github" state="checking" step={2} title="Checking GitHub" back={back}>
        <Working>Looking for this Mac’s GitHub sign-in…</Working>
      </Frame>
    );
  }

  const { error } = check;
  // 2.6: Penmoss's sign-in was cancelled, refused on GitHub's page, or ran out.
  if (device.ended) {
    return (
      <Frame
        name="github"
        state="stopped"
        step={2}
        title="Sign In to GitHub"
        back={back}
        actions={
          <>
            {urlInstead}
            {signInButton('Sign In Again')}
          </>
        }
      >
        <Problem testId="github-signin-ended">{device.ended}</Problem>
      </Frame>
    );
  }

  // 2.7: GitHub refuses the sign-in git (or Penmoss) has: expired, or an organisation's SSO.
  if (error.reason === 'unauthorized' || error.reason === 'forbidden') {
    return (
      <Frame
        name="github"
        state="refused"
        step={2}
        title="GitHub Refused the Sign-In"
        back={back}
        actions={
          <>
            {urlInstead}
            {signInButton('Sign In with GitHub')}
          </>
        }
      >
        <Problem testId="first-run-github-problem">{error.message}</Problem>
        <p className="fr-lead">
          Repositories in an organisation with single sign-on need Penmoss authorised for it on
          GitHub.
        </p>
        {device.available ? (
          <LinkButton testId="first-run-retry" onClick={again}>
            Try Again
          </LinkButton>
        ) : null}
      </Frame>
    );
  }

  // 2.3: no GitHub sign-in in git.
  if (error.reason === 'no_credential' || error.reason === 'timeout') {
    return (
      <Frame
        name="github"
        state="signed-out"
        step={2}
        title="Sign In to GitHub"
        back={back}
        actions={
          <>
            {urlInstead}
            {signInButton('Sign In with GitHub')}
          </>
        }
      >
        <p className="fr-lead">
          {error.reason === 'timeout'
            ? 'Git took too long to answer for its GitHub sign-in.'
            : 'Penmoss lists your repositories and syncs with this sign-in.'}
        </p>
        <p className="fr-lead fr-small" data-testid="first-run-gh-hint">
          Prefer Terminal? Run <code>gh auth login</code>, then{' '}
          {device.available ? (
            <LinkButton testId="first-run-retry" onClick={again}>
              Try Again
            </LinkButton>
          ) : (
            'Try Again'
          )}
          .{' '}
          <a href={FIRST_RUN_DOCS} target="_blank" rel="noreferrer">
            Learn More
          </a>
        </p>
      </Frame>
    );
  }

  // 2.9: offline, rate-limited, or anything else GitHub answered.
  return (
    <Frame
      name="github"
      state="unreachable"
      step={2}
      title={error.reason === 'offline' ? 'Can’t Reach GitHub' : 'GitHub Didn’t Answer'}
      back={back}
      actions={
        <>
          {urlInstead}
          <Action primary icon="refresh" testId="first-run-retry" onClick={again}>
            Try Again
          </Action>
        </>
      }
    >
      <Problem testId="first-run-github-problem">
        {error.reason === 'offline' ? 'Check the connection, then try again.' : error.message}
      </Problem>
      {error.reason === 'offline' || error.reason === 'rate_limited' ? (
        <p className="fr-lead fr-small">If GitHub is limiting requests, wait a few minutes.</p>
      ) : null}
    </Frame>
  );
}
