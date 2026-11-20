/**
 * Git notebooks' IPC (T50, A853–A857): main and note windows only; main checks every argument.
 * Listed to the capture window too, which files captures in the Journal notebook (A827).
 */
import type { IpcMainInvokeEvent } from 'electron';
import type { IpcHandlers } from '../ipc';
import { NEEDS_A_PERSON } from '../ipc-contract';
import { gitNotebooks, githubToken } from '../services';
import { recordSetting } from '../setting-events';

/** Add Notebook's account (A1617): a login, null for one GitHub never named, else none. */
function accountIn(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.length > 0 && value.length <= 100 ? value : undefined;
}

export function registerGitIpc(
  ipc: IpcHandlers,
  /** The call came from the main window's page (Settings' Add, T54). */
  fromMainWindow: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipc.handle('gitList', () => gitNotebooks.list());
  ipc.handle('gitAdd', async ({ event }, input) => {
    if (typeof input !== 'object' || input === null) return null;
    const fields = input as Record<string, unknown>;
    // A repository picked through Penmoss's sign-in gets its token (A1171): from the main
    // window's Add, and only for a github.com address over HTTPS.
    const signedIn =
      fields['githubSignIn'] === true &&
      fromMainWindow(event) &&
      typeof fields['remote'] === 'string' &&
      fields['remote'].startsWith('https://github.com/');
    return gitNotebooks.add({
      remote: fields['remote'],
      branch: fields['branch'],
      dir: fields['dir'],
      name: fields['name'],
      // The account picked in Add Notebook (A1617); the first when none was.
      token: signedIn ? await githubToken.token(accountIn(fields['githubAccount'])) : null,
    });
  });
  ipc.handle('gitRemove', (_call, localId, unpushed) => gitNotebooks.remove(localId, unpushed));
  ipc.handle('gitUpdate', async ({ gesture }, localId, patch) => {
    // Who commits is the person's to set (#174 review), and so is the notebook's name on every
    // device (Rename, Ryan's review of PR #192): after a click or a key press in the app.
    const personal =
      typeof patch === 'object' && patch !== null && ('author' in patch || 'name' in patch);
    if (personal && !gesture) return NEEDS_A_PERSON;
    const answer = await gitNotebooks.update(localId, patch);
    // Push After, Pull Every and Sign Commits, once written (PEN-175): only these three, as
    // the notebook now has them; a rename, a branch or an identity records nothing.
    if (answer.ok && typeof patch === 'object' && patch !== null) {
      const asked = patch as Record<string, unknown>;
      const view = answer.value;
      if (asked['pushDelayS'] !== undefined) recordSetting('git.pushAfter', view.pushDelayS);
      if (asked['pullEveryMin'] !== undefined) recordSetting('git.pullEvery', view.pullEveryMin);
      if (asked['sign'] !== undefined) recordSetting('git.signCommits', view.sign);
    }
    return answer;
  });
  ipc.handle('gitToken', (_call, localId, token) => gitNotebooks.setToken(localId, token));
  ipc.handle('gitPurgeCheck', (_call, localId, noteId) => gitNotebooks.purgeCheck(localId, noteId));
  ipc.handle('gitRestoreCheck', (_call, localId, noteId, revert) =>
    gitNotebooks.restoreCheck(localId, noteId, revert),
  );
  ipc.handle('gitPurgesToConfirm', (_call, localId, also) =>
    gitNotebooks.purgesToConfirm(localId, also ?? []),
  );
  ipc.handle('gitSecret', (_call, localId, value) => gitNotebooks.writerSecret(localId, value));
  ipc.handle('gitOp', (_call, localId, op, args) => gitNotebooks.op(localId, op, args));
  // Answered once main has stopped them, so the page counts a sync stopped only when it is.
  ipc.handle('gitCancel', (_call, localId) => {
    if (typeof localId === 'string') gitNotebooks.cancel(localId);
    return null;
  });
  ipc.handle('gitIdentity', () => gitNotebooks.identity());
}
