/**
 * Settings → GitHub, in the Mac app (PEN-146; was Status, T57, A1012): the one GitHub sign-in
 * Penmoss keeps in this Mac's Keychain, which Add a Git Notebook browses with and Send Feedback
 * files issues with (D63, A1010). Sign In with GitHub comes first, the device sign-in Add a Git
 * Notebook uses (T82, A1170); Use a Token Instead… opens a field for a pasted token, checked by
 * the main process with GitHub. Removing either is Sign Out. The page only ever learns whether
 * one is kept, whose it is, and what GitHub said is wrong with it. Then what it is used for, with
 * the reports waiting in Send Feedback's outbox.
 */
import { FEEDBACK_REPO } from '@penmoss/core/feedback-github';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useCommands } from '../commands/hooks';
import {
  desktop,
  type DesktopGitHubSignIn,
  type DesktopGitHubToken,
  type DesktopGitHubTokenStatus,
} from '../desktop/bridge';
import { GitHubSignIn } from '../sources/GitHubSignIn';
import { GroupHead, SettingRow } from '../theme/look-rows';
import { useFeedback, useOutbox, type FeedbackService } from './service';

const REPO = `${FEEDBACK_REPO.owner}/${FEEDBACK_REPO.repo}`;

export function GitHubSettings() {
  const bridge = desktop();
  const token = bridge?.githubToken;
  if (!token) return null;
  return <GitHubSection token={token} signIn={bridge.git?.github?.signIn ?? null} />;
}

function GitHubSection({
  token,
  signIn,
}: {
  token: DesktopGitHubToken;
  signIn: DesktopGitHubSignIn | null;
}) {
  const id = useId();
  const [status, setStatus] = useState<DesktopGitHubTokenStatus | null>(null);
  /** Whether this build can sign in with GitHub (its OAuth app); null until asked. */
  const [canSignIn, setCanSignIn] = useState<boolean | null>(signIn ? null : false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const refresh = useCallback(() => {
    void token.status().then((next) => setStatus(next));
  }, [token]);
  useEffect(() => {
    refresh();
    return token.onChange(refresh);
  }, [token, refresh]);
  useEffect(() => {
    if (!signIn) return;
    let live = true;
    void signIn
      .status()
      .catch(() => null)
      .then((answer) => {
        if (live) setCanSignIn(Boolean(answer?.available));
      });
    return () => {
      live = false;
    };
  }, [signIn]);

  const signOut = async () => {
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

  const keychain = status?.keychain !== false;
  // Signing in (again) is offered with none kept, or one GitHub no longer takes.
  const offerSignIn = status !== null && keychain && (!status.saved || status.problem !== null);
  // Without Penmoss's OAuth app the token is the only way, so its field shows at once.
  const showToken = status !== null && keychain && (tokenOpen || canSignIn === false);
  // Signed in and working: Sign Out is the one action; a token replaces one only after it.
  // Drawn once the sign-in's availability is known, so the field does not swap in for the button.
  const offerToken = canSignIn !== null && (showToken || offerSignIn);

  return (
    <section className="settings-section" aria-labelledby={`${id}-h`} data-testid="github-token">
      <h2 id={`${id}-h`}>GitHub</h2>
      <p className="muted">
        One GitHub sign-in for adding notebooks and sending feedback, kept in this Mac’s Keychain.
      </p>
      <div className="lf-group">
        {status === null ? null : status.saved ? (
          <SettingRow
            setting="github-account"
            label={status.login ?? 'GitHub'}
            testId="github-account"
            help={
              <>
                <span data-testid="github-token-saved">
                  {status.signedIn
                    ? 'Signed in with GitHub · kept in this Mac’s Keychain'
                    : 'Token saved · kept in this Mac’s Keychain'}
                </span>
                {status.problem ? (
                  <span role="alert" className="field-error" data-testid="github-token-problem">
                    {' '}
                    {status.problem}
                  </span>
                ) : null}
              </>
            }
          >
            <button
              type="button"
              className="btn quiet"
              data-ui="dismiss"
              disabled={busy}
              onClick={() => void signOut()}
              data-testid="github-token-remove"
            >
              Sign Out
            </button>
          </SettingRow>
        ) : (
          <SettingRow
            setting="github-account"
            label="Not Signed In"
            testId="github-account"
            help={
              <span data-testid="github-token-none">
                {keychain
                  ? 'Sign in to pick notebooks from your repositories and to send feedback.'
                  : 'This Mac’s Keychain is not available, so no sign-in can be kept.'}
              </span>
            }
          />
        )}
      </div>
      {offerSignIn && signIn && canSignIn ? (
        <GitHubSignIn signIn={signIn} again={status.saved} onSignedIn={refresh} />
      ) : null}
      {offerToken ? (
        <div className="github-token" data-setting="github-token">
          {showToken ? (
            <TokenForm
              token={token}
              saved={status?.saved === true}
              focus={tokenOpen}
              busy={busy}
              setBusy={setBusy}
              onSaved={(next, note) => {
                setStatus(next);
                setTokenOpen(false);
                setMessage(note ? { text: note, error: false } : null);
              }}
              onRefused={(text) => setMessage({ text, error: true })}
              onTyping={() => setMessage(null)}
            />
          ) : (
            <button
              type="button"
              className="btn quiet"
              data-ui="item"
              aria-expanded={false}
              onClick={() => setTokenOpen(true)}
              data-testid="github-token-open"
            >
              Use a Token Instead…
            </button>
          )}
        </div>
      ) : null}
      {message ? (
        <p
          role={message.error ? 'alert' : 'status'}
          className={message.error ? 'field-error' : 'muted'}
          data-testid="github-token-message"
        >
          {message.text}
        </p>
      ) : null}
      <GroupHead>Used For</GroupHead>
      <div className="lf-group">
        <SettingRow
          setting="adding-notebooks"
          label="Adding Notebooks"
          help="Lists your repositories when git on this Mac has no sign-in"
        />
        <FeedbackUse />
      </div>
    </section>
  );
}

/** The token field (T57): a classic or fine-grained token, checked with GitHub before it's kept. */
function TokenForm({
  token,
  saved,
  focus,
  busy,
  setBusy,
  onSaved,
  onRefused,
  onTyping,
}: {
  token: DesktopGitHubToken;
  saved: boolean;
  /** Opened by Use a Token Instead…: the field takes focus. */
  focus: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onSaved: (status: DesktopGitHubTokenStatus, note: string | null) => void;
  onRefused: (message: string) => void;
  onTyping: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  // The field opens on a click: it takes focus then, as a disclosure's content would.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) field.current?.focus();
  }, [focus]);
  const save = async () => {
    setBusy(true);
    try {
      const answer = await token.save(value);
      if (!answer) return;
      if (answer.ok) {
        setValue('');
        onSaved(answer.status, answer.note);
      } else {
        onRefused(answer.message);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="settings-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) void save();
      }}
    >
      <label htmlFor={`${id}-input`}>GitHub Token</label>
      <span className="row">
        <input
          id={`${id}-input`}
          type="password"
          className="input"
          autoComplete="off"
          spellCheck={false}
          ref={field}
          placeholder={saved ? 'Paste a new token to replace it' : 'github_pat_… or ghp_…'}
          value={value}
          disabled={busy}
          aria-describedby={`${id}-help`}
          onChange={(event) => {
            setValue(event.target.value);
            onTyping();
          }}
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
      </span>
      <p id={`${id}-help`} className="muted settings-help">
        A classic token with the public_repo scope or, as a collaborator, a fine-grained token for{' '}
        {REPO} with Issues and Contents (read and write). It is never shown again.
      </p>
    </form>
  );
}

/** Send Feedback's row: where it files, how many reports wait, and Open. */
function FeedbackUse() {
  const feedback = useFeedback();
  return feedback ? (
    <FeedbackRow feedback={feedback} />
  ) : (
    <SettingRow setting="send-feedback" label="Send Feedback" help={`Opens issues in ${REPO}`} />
  );
}

function FeedbackRow({ feedback }: { feedback: FeedbackService }) {
  const waiting = useOutbox(feedback).length;
  const commands = useCommands();
  // A note window's report waits in the shared store; read it again when the page opens.
  useEffect(() => {
    void feedback.outbox.refresh();
  }, [feedback]);
  return (
    <SettingRow
      setting="send-feedback"
      label="Send Feedback"
      testId="github-feedback"
      help={
        <>
          Opens issues in {REPO}
          {waiting > 0 ? (
            <span data-testid="github-feedback-waiting">
              {' '}
              · {waiting} {waiting === 1 ? 'report' : 'reports'} waiting
            </span>
          ) : null}
        </>
      }
    >
      <button
        type="button"
        className="btn quiet"
        data-ui="item"
        onClick={() => commands.run('app.sendFeedback', { source: 'button' })}
        data-testid="github-feedback-open"
      >
        Open
      </button>
    </SettingRow>
  );
}
