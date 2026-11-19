/**
 * Machines for the CLI's notebook tests (T50 G2): each its own `~/.penmoss`, keychain (in memory)
 * and stdin, running `run()` as the binary does. Over system git against bare repositories here
 * (`notebook-git.test.ts`, `notebook-mcp.test.ts`), or over an in-memory host
 * (`MemoryHosts`, A1516) for what is the CLI's own logic, not git's (`notebook-commands.test.ts`).
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRemote, MemoryTransport } from '@penmoss/git-notebook';
import { afterEach, beforeEach } from 'vitest';
import type { AnalyticsIo, Io } from '../../src/io';
import { run } from '../../src/main';
import { memoryTokenStore } from '../../src/memory-store';
import { nodeNotebooks } from '../../src/node-notebooks';
import type { CloneTarget, CloneTransport } from '../../src/notebooks/clone';
import { bareRepository, GIT_ENV, git } from '../../../git-notebook/test/support/git';

export { GIT_ENV, git };

/** A folder of its own for each test, removed after it. */
export function testRoot(prefix: string): { readonly path: string } {
  const root = { path: '' };
  beforeEach(() => {
    root.path = mkdtempSync(join(tmpdir(), prefix));
  });
  afterEach(() => rmSync(root.path, { recursive: true, force: true }));
  return root;
}

/** A new bare repository `<root>/<name>.git`, as a host has. */
export function bare(root: string, name: string): string {
  return bareRepository(join(root, `${name}.git`));
}

/**
 * Git hosts in memory, by remote URL: each clone's transport a `MemoryTransport` over the URL's
 * `MemoryRemote`, committing as the CLI's own author rule says (`CloneTarget.author`). The
 * registry, the clone's state, its lock and the commands are the CLI's, on disk as ever.
 */
export class MemoryHosts {
  private readonly remotes = new Map<string, MemoryRemote>();

  /** A remote's URL for `notebook add`: never fetched by git, only looked up here. */
  url(name: string): string {
    return `file:///memory/${name}.git`;
  }

  remote(url: string): MemoryRemote {
    let remote = this.remotes.get(url);
    if (!remote) this.remotes.set(url, (remote = new MemoryRemote()));
    return remote;
  }

  readonly transport = (target: CloneTarget): CloneTransport =>
    Object.assign(
      new MemoryTransport({
        remote: this.remote(target.remote),
        branch: target.branch,
        root: target.root,
        author: target.author,
      }),
      {
        init: () => Promise.resolve(),
        notes: { filterIgnored: false },
        storeBytes: () => Promise.resolve(0),
        cancel: () => undefined,
      },
    );

  /** The branch's head at `url` (null before the first push). */
  head(url: string, branch = 'main'): string | null {
    return this.remote(url).branches.get(branch) ?? null;
  }

  /** Every path in the branch's head, as `git ls-tree -r --name-only` lists them. */
  files(url: string, branch = 'main'): string[] {
    const head = this.head(url, branch);
    return head ? [...this.remote(url).commits.get(head)!.tree.keys()].sort() : [];
  }

  /** The branch's commits, newest first. */
  log(url: string, branch = 'main'): Array<{ author: string; message: string }> {
    return this.remote(url)
      .history(branch)
      .map((commit) => ({ author: commit.author.name, message: commit.message }))
      .reverse();
  }
}

export interface MachineOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly gitEnv?: Readonly<Record<string, string>>;
  readonly channelCheckMs?: number;
  /**
   * How long `penmoss mcp` waits after an edit before it pushes. 50 ms by default, so a test
   * sees the server's own push; a test of what a stopped server leaves to its detached sync
   * passes SERVER_PUSH_DELAY_MS, so that push cannot come before the stop.
   */
  readonly pushDelayMs?: number;
  /** Over these in-memory hosts instead of system git. */
  readonly hosts?: MemoryHosts;
}

/** `penmoss mcp`'s own push delay (node-notebooks.ts): longer than any test runs. */
export const SERVER_PUSH_DELAY_MS = 60_000;

export interface Input {
  readonly stdin?: string;
  /** Each line in turn; a function runs between two lines (another terminal, say). */
  readonly lines?: ReadonlyArray<string | (() => Promise<void>)>;
  /** Stop with this signal once the lines are read, instead of ending stdin. */
  readonly signal?: string;
  /** Where detached syncs are recorded; given, the CLI can detach. */
  readonly detached?: string[][];
  /** The log each detached sync was given. */
  readonly logs?: string[];
  /** The CLI's own environment (`io.env`). */
  readonly cliEnv?: Readonly<Record<string, string>>;
  /** Usage analytics (PEN-137): without it, nothing is recorded. */
  readonly analytics?: AnalyticsIo;
  /** Whether stdout is a terminal (default false). */
  readonly tty?: boolean;
}

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  json(): Record<string, unknown>;
}

/** A machine `name` under `root`: its own ~/.penmoss, keychain (in memory) and stdin. */
export function machine(
  root: string,
  name: string,
  extra: MachineOptions = {},
): (argv: string[], input?: Input) => Promise<Ran> {
  const notebooks = nodeNotebooks({
    home: join(root, name),
    env: extra.env ?? {},
    platform: process.platform,
    secrets: memoryTokenStore(),
    gitEnv: { ...GIT_ENV, ...extra.gitEnv },
    pushDelayMs: extra.pushDelayMs ?? 50,
    pullEveryMs: 60_000,
    lockWaitMs: 300,
    ...(extra.channelCheckMs !== undefined ? { channelCheckMs: extra.channelCheckMs } : {}),
    ...(extra.hosts ? { transport: extra.hosts.transport } : {}),
  });
  return async (argv, input = {}) => {
    let stop: (signal: string) => void = () => undefined;
    let stdout = '';
    let stderr = '';
    const io: Io = {
      env: input.cliEnv ?? {},
      stdin: { isTTY: false, read: () => Promise.resolve(input.stdin ?? '') },
      stdout: { isTTY: input.tty === true, write: (text) => void (stdout += text) },
      stderr: { write: (text) => void (stderr += text) },
      openUrl: () => Promise.resolve(false),
      readFile: (path) => Promise.resolve(new Uint8Array(readFileSync(path))),
      fileSize: (path) => Promise.resolve(statSync(path).size),
      stdio: {
        lines: async function* () {
          for (const line of input.lines ?? []) {
            if (typeof line === 'string') yield line;
            else await line();
          }
          if (input.signal === undefined) return;
          stop(input.signal);
          await new Promise(() => undefined);
        },
        ...(input.signal === undefined
          ? {}
          : { stopped: () => new Promise<string>((resolve) => (stop = resolve)) }),
        ...(input.detached === undefined
          ? {}
          : {
              detach: (args: readonly string[], log?: string) => {
                input.detached!.push([...args]);
                if (log) input.logs?.push(log);
                return true;
              },
            }),
      },
      notebooks,
      ...(input.analytics ? { analytics: input.analytics } : {}),
    };
    const code = await run(argv, io);
    return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
  };
}

/** One JSON-RPC line for `penmoss mcp`'s stdin. */
export const rpc = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

/** `initialize` as Claude Code sends it, then `notifications/initialized`. */
export const HANDSHAKE: readonly string[] = [
  rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'claude-code', version: '1' },
  }),
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
];

export interface McpReply {
  id: number;
  result: {
    tools?: unknown[];
    structuredContent?: Record<string, unknown> & { results?: { title: string }[] };
    isError?: boolean;
  };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts a tool on a test's PATH as a script that runs it by its own path. A symlink isn't enough:
 * the Command Line Tools' git (first on PATH in the tests on a Mac, A1513, and in the factory's
 * sandbox) finds `git-upload-pack` and its templates relative to the path it was started from,
 * so behind a symlink it can't clone.
 */
export function onPath(tool: string, at: string): void {
  writeFileSync(at, `#!/bin/sh\nexec '${tool.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
}
