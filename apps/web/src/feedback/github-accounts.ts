/** The GitHub accounts this Mac keeps (A1617), as Settings → GitHub and Add Notebook read them. */
import type { DesktopGitHubAccount, DesktopGitHubTokenStatus } from '../desktop/bridge';

/** The accounts a status lists (A1617); a Mac from before lists the one it keeps. */
export function accountsOf(status: DesktopGitHubTokenStatus): readonly DesktopGitHubAccount[] {
  if (status.accounts) return status.accounts;
  return status.saved
    ? [{ login: status.login, primary: true, signedIn: status.signedIn, problem: status.problem }]
    : [];
}
