/**
 * Git notebooks' Settings actions as commands (#170 F5): the palette and the Mac's File menu
 * (area Sync). Each acts on the git notebook of the note in front, or on the only git notebook,
 * and keeps the guard it has in Settings: Remove, a token, the cadence, the commit identity and
 * Confirm Delete for good again take you to that notebook's control in Settings, where the
 * person finishes them (Remove still says what would be lost first). Sync now, Sign commits and
 * Forget token act at once, as their Settings controls do.
 */
import { useCommand } from '../commands/hooks';
import { desktop } from '../desktop/bridge';
import { gitNotebookPath, navigate } from '../router';
import type { GitSource } from './git-source';
import { useSourcesRegistry, useSourcesState } from './hooks';

/** The command ids, in the order the palette and the menu list them. */
export const GIT_COMMANDS = {
  syncNow: 'git.syncNow',
  signCommits: 'git.signCommits',
  pushAfter: 'git.pushAfter',
  pullEvery: 'git.pullEvery',
  useToken: 'git.useToken',
  forgetToken: 'git.forgetToken',
  identity: 'git.identity',
  reconfirmPurges: 'git.reconfirmPurges',
  remove: 'git.remove',
} as const;

/** A Settings control a command takes the person to (its `data-testid`). */
export type GitControl =
  | 'git-push-delay'
  | 'git-pull-interval'
  | 'git-token'
  | 'git-author-email'
  | 'git-reconfirm-purges'
  | 'git-remove';

type Request = { readonly notebookId: string; readonly control: GitControl };
let request: Request | null = null;
const listeners = new Set<() => void>();

/** Asks Settings → Git Notebooks to show and focus `control` in that notebook's card. */
export function requestGitControl(notebookId: string, control: GitControl): void {
  request = { notebookId, control };
  for (const listener of listeners) listener();
}

/** The card's side: takes the request meant for its notebook, once. */
export function takeGitControl(notebookId: string): GitControl | null {
  if (request?.notebookId !== notebookId) return null;
  const { control } = request;
  request = null;
  return control;
}

export function onGitControl(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Which git notebook a command acts on: the open note's, when it is in one; otherwise the only
 * git notebook on this Mac; otherwise none (the command is greyed out, and Settings chooses).
 */
export function gitTarget(
  sources: readonly { readonly kind: string }[],
  noteSource: { readonly kind: string } | null,
): GitSource | null {
  if (noteSource?.kind === 'git') return noteSource as GitSource;
  const git = sources.filter((source) => source.kind === 'git');
  return git.length === 1 ? (git[0] as GitSource) : null;
}

/** Registers the git notebook commands (in the command overlays, beside the app's own). */
export function useGitNotebookCommands(
  currentNoteId: string | null,
  report: (text: string, ok: boolean) => void,
): void {
  const registry = useSourcesRegistry();
  const state = useSourcesState();
  const git = desktop()?.git ?? null;
  const target = (): GitSource | null => {
    if (!git || !state) return null;
    const noteSource = currentNoteId ? (registry?.sourceOfNote(currentNoteId) ?? null) : null;
    return gitTarget(state.all, noteSource);
  };
  const toControl = (control: GitControl) => {
    const source = target();
    if (!source) return;
    navigate(gitNotebookPath(source.id));
    requestGitControl(source.id, control);
  };
  const answered = (
    result: { ok: true } | { ok: false; error: { message: string } } | null,
    done: string,
  ) => {
    if (!result) report('This window cannot change git notebooks.', false);
    else if (result.ok) report(done, true);
    else report(result.error.message, false);
    void registry?.refresh();
  };

  useCommand(
    GIT_COMMANDS.syncNow,
    () => {
      const source = target();
      if (!source) return;
      source.syncNow();
      report(`Syncing “${source.info.name}” now.`, true);
    },
    () => target() !== null,
  );
  useCommand(
    GIT_COMMANDS.signCommits,
    () => {
      const source = target();
      if (!source || !git) return;
      const sign = !source.info.sign;
      void git
        .update(source.info.localId, { sign })
        .then((result) =>
          answered(
            result,
            sign
              ? `“${source.info.name}” signs commits as git’s configuration says.`
              : `“${source.info.name}” never signs its commits.`,
          ),
        );
    },
    () => target() !== null,
  );
  useCommand(
    GIT_COMMANDS.pushAfter,
    () => toControl('git-push-delay'),
    () => target() !== null,
  );
  useCommand(
    GIT_COMMANDS.pullEvery,
    () => toControl('git-pull-interval'),
    () => target() !== null,
  );
  useCommand(
    GIT_COMMANDS.useToken,
    () => toControl('git-token'),
    () => target() !== null,
  );
  useCommand(
    GIT_COMMANDS.forgetToken,
    () => {
      const source = target();
      if (!source || !git) return;
      void git
        .setToken(source.info.localId, null)
        .then((result) =>
          answered(result, `Forgot “${source.info.name}”’s token: git’s own credentials are used.`),
        );
    },
    () => target()?.info.hasToken === true,
  );
  useCommand(
    GIT_COMMANDS.identity,
    () => toControl('git-author-email'),
    () => target() !== null,
  );
  useCommand(
    GIT_COMMANDS.reconfirmPurges,
    () => toControl('git-reconfirm-purges'),
    () => target()?.feed.status.code === 'purge_unconfirmed',
  );
  useCommand(
    GIT_COMMANDS.remove,
    () => toControl('git-remove'),
    () => target() !== null,
  );
}
