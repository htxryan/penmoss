/**
 * Every git command the factory runs on the host goes through here (A-NEW-1). Its environment
 * has nothing of Ryan's (no ~/.gitconfig, no system config, no prompts), and its flags turn off
 * what a repository's own config could make git run: hooks, an fsmonitor, a credential helper
 * (the app's token comes back only where a command needs it), the file transport when a
 * submodule asks for it, and submodule recursion.
 *
 * It never runs in the runs' clone (`<stateDir>/repo`) or a sandbox's worktree: Sandcastle
 * mounts that clone's `.git` into every sandbox, and an agent can redirect its config there
 * (a top-level `commondir`). What the host reads of a run, and every push, happens in the publish
 * repo (publish.ts), which no sandbox mounts. Sandcastle's own worktree commands are its own.
 */
import type { Exec, ExecResult } from './exec.ts';

export const GIT_HARDENING = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'credential.helper=',
  '-c',
  'protocol.file.allow=user',
  '-c',
  'submodule.recurse=false',
] as const;

/** git's credentials from `GH_TOKEN` in its environment (the app's token), nothing stored. */
export const TOKEN_HELPER: readonly string[] = [
  '-c',
  'credential.helper=',
  '-c',
  'credential.helper=!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f',
];

/** The environment of every host git command: PATH and HOME, and no config but the repo's. */
export function gitEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '',
    LC_ALL: 'C',
    ...extra,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export interface GitOptions {
  /** The app's token, for a command that talks to GitHub with it (a push, its ls-remote). */
  readonly token?: string;
  /** More environment, such as a committer identity in a test. */
  readonly env?: Readonly<Record<string, string>>;
}

/** The arguments for `git <args>` in `dir`, hardened. */
export function gitArgs(dir: string, args: readonly string[], token = false): string[] {
  return ['-C', dir, ...GIT_HARDENING, ...(token ? TOKEN_HELPER : []), ...args];
}

/** Runs `git <args>` in `dir` (a repository the host owns, or a plain folder for `clone`). */
export function hostGit(
  exec: Exec,
  dir: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<ExecResult> {
  const token = options.token !== undefined;
  return exec('git', gitArgs(dir, args, token), {
    env: gitEnv({ ...options.env, ...(token ? { GH_TOKEN: options.token ?? '' } : {}) }),
  });
}

/** The subcommand of a git command line: past `-C <dir>` and every `-c <setting>`. */
export function subcommand(args: readonly string[]): string | undefined {
  return args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-C' && args[i - 1] !== '-c');
}

/** As `hostGit`, its stdout, throwing with the lines that say why when it fails. */
export async function mustGit(
  exec: Exec,
  dir: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  const result = await hostGit(exec, dir, args, options);
  if (result.code !== 0) {
    // The lines that say why (a push's `! [rejected] … (stale info)` comes before its last line).
    const why = result.stderr.trim().split('\n').slice(-3).join(' / ');
    throw new Error(`git ${subcommand(args) ?? args[0] ?? ''} failed: ${why}`);
  }
  return result.stdout;
}
