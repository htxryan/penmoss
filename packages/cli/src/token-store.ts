/**
 * Where git notebooks keep their tokens and writer secrets (A160, T50), one per key:
 *
 * - **The OS keychain** where there is one: the macOS keychain through
 *   `security`, or the Secret Service keyring through libsecret's
 *   `secret-tool` on Linux. The token goes to them on stdin (`security -i`
 *   reads its command from stdin), never on a command line other users could
 *   see in the process list.
 * - **A file** otherwise (headless machines, such as the agent worker, where
 *   `secret-tool` is missing or has no D-Bus session to talk to): the store's
 *   own (`~/.penmoss/credentials.json` for git notebooks), created 0600 in a
 *   0700 directory and written atomically. It is refused on read when other
 *   users can read it or it is not a plain file of this user's.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { CliError, EXIT } from './errors';
import type { TokenLocation, TokenStore } from './io';

/**
 * How long a keychain tool may take (A169): a lookup or removal 2 s, so a
 * helper that never answers (no D-Bus session, a locked keyring waiting on
 * a dialog) delays a command by at most that; saving, which may wait on an
 * unlock prompt at login, 10 s.
 */
export const LOOKUP_TIMEOUT_MS = 2_000;
export const SAVE_TIMEOUT_MS = 10_000;
/** After a tool exits, how long its output may still take: a grandchild may hold the pipe. */
const DRAIN_MS = 100;

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** It ran out of time and its process group was killed. */
  readonly timedOut?: boolean;
}

export type Exec = (
  command: string,
  args: readonly string[],
  input: string | null,
  timeoutMs: number,
) => Promise<ExecResult>;

export interface NodeTokenStoreOptions {
  readonly platform: NodeJS.Platform;
  /** PATH (where the keychain tools are looked for), and the tools' environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This user's uid, to check the config file's owner (undefined on Windows). */
  readonly uid?: number;
  readonly exec?: Exec;
  /** The store's keychain service (`penmoss-git` for git notebooks). */
  readonly service: string;
  /** Its file, where there is no keychain (`~/.penmoss/credentials.json`). */
  readonly file: string;
  /** The shape its secrets have: anything else is refused before it is saved. */
  readonly accepts: (secret: string) => boolean;
}

interface Keychain {
  readonly name: string;
  get(api: string): Promise<string | null>;
  /** Saves and reads back; throws with the tool's message when it cannot. */
  set(api: string, token: string): Promise<void>;
  delete(api: string): Promise<boolean>;
}

export function nodeTokenStore(options: NodeTokenStoreOptions): TokenStore {
  const run = options.exec ?? spawnExec(options.env);
  // A tool that ran out of time once is not asked again by this process (A169).
  let unresponsive = false;
  const exec: Exec = async (command, args, input, timeoutMs) => {
    if (unresponsive) {
      return { code: 124, stdout: '', stderr: 'did not answer earlier', timedOut: true };
    }
    const result = await run(command, args, input, timeoutMs);
    if (result.timedOut) unresponsive = true;
    return result;
  };
  const keychain = findKeychain(options, exec);
  const file = configFile(options);
  const accepts = options.accepts;

  return {
    describe: () => ({ keychain: keychain?.name ?? null, file: file.path }),

    // The file first (A169): a token is kept in one place, so one found there needs no
    // keychain tool at all. An unsafe file is reported only when the keychain has none.
    async get(api) {
      let fromFile: string | undefined;
      let unsafe: Error | null = null;
      try {
        fromFile = (await file.read()).tokens[api];
      } catch (error) {
        unsafe = error as Error;
      }
      if (fromFile) return { token: fromFile, location: 'file' };
      const stored = keychain ? await keychain.get(api).catch(() => null) : null;
      if (stored) return { token: stored, location: 'keychain' };
      if (unsafe) throw unsafe;
      return null;
    },

    async set(api, token, where) {
      if (!accepts(token)) {
        throw new CliError(EXIT.USAGE, 'That does not look like a token.');
      }
      let note: string | undefined;
      if (where !== 'file') {
        if (!keychain) {
          if (where === 'keychain') {
            throw new CliError(
              EXIT.AUTH,
              'No keychain here (macOS security or libsecret secret-tool).',
            );
          }
        } else {
          try {
            await keychain.set(api, token);
            // A copy left in the file would outlive a later removal from the keychain.
            await file.remove(api).catch(() => false);
            return { location: 'keychain' };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (where === 'keychain') {
              throw new CliError(EXIT.AUTH, `Could not save to ${keychain.name}: ${reason}`);
            }
            note = `${keychain.name} is not reachable (${reason}), so the token went to ${file.path}.`;
          }
        }
      }
      await file.write(api, token);
      if (keychain) await keychain.delete(api).catch(() => false);
      return note ? { location: 'file', note } : { location: 'file' };
    },

    async delete(api) {
      const removed: TokenLocation[] = [];
      if (keychain && (await keychain.delete(api).catch(() => false))) removed.push('keychain');
      if (await file.remove(api)) removed.push('file');
      return removed;
    },
  };
}

// --- keychains ---

function findKeychain(options: NodeTokenStoreOptions, exec: Exec): Keychain | null {
  const service = options.service;
  if (options.platform === 'darwin' && onPath('security', options.env)) {
    return macKeychain(exec, service);
  }
  if (options.platform === 'linux' && onPath('secret-tool', options.env)) {
    return libsecret(exec, service);
  }
  return null;
}

/** The macOS login keychain: a generic password, service `penmoss`, account the API origin. */
function macKeychain(exec: Exec, SERVICE: string): Keychain {
  const keychain: Keychain = {
    name: 'the macOS keychain',
    async get(api) {
      const found = await exec(
        'security',
        ['find-generic-password', '-s', SERVICE, '-a', api, '-w'],
        null,
        LOOKUP_TIMEOUT_MS,
      );
      return found.code === 0 && found.stdout.trim() ? found.stdout.trim() : null;
    },
    async set(api, token) {
      // `security -i` reads commands from stdin, so the token is never in argv. Both values
      // are checked to need no quoting: the origin is a URL origin, the token base64url.
      const command = `add-generic-password -U -s ${SERVICE} -a "${api}" -l "Penmoss CLI" -w "${token}"\n`;
      const saved = await exec('security', ['-i'], command, SAVE_TIMEOUT_MS);
      if (saved.code !== 0) throw new Error(toolMessage(saved, 'security', token));
      if ((await keychain.get(api)) !== token) throw new Error('the keychain did not keep it');
    },
    async delete(api) {
      return (
        (
          await exec(
            'security',
            ['delete-generic-password', '-s', SERVICE, '-a', api],
            null,
            LOOKUP_TIMEOUT_MS,
          )
        ).code === 0
      );
    },
  };
  return keychain;
}

/** The Secret Service (GNOME Keyring, KWallet) through libsecret's secret-tool. */
function libsecret(exec: Exec, SERVICE: string): Keychain {
  const attributes = (api: string) => ['service', SERVICE, 'account', api];
  const keychain: Keychain = {
    name: 'the Secret Service keyring',
    async get(api) {
      const found = await exec(
        'secret-tool',
        ['lookup', ...attributes(api)],
        null,
        LOOKUP_TIMEOUT_MS,
      );
      return found.code === 0 && found.stdout.trim() ? found.stdout.trim() : null;
    },
    async set(api, token) {
      // secret-tool reads the secret from stdin.
      const label = `--label=Penmoss CLI (${api})`;
      const saved = await exec(
        'secret-tool',
        ['store', label, ...attributes(api)],
        token,
        SAVE_TIMEOUT_MS,
      );
      if (saved.code !== 0) throw new Error(toolMessage(saved, 'secret-tool', token));
      if ((await keychain.get(api)) !== token) throw new Error('the keyring did not keep it');
    },
    async delete(api) {
      const had = (await keychain.get(api)) !== null;
      await exec('secret-tool', ['clear', ...attributes(api)], null, LOOKUP_TIMEOUT_MS);
      return had;
    },
  };
  return keychain;
}

function onPath(command: string, env: NodeTokenStoreOptions['env']): boolean {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      // Synchronous on purpose: checked once, when the store is made.
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Not here.
    }
  }
  return false;
}

/**
 * A keychain tool's failure, safe to print (A171): its first line of stderr,
 * without control characters or anything shaped like a token, and short.
 */
export function toolMessage(result: ExecResult, tool: string, token?: string): string {
  if (result.timedOut) return `${tool} did not answer in time`;
  let text = result.stderr;
  if (token) text = text.split(token).join('[token]');
  const line =
    text
      .split(/\r?\n/)
      .map((each) =>
        each
          .replace(/\p{Cc}\[[0-9;?]*[ -/]*[@-~]/gu, '')
          .replace(/\p{Cc}/gu, '')
          .trim(),
      )
      .find(Boolean) ?? '';
  const clean = line.replace(/\bpm[a-z]_[A-Za-z0-9_-]+/g, '[token]');
  if (!clean) return `${tool} exited ${result.code}`;
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

/** The environment for a program the CLI starts: never the token (A171). */
export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const copy = { ...env };
  delete copy['PENMOSS_GIT_TOKEN'];
  return copy;
}

/**
 * Runs a tool with `input` on stdin, never through a shell (A169). It runs
 * in its own process group, and the reply is what it wrote by the time it
 * exited (plus DRAIN_MS), so a grandchild that keeps the pipe open (a
 * wrapper script, D-Bus autolaunch) cannot hold the command. Out of time,
 * the whole group is killed.
 */
function spawnExec(env: NodeTokenStoreOptions['env']): Exec {
  const environment = childEnv(env);
  return (command, args, input, timeoutMs) =>
    new Promise((resolve) => {
      const child = spawn(command, args, {
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      let stdout = '';
      let stderr = '';
      let done = false;
      let drain: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: ExecResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(drain);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
        finish({ code: 124, stdout, stderr, timedOut: true });
      }, timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', (error) => finish({ code: 127, stdout, stderr: error.message }));
      child.on('exit', (code) => {
        const result = () => ({ code: code ?? 1, stdout, stderr });
        child.on('close', () => finish(result()));
        drain = setTimeout(() => finish(result()), DRAIN_MS);
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input ?? '');
    });
}

// --- the config file ---

interface ConfigData {
  tokens: Record<string, string>;
  [key: string]: unknown;
}

function configFile(options: NodeTokenStoreOptions) {
  const path = options.file;
  const checkModes = options.platform !== 'win32';

  /**
   * Opened without following a symlink and checked through the open handle
   * (A171), so nothing can be swapped in between the check and the read.
   * Non-blocking, so a FIFO put there cannot hang the command.
   */
  async function read(): Promise<ConfigData> {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    let handle;
    try {
      handle = await open(path, flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { tokens: {} };
      if (code === 'ELOOP' || code === 'EMLINK' || code === 'ENXIO') throw notRegular();
      throw error;
    }
    let text: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw notRegular();
      if (checkModes && (stat.mode & 0o077) !== 0) {
        const mode = (stat.mode & 0o777).toString(8);
        throw new CliError(
          EXIT.AUTH,
          `${path} is readable by other users (mode ${mode}), so its token is not used. ` +
            `Fix it with: chmod 600 ${path}`,
        );
      }
      if (checkModes && options.uid !== undefined && stat.uid !== options.uid) {
        throw new CliError(EXIT.AUTH, `${path} belongs to another user, so its token is not used.`);
      }
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    try {
      const data = JSON.parse(text) as Partial<ConfigData>;
      const tokens = typeof data.tokens === 'object' && data.tokens !== null ? data.tokens : {};
      return { ...data, tokens: { ...tokens } };
    } catch {
      throw new CliError(
        EXIT.AUTH,
        `${path} is not valid JSON; remove it and save the token again.`,
      );
    }
  }

  const notRegular = () =>
    new CliError(EXIT.AUTH, `${path} is not a regular file; remove it and save the token again.`);

  /** Writes a sibling file created 0600, then renames it over the config: never a moment at a wider mode. */
  async function save(data: ConfigData): Promise<void> {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Never through a symlink (A171): that would change the mode of wherever it points.
    if (checkModes && !(await lstat(dir)).isSymbolicLink()) await chmod(dir, 0o700);
    const temporary = `${path}.${process.pid}.tmp`;
    await rm(temporary, { force: true });
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
      if (checkModes) await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  return {
    path,
    read,
    async write(api: string, token: string) {
      const data = await read();
      data.tokens[api] = token;
      await save(data);
    },
    async remove(api: string): Promise<boolean> {
      const data = await read();
      if (!(api in data.tokens)) return false;
      delete data.tokens[api];
      await save(data);
      return true;
    },
  };
}
