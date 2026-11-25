/** A notebook page's Git tab (GitNotebooksSettings.tsx). */
import { useId, useState, type FormEvent } from 'react';
import { type DesktopGit, type GitNotebookInfo } from '../desktop/bridge';
import { useGitInfo } from './hooks';
import type { GitSource } from './git-source';
import { SettingRow, Switch } from '../theme/look-rows';
import { type Answer } from './notebook-settings-shared';

/** Git: this notebook's commit name and email, signing, and the sign-in it uses. */
export function GitTab({
  source,
  git,
  identity,
  answer,
  busy,
}: {
  source: GitSource;
  git: DesktopGit;
  identity: { name: string; email: string } | null;
  answer: Answer;
  busy: boolean;
}) {
  const info = useGitInfo(source);
  const [token, setToken] = useState('');
  const id = useId();
  return (
    <div className="lf-group nset-first-group">
      <div className="lf-row nset-stack" data-setting="commit-name-and-email">
        <div className="lf-row-text">
          <span className="lf-row-label">Commit Name and Email</span>
          <span className="lf-row-help">
            This notebook’s own, over git’s; a GitHub no-reply address keeps yours private
          </span>
        </div>
        <CommitIdentity info={info} git={git} identity={identity} answer={answer} busy={busy} />
      </div>
      <SettingRow
        setting="sign-commits"
        label="Sign Commits"
        labelFor={`${id}-sign`}
        help={
          info.sign
            ? 'With the key git is configured to sign with'
            : 'Never signs this notebook’s commits'
        }
      >
        <Switch
          id={`${id}-sign`}
          checked={info.sign}
          data-event="settings.git-notebooks.sign-commits"
          data-testid="git-sign"
          onChange={(event) =>
            void answer(
              () => git.update(info.localId, { sign: event.target.checked }),
              () =>
                event.target.checked
                  ? 'Signs commits as git’s configuration says.'
                  : 'Never signs this notebook’s commits.',
            )
          }
        />
      </SettingRow>
      <div className="lf-row nset-stack" data-setting="sign-in">
        <div className="lf-row-text">
          <label className="lf-row-label" htmlFor={`${id}-token`}>
            Sign-In
          </label>
          <span className="lf-row-help" data-testid="git-sign-in">
            {info.hasToken
              ? 'A personal access token, kept in the Keychain'
              : 'Git’s own credentials, or a personal access token for an HTTPS host that needs one'}
          </span>
        </div>
        <form
          className="git-notebook-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const value = token.trim();
            setToken('');
            void answer(
              () => git.setToken(info.localId, value),
              () => 'Kept in the Keychain. Penmoss never shows it again.',
            ).then(() => source.syncNow());
          }}
        >
          <input
            id={`${id}-token`}
            type="password"
            className="input"
            autoComplete="off"
            placeholder={
              info.hasToken ? 'A new token replaces the one set' : 'Personal access token'
            }
            value={token}
            data-testid="git-token"
            onChange={(event) => setToken(event.target.value)}
          />
          <div className="settings-actions">
            <button
              data-event="settings.git-notebooks.token.save"
              type="submit"
              className="btn"
              data-ui="submit"
              disabled={busy || token.trim() === ''}
            >
              Save Token
            </button>
            {info.hasToken ? (
              <button
                data-event="settings.git-notebooks.token.forget"
                data-ui="item"
                type="button"
                className="btn"
                data-testid="git-forget-token"
                disabled={busy}
                onClick={() =>
                  void answer(
                    () => git.setToken(info.localId, null),
                    () => 'Forgot the token: git’s own credentials are used.',
                  )
                }
              >
                Forget Token
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * This notebook's own commit name and email (#170 F6), over git's: a GitHub no-reply address
 * when the account keeps its email private (GH007). Empty uses git's own again.
 */
function CommitIdentity({
  info,
  git,
  identity,
  answer,
  busy,
}: {
  info: GitNotebookInfo;
  git: DesktopGit;
  identity: { name: string; email: string } | null;
  answer: <T>(
    run: () => Promise<
      | { ok: true; value: T }
      | { ok: false; error: { message: string; hostMessage?: string } }
      | null
    >,
    done: (value: T) => string,
  ) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = useState(info.author?.name ?? '');
  const [email, setEmail] = useState(info.author?.email ?? '');
  const now = info.author ?? identity;
  return (
    <form
      className="git-notebook-form"
      data-testid="git-author"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        const author =
          name.trim() === '' && email.trim() === ''
            ? null
            : { name: name.trim() || (identity?.name ?? ''), email: email.trim() };
        void answer(
          () => git.update(info.localId, { author }),
          () =>
            author
              ? `Commits as ${author.name} <${author.email}> from the next one.`
              : 'Commits as git’s own configuration says from the next one.',
        );
      }}
    >
      <label className="settings-field">
        <span>Commit Name</span>
        <input
          className="input"
          autoComplete="off"
          value={name}
          placeholder={identity?.name ?? ''}
          data-testid="git-author-name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="settings-field">
        <span>Commit Email</span>
        <input
          type="email"
          className="input"
          autoComplete="off"
          value={email}
          placeholder={identity?.email ?? ''}
          data-testid="git-author-email"
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <div className="settings-actions">
        <button
          data-event="settings.git-notebooks.author.save"
          type="submit"
          className="btn"
          data-ui="submit"
          disabled={busy}
        >
          Save
        </button>
      </div>
      {now ? (
        <p className="muted" data-testid="git-author-now">
          Commits as {now.name} &lt;{now.email}&gt;
          {info.author ? ', this notebook’s own.' : ', from git’s own configuration.'}
        </p>
      ) : null}
    </form>
  );
}
