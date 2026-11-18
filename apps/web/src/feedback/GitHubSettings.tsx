/**
 * Settings → GitHub, in the Mac app (PEN-146; was Status, T57, A1012; several accounts, A1617): the GitHub sign-ins
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
import { Icon } from '@penmoss/ui/icons';
import { GitHubSignIn } from '../sources/GitHubSignIn';
import { accountsOf } from './github-accounts';
import { GroupHead, SettingRow } from '../theme/look-rows';
import { useFeedback, useOutbox, type FeedbackService } from './service';
import { SettingsHeader } from '../pages/SettingsHeader';

const REPO = `${FEEDBACK_REPO.owner}/${FEEDBACK_REPO.repo}`;

/**
 * `embedded`: Add Notebook's GitHub Accounts screen (A1617), the accounts alone, under the flow's
 * own title.
 */
export function GitHubSettings({ embedded = false }: { embedded?: boolean } = {}) {
  const bridge = desktop();
  const token = bridge?.githubToken;
  if (!token) return null;
  return (
    <GitHubSection token={token} signIn={bridge.git?.github?.signIn ?? null} embedded={embedded} />
  );
}

function GitHubSection({
  token,
  signIn,
  embedded,
}: {
  token: DesktopGitHubToken;
  signIn: DesktopGitHubSignIn | null;
  embedded: boolean;
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

  const signOut = async (login: string | null) => {
    setBusy(true);
    setMessage(null);
    try {
      const answer = await token.remove(login);
      if (answer?.ok) setStatus(answer.status);
      else if (answer) setMessage({ text: answer.message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const makePrimary = async (login: string) => {
    if (!token.makePrimary) return;
    setBusy(true);
    setMessage(null);
    try {
      const answer = await token.makePrimary(login);
      if (answer?.ok) setStatus(answer.status);
      else if (answer) setMessage({ text: answer.message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const keychain = status?.keychain !== false;
  const accounts = status ? accountsOf(status) : [];
  // Sign in with GitHub: again for an account GitHub no longer takes, or another beside the ones
  // kept (A1617), which Add Account shows.
  const refused = accounts.some((account) => account.problem !== null);
  const offerSignIn = status !== null && keychain;
  // Without Penmoss's OAuth app the token is the only way, so its field shows at once.
  const showToken = status !== null && keychain && (tokenOpen || canSignIn === false);
  // Drawn once the sign-in's availability is known, so the field does not swap in for the button.
  const offerToken = canSignIn !== null && status !== null && keychain;

  return (
    <section className="settings-section" aria-labelledby={`${id}-h`} data-testid="github-token">
      {embedded ? (
        <p className="fr-lead" id={`${id}-h`}>
          Add another account, such as a work one, or sign out of one. Back lists the accounts to
          pick from.
        </p>
      ) : (
        <SettingsHeader
          id={`${id}-h`}
          title="GitHub"
          intro="Your GitHub accounts for adding notebooks and sending feedback, kept in this Mac’s Keychain. Add a work account beside a personal one."
        />
      )}
      <div className="lf-group">
        {status === null ? null : accounts.length > 0 ? (
          accounts.map((account, at) => (
            <SettingRow
              key={account.login ?? `account-${at}`}
              setting={at === 0 ? 'github-account' : `github-account-${account.login ?? at}`}
              label={account.login ?? 'GitHub'}
              testId={at === 0 ? 'github-account' : `github-account-${account.login ?? at}`}
              help={
                <>
                  <span data-testid={at === 0 ? 'github-token-saved' : undefined}>
                    {[
                      account.primary && accounts.length > 1 ? 'Send Feedback uses it' : null,
                      account.signedIn ? 'Signed in with GitHub' : 'Token saved',
                      'kept in this Mac’s Keychain',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {account.problem ? (
                    <span
                      role="alert"
                      className="field-error"
                      data-testid={at === 0 ? 'github-token-problem' : undefined}
                    >
                      {' '}
                      {account.problem}
                    </span>
                  ) : null}
                </>
              }
            >
              {!account.primary && account.login && token.makePrimary ? (
                <button
                  type="button"
                  className="btn quiet"
                  data-ui="item"
                  disabled={busy}
                  onClick={() => void makePrimary(account.login!)}
                  data-testid="github-make-primary"
                >
                  <Icon name="feedback" size={14} />
                  Use for Send Feedback
                </button>
              ) : null}
              <button
                type="button"
                className="btn quiet"
                data-ui="dismiss"
                disabled={busy}
                onClick={() => void signOut(account.login)}
                data-testid={at === 0 ? 'github-token-remove' : 'github-account-remove'}
                aria-label={
                  accounts.length > 1 ? `Sign Out of ${account.login ?? 'GitHub'}` : undefined
                }
              >
                <Icon name="logOut" size={14} />
                Sign Out
              </button>
            </SettingRow>
          ))
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
        <GitHubSignIn
          signIn={signIn}
          again={refused && accounts.length === 1}
          adding={accounts.length > 0 && !(refused && accounts.length === 1)}
          onSignedIn={refresh}
        />
      ) : null}
      {offerToken ? (
        <div className="github-token" data-setting="github-token">
          {showToken ? (
            <TokenForm
              token={token}
              saved={accounts.length > 0}
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
              <Icon name="key" size={14} />
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
      {embedded ? null : (
        <>
          <GroupHead>Used For</GroupHead>
          <div className="lf-group">
            <SettingRow
              setting="adding-notebooks"
              label="Adding Notebooks"
              help="Lists each account’s repositories. A notebook keeps a copy of its account’s token and syncs as that account."
            />
            <FeedbackUse />
          </div>
        </>
      )}
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
