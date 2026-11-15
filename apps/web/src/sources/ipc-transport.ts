/**
 * The page's git transport (T50 G3, #151; A853): every call goes to the Mac app's main process
 * (`penmoss:git:op`), which runs system git on the notebook's clone and checks each call's
 * arguments (A855). The page never reaches a git host and never holds a token.
 */
import {
  GitTransportError,
  type CommitInfo,
  type DirSnapshots,
  type GitErrorCode,
  type GitTransport,
  type PushOutcome,
} from '@penmoss/git-notebook';
import type { DesktopGit, GitRefusal } from '../desktop/bridge';

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

/** A refusal that is not git's: a remote with a credential in it, or a notebook main did not know. */
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

/** The error for a refusal from main: git's own as a GitTransportError (A824), else GitRefused. */
export function refusalError(refusal: GitRefusal): Error {
  return GIT_CODES.has(refusal.code)
    ? new GitTransportError(refusal.code as GitErrorCode, refusal.message, refusal.hostMessage)
    : new GitRefused(refusal.code, refusal.message, refusal.hostMessage);
}

export class IpcGitTransport implements GitTransport {
  constructor(
    private readonly git: DesktopGit,
    private readonly localId: string,
    /** `docs/notes/` (with the slash) or ''. */
    readonly root: string,
  ) {}

  private async call<T>(op: string, ...args: unknown[]): Promise<T> {
    const answer = await this.git.op(this.localId, op, args);
    if (!answer) throw new GitRefused('unavailable', 'This window cannot reach git.');
    if (!answer.ok) throw refusalError(answer.error);
    return answer.value as T;
  }

  fetch(): Promise<string | null> {
    return this.call('fetch');
  }

  async list(head: string): Promise<ReadonlyMap<string, string>> {
    return new Map(await this.call<Array<[string, string]>>('list', head));
  }

  async sizes(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return new Map(await this.call<Array<[string, number]>>('sizes', head, [...paths]));
  }

  changed(from: string, to: string): Promise<readonly string[] | null> {
    return this.call('changed', from, to);
  }

  async read(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> {
    const pairs = await this.call<Array<[string, Uint8Array]>>('read', head, [...paths]);
    return new Map(pairs.map(([path, bytes]) => [path, new Uint8Array(bytes)]));
  }

  commit(
    head: string | null,
    changes: ReadonlyMap<string, Uint8Array | null>,
    message: string,
  ): Promise<string | null> {
    return this.call('commit', head, [...changes], message);
  }

  push(commit: string): Promise<PushOutcome> {
    return this.call('push', commit);
  }

  log(
    options: { readonly paths?: readonly string[]; readonly limit?: number } = {},
  ): Promise<CommitInfo[]> {
    return this.call('log', {
      ...(options.paths ? { paths: [...options.paths] } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  async readAt(commit: string, path: string): Promise<Uint8Array | null> {
    const bytes = await this.call<Uint8Array | null>('readAt', commit, path);
    return bytes ? new Uint8Array(bytes) : null;
  }

  /** History's reads (Ryan's review of #192): one call for the note's directory at many commits. */
  async readDir(commits: readonly string[], dir: string): Promise<DirSnapshots> {
    const answer = await this.call<{
      files: Array<[string, Array<[string, string]>]>;
      blobs: Array<[string, Uint8Array]>;
    }>('readDir', [...commits], dir);
    return {
      files: new Map(answer.files.map(([commit, listed]) => [commit, new Map(listed)])),
      blobs: new Map(answer.blobs.map(([id, bytes]) => [id, new Uint8Array(bytes)])),
    };
  }

  async maintain(): Promise<void> {
    await this.call('maintain');
  }

  /** Stops every git of this notebook now (A852); resolves once main has stopped them. */
  async cancel(): Promise<void> {
    await this.git.cancel(this.localId);
  }
}
