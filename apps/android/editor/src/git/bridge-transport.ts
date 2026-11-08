/**
 * The engine's `GitTransport` on Android (T50 G7, A824, A873): every call goes to the app, which
 * runs JGit (`JGitTransport`) behind its own checks (privacy, rewrites, Delete for good, logs that
 * shrink), as the Mac's main process does for its page (`IpcGitTransport`). Bytes cross as bytes.
 */
import {
  GitTransportError,
  type CommitInfo,
  type GitErrorCode,
  type GitTransport,
  type PushOutcome,
} from '@penmoss/git-notebook';
import { ChannelError, type Channel } from './channel';

const GIT_CODES: ReadonlySet<string> = new Set<GitErrorCode>([
  'auth',
  'network',
  'not_found',
  'host_key',
  'signing',
  'protected',
  'rules',
  'refused',
  'git_missing',
  'timeout',
  'redirected',
  'git',
]);

/**
 * A refusal from the app's own checks (a public repository, Delete for good nobody confirmed):
 * not git's, so the engine host shows it as it is and stops until the person acts.
 */
export class GitRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hostMessage?: string,
  ) {
    super(message);
    this.name = 'GitRefused';
  }
}

/** Reads go in parts of at most this many bytes, so no frame gets large. */
export const READ_PART_BYTES = 8 * 1024 * 1024;
/** … and at most this many files. */
export const READ_PART_FILES = 400;

/** No git call the app makes may take longer than this (JGit's own timeouts are shorter). */
const CALL_LIMIT_MS = 5 * 60_000;

function translated(error: unknown): Error {
  if (error instanceof ChannelError) {
    if (GIT_CODES.has(error.code)) {
      return new GitTransportError(error.code as GitErrorCode, error.message, error.hostMessage);
    }
    return new GitRefused(error.code, error.message, error.hostMessage);
  }
  return error instanceof Error ? error : new Error(String(error));
}

const pairs = (value: unknown): Array<[string, unknown]> =>
  Array.isArray(value)
    ? value.filter(
        (pair): pair is [string, unknown] => Array.isArray(pair) && typeof pair[0] === 'string',
      )
    : [];

export class BridgeTransport implements GitTransport {
  constructor(
    private readonly channel: Channel,
    readonly root: string,
  ) {}

  private async call(op: string, args: unknown[]): Promise<unknown> {
    try {
      return await this.channel.call(`git.${op}`, args, CALL_LIMIT_MS);
    } catch (error) {
      throw translated(error);
    }
  }

  async fetch(): Promise<string | null> {
    const head = await this.call('fetch', []);
    return typeof head === 'string' ? head : null;
  }

  async list(head: string): Promise<ReadonlyMap<string, string>> {
    return new Map(
      pairs(await this.call('list', [head])).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string',
      ),
    );
  }

  async sizes(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (paths.length === 0) return new Map();
    return new Map(
      pairs(await this.call('sizes', [head, [...paths]])).filter(
        (pair): pair is [string, number] => typeof pair[1] === 'number',
      ),
    );
  }

  async changed(from: string, to: string): Promise<readonly string[] | null> {
    const list = await this.call('changed', [from, to]);
    return Array.isArray(list)
      ? list.filter((path): path is string => typeof path === 'string')
      : null;
  }

  async read(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    if (paths.length === 0) return out;
    const sizes = await this.sizes(head, paths);
    let part: string[] = [];
    let bytes = 0;
    const flush = async () => {
      if (part.length === 0) return;
      for (const [path, value] of pairs(await this.call('read', [head, part]))) {
        if (value instanceof Uint8Array) out.set(path, value.slice());
      }
      part = [];
      bytes = 0;
    };
    for (const path of paths) {
      // A file not there has no size: it is left out, as `read` leaves it out.
      const size = sizes.get(path);
      if (size === undefined) continue;
      if (part.length > 0 && (bytes + size > READ_PART_BYTES || part.length >= READ_PART_FILES)) {
        await flush();
      }
      part.push(path);
      bytes += size;
    }
    await flush();
    return out;
  }

  async commit(
    head: string | null,
    changes: ReadonlyMap<string, Uint8Array | null>,
    message: string,
  ): Promise<string | null> {
    const commit = await this.call('commit', [head, [...changes], message]);
    return typeof commit === 'string' ? commit : null;
  }

  async push(commit: string): Promise<PushOutcome> {
    return (await this.call('push', [commit])) === 'rejected' ? 'rejected' : 'pushed';
  }

  async log(
    options: { readonly paths?: readonly string[]; readonly limit?: number } = {},
  ): Promise<CommitInfo[]> {
    const list = await this.call('log', [
      {
        ...(options.paths ? { paths: [...options.paths] } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      },
    ]);
    if (!Array.isArray(list)) return [];
    return list.flatMap((each: unknown) => {
      const commit = each as Partial<CommitInfo> | null;
      if (!commit || typeof commit.id !== 'string' || typeof commit.message !== 'string') return [];
      return [
        {
          id: commit.id,
          parents: Array.isArray(commit.parents) ? commit.parents.map(String) : [],
          author: {
            name: String(commit.author?.name ?? ''),
            email: String(commit.author?.email ?? ''),
          },
          at: Number(commit.at ?? 0),
          message: commit.message,
        },
      ];
    });
  }

  async readAt(commit: string, path: string): Promise<Uint8Array | null> {
    const bytes = await this.call('readAt', [commit, path]);
    return bytes instanceof Uint8Array ? bytes.slice() : null;
  }

  async maintain(): Promise<void> {
    await this.call('maintain', []);
  }

  /** Stops the git running now, and what waits (A859): the app answers once it has. */
  async cancel(): Promise<void> {
    await this.channel.call('git.cancel', [], 10_000).catch(() => undefined);
  }
}
