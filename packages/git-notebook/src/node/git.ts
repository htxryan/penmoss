/**
 * Running system git (T50 G2, A824): never through a shell, never prompting, with a timeout that
 * kills the whole process group, and with failures mapped to `GitTransportError` codes that keep
 * what the host said. Only Node APIs here: the CLI, the local MCP and the Mac app's main process
 * use it; browsers and Android never load `./node`.
 */
import { spawn } from 'node:child_process';
import { GitTransportError, type GitErrorCode } from '../transport';

export interface GitResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly input?: Buffer | string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Exit codes that are not failures (default: 0 only). */
  readonly ok?: readonly number[];
  readonly timeoutMs?: number;
  /** Stops the command (its whole process group) when aborted: a `timeout` error (A852). */
  readonly signal?: AbortSignal;
}

/** How long a local git command may take, and one that talks to the host. */
export const LOCAL_TIMEOUT_MS = 60_000;
export const NETWORK_TIMEOUT_MS = 180_000;

export interface GitRunner {
  (args: readonly string[], options?: RunOptions): Promise<GitResult>;
}

/**
 * git runs in its own process group (no terminal, so it can never prompt), which also means it
 * would outlive this process. Live groups are killed when this process exits. On a signal they
 * are killed only where the program asked for it (`killGitOnSignals`, the CLI): then the signal's
 * default (ending the process) still applies unless someone else handles it, as `penmoss mcp`
 * does to hand its push to a detached sync. A host with its own signal handling (Electron's main
 * process, G3) is left alone.
 */
const live = new Set<number>();
let watching = false;
let onSignals = false;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Kill live git process groups on SIGINT, SIGTERM and SIGHUP, then end as the signal would. */
export function killGitOnSignals(): void {
  onSignals = true;
  if (watching) for (const signal of SIGNALS) process.on(signal, onSignal);
}

/**
 * Told when a git process group starts and ends (A853): the Mac app keeps the live ones in a
 * file, so a run that crashed (no exit handler ran) has its leftovers killed at the next launch.
 */
export interface GitProcessListener {
  started(pid: number): void;
  ended(pid: number): void;
}
let processListener: GitProcessListener | null = null;

export function watchGitProcesses(listener: GitProcessListener | null): void {
  processListener = listener;
}

/** Kills every live git process group now (the Mac app's quit, A853). */
export function killLiveGit(): void {
  killLive();
}

function killLive(): void {
  for (const pid of live) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  live.clear();
}

function onSignal(signal: NodeJS.Signals): void {
  killLive();
  if (process.listenerCount(signal) === 1) {
    // Only this handler: end the process as the signal would have.
    process.off(signal, onSignal);
    process.kill(process.pid, signal);
  }
}

function watch(): void {
  if (watching) return;
  watching = true;
  process.on('exit', killLive);
  if (onSignals) for (const signal of SIGNALS) process.on(signal, onSignal);
}

function unwatch(): void {
  if (!watching || live.size > 0) return;
  watching = false;
  process.off('exit', killLive);
  for (const signal of SIGNALS) process.off(signal, onSignal);
}

/**
 * A runner for `git` (or `gitPath`). Every call gets `GIT_TERMINAL_PROMPT=0` and runs in a new
 * session (`detached`), so neither git nor ssh can open the terminal to ask for anything: a
 * missing credential is an `auth` error, never a hang.
 */
export function gitRunner(
  base: {
    readonly gitPath?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): GitRunner {
  const command = base.gitPath ?? 'git';
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries({ ...process.env, ...base.env, ...options.env })) {
        if (value !== undefined) env[key] = value;
      }
      // What git runs never sees a Penmoss API token (A171).
      delete env['PENMOSS_TOKEN'];
      env['GIT_TERMINAL_PROMPT'] = '0';
      env['LC_ALL'] = 'C';
      env['LANGUAGE'] = 'C';
      const child = spawn(command, ['--literal-pathspecs', ...args], {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      });
      const pid = child.pid;
      if (pid !== undefined) {
        live.add(pid);
        watch();
        processListener?.started(pid);
      }
      const done = () => {
        if (pid !== undefined) {
          live.delete(pid);
          processListener?.ended(pid);
        }
        unwatch();
        options.signal?.removeEventListener('abort', onAbort);
      };
      const out: Buffer[] = [];
      let err = '';
      let timedOut = false;
      let stopped = false;
      const kill = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const onAbort = () => {
        stopped = true;
        kill();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs ?? LOCAL_TIMEOUT_MS);
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        done();
        reject(
          error.code === 'ENOENT'
            ? new GitTransportError('git_missing', 'git is not installed (or not on PATH).')
            : error,
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done();
        if (timedOut || stopped) {
          reject(
            new GitTransportError(
              'timeout',
              stopped
                ? `git ${args[0]} was stopped: the sync ran out of time.`
                : `git ${args[0]} took too long and was stopped.`,
            ),
          );
          return;
        }
        const result = { code: code ?? 1, stdout: Buffer.concat(out), stderr: err };
        if ((options.ok ?? [0]).includes(result.code)) resolve(result);
        else reject(gitError(args, result));
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input ?? '');
    });
}

/** What the host said: the `remote:` lines of git's output, without the prefix. */
export function hostMessage(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('remote:'))
    .map((line) =>
      line
        .slice('remote:'.length)
        .replace(/\p{Cc}\[[0-9;?]*[ -/]*[@-~]/gu, '')
        .trim(),
    )
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const text = lines.join('\n');
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

/**
 * Where git says it went: a URL, an scp-style remote (`git@host:path`) or a quoted absolute
 * path. git prints the remote in every failed push (`To <remote>`, `failed to push some refs to
 * '<remote>'`), so a repository, account or folder whose name has `tls`, `ssl` or `GH006` in it
 * would read as that failure (PEN-117).
 */
const LOCATION = /[a-z][a-z0-9+.-]*:\/\/[^\s'"]*|[\w.-]+@[\w.-]+:[^\s'"]*|'\/[^'\n]*'/gi;

/** The code for a failed git call, from what git and the host printed, never from where. */
export function classify(output: string): GitErrorCode {
  const text = output.replace(LOCATION, ' ');
  if (/GH006|protected branch|Protected branch|branch is protected/i.test(text)) return 'protected';
  if (
    /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (ED25519|RSA|ECDSA)? ?host key is known/i.test(
      text,
    )
  ) {
    return 'host_key';
  }
  if (
    /gpg failed to sign the data|Couldn't load (public|private) key|Couldn't sign|error: (ssh-keygen|gpgsm?|x509) failed|failed to sign the data/i.test(
      text,
    )
  ) {
    return 'signing';
  }
  if (
    /GH013|GH009|rule violations|push protection|secret scanning|push declined due to/i.test(text)
  ) {
    return 'rules';
  }
  if (
    /Authentication failed|could not read (Username|Password)|passphrase|sign_and_send_pubkey|terminal prompts disabled|Permission denied \(publickey|HTTP Basic: Access denied|Invalid username or (password|token)|The requested URL returned error: 40[13]|Write access to repository not granted|Permission to .* denied|access denied|returned error: 403/i.test(
      text,
    )
  ) {
    return 'auth';
  }
  if (
    /Repository not found|does not appear to be a git repository|returned error: 404|not found|No such file or directory/i.test(
      text,
    )
  ) {
    return 'not_found';
  }
  if (
    /Could not resolve host|Failed to connect|Connection (timed out|refused|reset)|Operation timed out|Network is unreachable|unable to access|SSL|TLS|early EOF|the remote end hung up unexpectedly|Could not read from remote repository/i.test(
      text,
    )
  ) {
    return 'network';
  }
  if (/hook declined|pre-receive hook|\[remote rejected\]/i.test(text)) return 'refused';
  return 'git';
}

const MESSAGES: Record<GitErrorCode, string> = {
  auth: 'The git host refused the credentials, or none were found.',
  host_key:
    "SSH could not verify the host's key: it is not in known_hosts yet, or it changed. Connect once with ssh (for example ssh -T git@github.com) to check and accept it.",
  signing:
    "git's configuration signs commits (commit.gpgSign), and git could not sign this one: check that the signing key is there and unlocked (its agent running), or add the notebook with --no-sign to commit unsigned.",
  network: 'Could not reach the git host.',
  not_found: 'The repository was not found, or this account cannot see it.',
  protected: 'The branch is protected: the host refused the push.',
  rules: "The host's repository rules refused the push.",
  refused: 'The host refused the push.',
  git_missing: 'git is not installed.',
  timeout: 'git took too long and was stopped.',
  redirected: "git's configuration sends this notebook's git to another repository.",
  git: 'git failed.',
};

export function gitError(args: readonly string[], result: GitResult): GitTransportError {
  const output = `${result.stderr}\n${result.stdout.toString('utf8')}`;
  const code = classify(output);
  const host = hostMessage(output);
  const detail =
    code === 'git'
      ? ` (git ${args[0]} exited ${result.code}: ${firstLine(result.stderr) || 'no message'})`
      : '';
  // SSH keys: the key was refused, or it needs a passphrase nobody can type here.
  const message =
    code === 'auth' && SSH_KEY.test(output)
      ? 'SSH refused the key, or the key needs its passphrase, which penmoss cannot ask for: add the key to ssh-agent (ssh-add) and try again.'
      : `${MESSAGES[code]}${detail}`;
  return new GitTransportError(code, redact(message), host && redact(host));
}

const SSH_KEY =
  /Permission denied \(publickey|passphrase|sign_and_send_pubkey|agent refused|no mutual signature/i;

/** A URL's credentials (`https://user:secret@host`) never reach a message or a log. */
export function redact(text: string): string {
  return text.replace(/\b(https?:\/\/)[^\s/@:]*(:[^\s/@]*)?@/gi, '$1***@');
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((each) => each.trim())
    .find((each) => each && !each.startsWith('remote:'));
  return line ? (line.length > 300 ? `${line.slice(0, 300)}…` : line) : '';
}

/**
 * On a Mac, `/usr/bin/git` is a shim that opens an installer dialog when the command-line tools
 * are missing (A824): ask `xcode-select -p` first, so a missing git is an error, not a dialog.
 */
export async function preflight(
  platform: NodeJS.Platform = process.platform,
  gitPath = 'git',
): Promise<void> {
  if (platform !== 'darwin') return;
  if (gitPath !== 'git' && gitPath !== '/usr/bin/git') return;
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn('xcode-select', ['-p'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  if (!ok) {
    throw new GitTransportError(
      'git_missing',
      "git needs the Mac's command-line tools. Install them with: xcode-select --install",
    );
  }
}
