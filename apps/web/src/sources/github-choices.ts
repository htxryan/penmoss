/**
 * The GitHub accounts Add Notebook can read repositories as (A1617): git's own sign-in when it is
 * someone else's, then Penmoss's, the first first. Pick GitHub Account offers them, and so does
 * the account switcher above Pick Repository and Create New Repo.
 */
import { desktop, type DesktopGitHubBrowse, type GitHubAccountChoice } from '../desktop/bridge';
import { accountsOf } from '../feedback/github-accounts';

/** One account to pick: `account` undefined is git's own sign-in. */
export interface AccountChoice {
  readonly key: string;
  readonly account: GitHubAccountChoice | undefined;
  /** The login, null for git's or a token GitHub never named. */
  readonly login: string | null;
  readonly title: string;
  readonly line: string;
}

/** Every account to pick from; none when Penmoss has no sign-in of its own. */
export async function accountChoices(
  github: DesktopGitHubBrowse,
): Promise<readonly AccountChoice[]> {
  const status = await desktop()
    ?.githubToken?.status()
    .catch(() => null);
  const accounts = status ? accountsOf(status) : [];
  if (accounts.length === 0) return [];
  const gitLogin = (await github.gitLogin?.().catch(() => null)) ?? null;
  const viaGit: AccountChoice[] =
    gitLogin && !accounts.some((each) => each.login === gitLogin)
      ? [
          {
            key: 'git',
            account: undefined,
            login: gitLogin,
            title: `@${gitLogin}`,
            line: 'This Mac’s git sign-in',
          },
        ]
      : [];
  return [
    ...viaGit,
    ...accounts.map((each) => ({
      key: `account:${each.login ?? ''}`,
      account: each.login,
      login: each.login,
      title: each.login ? `@${each.login}` : 'Token (Account Not Named)',
      line: each.primary ? 'Your first account; Send Feedback uses it' : 'Signed in on this Mac',
    })),
  ];
}
