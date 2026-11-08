/** The CLI's `Io` in Node: process streams, the opener and git notebooks. */
import { spawn } from 'node:child_process';
import { closeSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { Io, MeaningIo, StdioIo } from './io';
import { nodeNotebooks } from './node-notebooks';
import { childEnv } from './token-store';
import { join } from 'node:path';

/**
 * `self`: the arguments that run this CLI again after `process.execPath`, for a sync detached to
 * outlive it. Default: this script (`node penmoss.js`). The Mac app runs the CLI in its own
 * binary (A992) and passes `['--penmoss-cli']`.
 */
export function nodeIo(
  options: {
    readonly self?: readonly string[];
    /** Search by meaning (T75): the Mac app's binary gives it. */
    readonly meaning?: MeaningIo;
  } = {},
): Io {
  selfCommand = options.self ?? null;
  const env = process.env;
  return {
    env,
    stdin: { isTTY: process.stdin.isTTY === true, read: readStdin },
    stdout: {
      isTTY: process.stdout.isTTY === true,
      write: (text) => void process.stdout.write(text),
    },
    stderr: { write: (text) => void process.stderr.write(text) },
    openUrl,
    readFile: async (path) => new Uint8Array(await readFile(path)),
    fileSize: async (path) => (await stat(path)).size,
    stdio: nodeStdio(),
    ...(options.meaning ? { meaning: options.meaning } : {}),
    notebooks: nodeNotebooks({
      ...(options.meaning ? { meaning: options.meaning } : {}),
      terminal: terminalAvailable,
      home: env['PENMOSS_HOME'] || join(homedir(), '.penmoss'),
      env,
      platform: process.platform,
      ...(process.getuid ? { uid: process.getuid() } : {}),
    }),
  };
}

/** Whether this process has a controlling terminal a person can type at (never stdin). */
function terminalAvailable(): boolean {
  if (process.platform === 'win32') return false;
  try {
    closeSync(openSync('/dev/tty', 'r+'));
    return true;
  } catch {
    return false;
  }
}

/** `penmoss mcp`'s stdio (stdin by line), signals, and syncs left to the background. */
function nodeStdio(): StdioIo {
  return {
    lines: () =>
      bufferedLines(
        createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false }),
      ),
    stopped,
    detach,
  };
}

/**
 * Stdin's lines from the moment it is opened. readline starts reading at once, and a line it
 * reads before anyone iterates is otherwise lost: a client that writes its first requests straight
 * away (a pipe) would get no reply (#165).
 */
export function bufferedLines(source: {
  on(event: 'line', listener: (line: string) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  close(): void;
}): AsyncIterable<string> {
  const queued: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  source.on('line', (line) => {
    queued.push(line);
    wake?.();
  });
  source.on('close', () => {
    closed = true;
    wake?.();
  });
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          if (queued.length > 0) {
            yield queued.shift()!;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
      } finally {
        source.close();
      }
    },
  };
}

/**
 * The first SIGINT, SIGTERM or SIGHUP (T50 G2). From then on, stdin is let go and the process
 * ends once the server has (or 10 s on, whatever it is doing), as the signal would have.
 */
function stopped(): Promise<string> {
  return new Promise((resolve) => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const on = (signal: NodeJS.Signals) => {
      for (const each of signals) process.off(each, on);
      for (const each of signals) process.on(each, () => undefined);
      process.stdin.destroy();
      setTimeout(
        () => process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGHUP' ? 1 : 15)),
        10_000,
      ).unref();
      resolve(signal);
    };
    for (const each of signals) process.on(each, on);
  });
}

/** A detached sync's log beyond this is moved to `<log>.1`, so it never grows without end. */
const DETACHED_LOG_MAX = 256 * 1024;

/**
 * `penmoss <args>` in its own process group, with no terminal, outliving this one; its output is
 * appended to `log`, so a sync that failed after its parent was gone can still be read about.
 */
/** How to run this CLI again after `process.execPath` (nodeIo's `self`); null: this script. */
let selfCommand: readonly string[] | null = null;

function detach(args: readonly string[], log?: string): boolean {
  const script = process.argv[1];
  const self = selfCommand ?? (script ? [...process.execArgv, script] : null);
  if (!self) return false;
  let fd: number | null = null;
  try {
    if (log) {
      try {
        if (statSync(log).size > DETACHED_LOG_MAX) renameSync(log, `${log}.1`);
      } catch {
        // No log yet.
      }
      fd = openSync(log, 'a', 0o600);
      writeSync(fd, `--- ${new Date().toISOString()} penmoss ${args.join(' ')}\n`);
    }
    const child = spawn(process.execPath, [...self, ...args], {
      stdio: fd === null ? 'ignore' : ['ignore', fd, fd],
      detached: true,
      env: process.env,
    });
    child.on('error', () => undefined);
    child.unref();
    return child.pid !== undefined;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk as string;
  return text;
}

/** Opens a URL with the platform's opener; false when there is none. */
function openUrl(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    // The opener (and whatever it starts) never inherits a git token (A171).
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      env: childEnv(process.env),
    });
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
