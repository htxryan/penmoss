/**
 * One git notebook's clone on this machine: `~/.penmoss/git/<localId>/` holds a bare partial
 * clone (`repo.git`) and the notebook's state, under a lock shared by the CLI and the local MCP
 * server. Its token and writer secret are in the keychain or `~/.penmoss/credentials.json`.
 */
import {
  GitNotebookEngine,
  type GitTransport,
  type SyncReport,
  type WriterSecrets,
} from '@penmoss/git-notebook';
import {
  FileStorage,
  gitUserIdentity,
  lockNotebook,
  NodeGitTransport,
  redactRemote,
  remoteParts,
  type GitAuthor,
} from '@penmoss/git-notebook/node';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError, EXIT } from '../errors';
import type { NotebookEntry, NotebookSyncSummary, TokenStore } from '../io';
import { cliError } from './errors';
import { renamedTo, type NotebookRegistry, type StoredNotebook } from './registry';

/** How long signing may wait where nobody can answer it (the local MCP, a detached sync). */
const SIGN_UNATTENDED_MS = 5_000;

/** What the CLI asks of a clone's transport beyond the engine's: `NodeGitTransport`'s. */
export interface CloneTransport extends GitTransport {
  init(): Promise<void>;
  readonly notes: { readonly filterIgnored: boolean };
  remoteHead(): Promise<string | null>;
  storeBytes(): Promise<number>;
  cancel(): void;
}

/** Where a clone's transport points, and who commits, for `ClonesOptions.transport`. */
export interface CloneTarget {
  readonly remote: string;
  readonly branch: string;
  readonly root: string;
  readonly author: () => Promise<GitAuthor>;
}

/** A clone opened: its engine over system git, and its state on disk. */
export interface OpenedClone {
  readonly engine: GitNotebookEngine;
  readonly transport: CloneTransport;
  readonly storage: FileStorage;
}

export interface ClonesOptions {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly gitEnv?: Readonly<Record<string, string | undefined>>;
  readonly lockWaitMs?: number;
  /** Whether a person is at this machine's terminal: only then does signing get its full minute. */
  readonly terminal?: () => boolean;
  /**
   * For the tests of what is the CLI's, not git's: each clone over another transport (an
   * in-memory one, A1516). Absent, system git.
   */
  readonly transport?: (target: CloneTarget) => CloneTransport;
}

/** The clones under `home`, and what opening, syncing and locking one takes. */
export class Clones {
  /** Set by `penmoss mcp`: nobody at a terminal answers for it, whatever stdin is. */
  unattended = false;

  constructor(
    private readonly options: ClonesOptions,
    readonly secrets: TokenStore,
    private readonly registry: NotebookRegistry,
  ) {}

  dir(entry: { localId: string }): string {
    return join(this.options.home, 'git', entry.localId);
  }

  gitDir(entry: { localId: string }): string {
    return join(this.dir(entry), 'repo.git');
  }

  tokenKey(entry: { localId: string }): string {
    return `token:${entry.localId}`;
  }

  writerKey(entry: { localId: string }): string {
    return `writer:${entry.localId}`;
  }

  private attended(): boolean {
    return !this.unattended && (this.options.terminal?.() ?? false);
  }

  /** git's own identity (global, then system config), or `label` (A825). */
  gitIdentity(label: string): Promise<{ readonly name: string; readonly email: string }> {
    return gitUserIdentity(this.options.gitEnv, label);
  }

  /**
   * The notebook's token: its own saved one, else PENMOSS_GIT_TOKEN, which is only for
   * PENMOSS_GIT_TOKEN_HOST's repositories (github.com unless set), never sent to another host.
   */
  async tokenOf(entry: { localId: string; remote: string }): Promise<string | null> {
    const saved = (await this.secrets.get(this.tokenKey(entry)).catch(() => null))?.token ?? null;
    if (saved) return saved;
    const fromEnv = this.options.env['PENMOSS_GIT_TOKEN']?.trim();
    const host = (this.options.env['PENMOSS_GIT_TOKEN_HOST']?.trim() || 'github.com').toLowerCase();
    const parts = remoteParts(entry.remote);
    return fromEnv && parts && parts.protocol !== 'file' && parts.host === host ? fromEnv : null;
  }

  private writerSecrets(entry: { localId: string }): WriterSecrets {
    return {
      get: async () => (await this.secrets.get(this.writerKey(entry)))?.token ?? null,
      set: async (secret) => {
        await this.secrets.set(this.writerKey(entry), secret, 'auto');
      },
    };
  }

  transportFor(
    entry: StoredNotebook | (NotebookEntry & { author: StoredNotebook['author'] }),
  ): CloneTransport {
    const target: CloneTarget = {
      remote: entry.remote,
      branch: entry.branch,
      root: entry.dir ? `${entry.dir}/` : '',
      // Asked before each commit: the notebook's own, read from the registry again (a
      // `notebook set` from another terminal reaches a running `penmoss mcp`, #174 review),
      // else git's identity now (#170 F3, F6).
      author: async () => {
        const now = (await this.registry.read().catch(() => null))?.notebooks.find(
          (each) => each.localId === entry.localId,
        );
        const identity = now ? now.identity : 'identity' in entry ? entry.identity : undefined;
        return identity ?? this.gitIdentity(entry.writer.label);
      },
    };
    if (this.options.transport) return this.options.transport(target);
    return new NodeGitTransport({
      ...target,
      gitDir: this.gitDir(entry),
      token: () => this.tokenOf(entry),
      ...('tokenUser' in entry && entry.tokenUser ? { tokenUser: entry.tokenUser } : {}),
      ...('sign' in entry && entry.sign === false ? { sign: false } : {}),
      ...(this.attended() ? {} : { signTimeoutMs: SIGN_UNATTENDED_MS }),
      ...(this.options.gitEnv ? { env: this.options.gitEnv } : {}),
    });
  }

  async open(
    entry: StoredNotebook,
    create?: { id: string; name: string; salt?: string },
  ): Promise<OpenedClone> {
    const transport = this.transportFor(entry);
    await transport.init();
    const storage = new FileStorage(this.dir(entry));
    const engine = await GitNotebookEngine.open({
      transport,
      storage,
      secrets: this.writerSecrets(entry),
      writer: entry.writer,
      ...(create ? { create } : {}),
    });
    return { engine, transport, storage };
  }

  /**
   * Syncs an opened clone, and records in the registry what the sync learnt: the notebook's id
   * and name, and whether the host ignored the partial-clone filter.
   */
  async sync(
    entry: StoredNotebook,
    opened: { engine: GitNotebookEngine; transport: CloneTransport },
    full = false,
    signal?: AbortSignal,
    adding = false,
  ): Promise<NotebookSyncSummary> {
    checkRemote(entry);
    try {
      const report = await opened.engine.sync({ full, ...(signal ? { signal } : {}) });
      // When any process last synced this clone: `penmoss mcp` skips a pull it would repeat.
      await writeFile(this.syncedAtPath(entry), `${new Date().toISOString()}\n`).catch(
        () => undefined,
      );
      const info = opened.engine.info;
      const filterIgnored = opened.transport.notes.filterIgnored;
      if (
        info &&
        (info.id !== entry.notebookId ||
          info.name !== entry.notebookName ||
          filterIgnored !== (entry.filterIgnored ?? false))
      ) {
        await this.registry.update(entry.name, (each) => ({
          ...renamedTo(each, info.name),
          notebookId: info.id,
          filterIgnored,
        }));
      }
      return summary(entry.name, report, opened.transport);
    } catch (error) {
      throw cliError(error, entry.name, adding);
    }
  }

  private syncedAtPath(entry: { localId: string }): string {
    return join(this.dir(entry), 'synced-at');
  }

  /** When any process last synced this clone, in ms, or null if none has here. */
  async syncedAt(entry: { localId: string }): Promise<number | null> {
    return (await stat(this.syncedAtPath(entry)).catch(() => null))?.mtimeMs ?? null;
  }

  /** Runs `run` holding the clone's lock. */
  async withLock<T>(
    entry: StoredNotebook,
    what: string,
    run: () => Promise<T>,
    waitMs = this.options.lockWaitMs ?? 10_000,
  ): Promise<T> {
    let lock;
    try {
      lock = await lockNotebook(this.dir(entry), what, { waitMs });
    } catch (error) {
      throw cliError(error, entry.name);
    }
    try {
      return await run();
    } finally {
      await lock.release();
    }
  }
}

/** A remote with a user name or password in it is never synced with. */
function checkRemote(entry: StoredNotebook): void {
  if (remoteParts(entry.remote)?.credentials) {
    throw new CliError(
      EXIT.REFUSED,
      'The remote has a user name or password in it, which Penmoss never keeps there.',
      'remote_credentials',
      { remote: redactRemote(entry.remote) },
      [
        `Remove this notebook (penmoss notebook remove ${entry.name}), add it again without them, and save the token with penmoss notebook token <name> -.`,
      ],
    );
  }
}

/** What one sync did, for people and `--json`. */
function summary(name: string, report: SyncReport, transport: CloneTransport): NotebookSyncSummary {
  return {
    name,
    commit: report.commit,
    head: report.head,
    pulled: report.changed.length,
    purged: report.purged.length,
    handEdits: report.handEdits,
    copies: report.copies,
    skipped: report.skipped,
    renderSkipped: report.renderSkipped,
    attempts: report.attempts,
    filterIgnored: transport.notes.filterIgnored,
    warnings: transport.notes.filterIgnored
      ? [
          'The host ignored the partial-clone filter: this machine keeps a full copy of the repository.',
        ]
      : [],
  };
}
