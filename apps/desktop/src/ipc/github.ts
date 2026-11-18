/**
 * GitHub's IPC: browsing it in Add a Git Notebook (T81, A1165), Sign in with GitHub (T82,
 * A1170) and the person's own token (T57, A1012), which is never sent back to a page. The main
 * window only, but for the token's status.
 */
import type { IpcHandlers } from '../ipc';
import { githubBrowse, githubSignIn, githubToken } from '../services';

export function registerGitHubIpc(ipc: IpcHandlers): void {
  // `account` picks one of Penmoss's accounts (A1617); without it, git's sign-in, else the first.
  ipc.handle('gitGithubRepos', (_call, account) => githubBrowse.repos(account));
  ipc.handle('gitGithubFolders', (_call, fullName, branch, account) =>
    githubBrowse.folders(fullName, branch, account),
  );
  ipc.handle('gitGithubOwners', (_call, account) => githubBrowse.owners(account));
  ipc.handle('gitGithubCreate', (_call, owner, name, account) =>
    githubBrowse.create(owner, name, account),
  );
  ipc.handle('gitGithubGitLogin', () => githubBrowse.gitLogin());
  // Starting a sign-in is the person's, after a click.
  ipc.handle('githubSignInStatus', async () => ({
    available: githubSignIn.available,
    state: githubSignIn.state(),
    login: (await githubToken.status()).login,
  }));
  ipc.handle('githubSignInStart', () => githubSignIn.start());
  ipc.handle('githubSignInCancel', () => {
    githubSignIn.cancel();
    return null;
  });
  // What the token is is never sent back; saving and removing it are the person's, after a
  // click or key press in Settings.
  ipc.handle('githubTokenStatus', () => githubToken.status());
  ipc.handle('githubTokenSave', (_call, token) => githubToken.save(token));
  ipc.handle('githubTokenRemove', async (_call, login) => ({
    ok: true,
    status: await githubToken.remove(
      typeof login === 'string' || login === null ? login : undefined,
    ),
  }));
  ipc.handle('githubTokenMakePrimary', async (_call, login) => ({
    ok: true,
    status: await githubToken.makePrimary(login),
  }));
}
