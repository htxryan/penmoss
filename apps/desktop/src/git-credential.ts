/**
 * The GitHub credential git on this Mac already has (T81, A1163): `git credential fill` for
 * `https://github.com`, never prompting, with a time limit. Used only to browse repositories in
 * Add a Git Notebook: the token stays in the main process for one call and is never kept,
 * logged or shown. Never runs `approve` or `reject`, so git's helpers are left as they were.
 */
import { spawn } from 'node:child_process';

export type CredentialAnswer =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: 'no_credential' | 'timeout' };

export interface GitCredentialOptions {
  /** Extra environment for git (the suite's `GIT_CONFIG_GLOBAL`, config.gitEnv). */
  readonly gitEnv?: Readonly<Record<string, string>> | null;
  readonly timeoutMs?: number;
  /** The git to run (default `git`). */
  readonly git?: string;
}

/** Asks git for its github.com credential; the password is the token GitHub's API takes. */
export function gitHubCredential(options: GitCredentialOptions = {}): Promise<CredentialAnswer> {
  return new Promise((resolve) => {
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
    let child;
    try {
      child = spawn(
        options.git ?? 'git',
        ['-c', 'credential.interactive=false', 'credential', 'fill'],
        { env, stdio: ['pipe', 'pipe', 'ignore'] },
      );
    } catch {
      resolve({ ok: false, reason: 'no_credential' });
      return;
    }
    let out = '';
    let settled = false;
    const done = (answer: CredentialAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, reason: 'timeout' });
    }, options.timeoutMs ?? 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => done({ ok: false, reason: 'no_credential' }));
    child.on('close', (code) => {
      if (code !== 0) {
        done({ ok: false, reason: 'no_credential' });
        return;
      }
      const password = out
        .split('\n')
        .find((line) => line.startsWith('password='))
        ?.slice('password='.length)
        .trim();
      done(password ? { ok: true, token: password } : { ok: false, reason: 'no_credential' });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end('protocol=https\nhost=github.com\n\n');
  });
}
