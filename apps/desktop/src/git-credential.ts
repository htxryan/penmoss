/**
 * The GitHub credential git on this Mac already has (T81, A1163): `git credential fill` for
 * `https://github.com`, never prompting, with a time limit. Used only to browse repositories in
 * Add a Git Notebook: the token stays in the main process for one call and is never kept,
 * logged or shown. Never runs `approve` or `reject`, so git's helpers are left as they were.
 */
import { boundedExec } from './bounded-exec';

export type CredentialAnswer =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: 'no_credential' | 'timeout' };

interface GitCredentialOptions {
  /** Extra environment for git (the suite's `GIT_CONFIG_GLOBAL`, config.gitEnv). */
  readonly gitEnv?: Readonly<Record<string, string>> | null;
  readonly timeoutMs?: number;
  /** The git to run (default `git`). */
  readonly git?: string;
}

/** Asks git for its github.com credential; the password is the token GitHub's API takes. */
export async function gitHubCredential(
  options: GitCredentialOptions = {},
): Promise<CredentialAnswer> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, options.gitEnv ?? {}, {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    // Empty, not unset: an unset one falls through to core.askPass and SSH_ASKPASS.
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  });
  delete env['GIT_DIR'];
  // The credential helper is git's child: out of time, the whole group goes.
  const ran = await boundedExec({
    command: options.git ?? 'git',
    args: ['-c', 'credential.interactive=false', 'credential', 'fill'],
    env,
    input: 'protocol=https\nhost=github.com\n\n',
    timeoutMs: options.timeoutMs ?? 15_000,
    onStderr: () => undefined,
  });
  if (ran.kind === 'timeout') return { ok: false, reason: 'timeout' };
  if (ran.kind === 'error' || ran.code !== 0) return { ok: false, reason: 'no_credential' };
  const password = ran.stdout
    .split('\n')
    .find((line) => line.startsWith('password='))
    ?.slice('password='.length)
    .trim();
  return password ? { ok: true, token: password } : { ok: false, reason: 'no_credential' };
}
