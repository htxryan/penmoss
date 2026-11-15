/**
 * Git notebooks for the CLI in Node (T50 G2, #150): the registry in `~/.penmoss/notebooks.json`
 * (`notebooks/registry.ts`), each clone in `~/.penmoss/git/<localId>/` (a bare partial clone and
 * the notebook's state, `notebooks/clone.ts`), a lock per clone shared with the local MCP server
 * (`notebooks/mcp-session.ts`), and the tokens and writer secrets in the keychain or
 * `~/.penmoss/credentials.json` (0600). `PENMOSS_HOME` moves all of it.
 *
 * Only git talks to the notebook's host; nothing else is reached (A820). Penmoss does not ask
 * anyone whether the repository is private (D61), and git follows its own configuration,
 * rewrites (`insteadOf`, `pushInsteadOf`) included (D62).
 */
import { ulid } from '@penmoss/core/ids';
import { MeaningIndex } from '@penmoss/core/search';
import { NotebookOps } from '@penmoss/git-notebook';
import { isTokenText, isTokenUser } from '@penmoss/git-notebook/identity';
import { LocalNotebook } from '@penmoss/git-notebook/local';
import {
  FileStorage,
  gitRunner,
  lockNotebook,
  redactRemote,
  remoteParts,
} from '@penmoss/git-notebook/node';
import { mkdir, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CliError, EXIT } from './errors';
import type { MeaningIo, NotebookIo, NotebookStatus, OpenedMeaning, TokenStore } from './io';
import { Clones, type ClonesOptions } from './notebooks/clone';
import { cliError } from './notebooks/errors';
import { McpNotebooks } from './notebooks/mcp-notebooks';
import { McpSession } from './notebooks/mcp-session';
import {
  NotebookRegistry,
  publicEntry,
  renamedTo,
  type StoredNotebook,
} from './notebooks/registry';
import { nodeTokenStore } from './token-store';

/**
 * A one-shot search embeds at most this long of the chunks the cache lacks (A1157, A1160).
 * `penmoss mcp` has its own budgets (`notebooks/mcp-session.ts`).
 */
const CLI_MEANING_BUDGET_MS = 1_500;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface NodeNotebooksOptions {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly uid?: number;
  /** For the tests: a token store in memory and git's environment. */
  readonly secrets?: TokenStore;
  readonly gitEnv?: Readonly<Record<string, string | undefined>>;
  /** The local MCP server's cadence (A825): push this long after edits settle; pull this often. */
  readonly pushDelayMs?: number;
  readonly pullEveryMs?: number;
  /** `--channel`'s cadence (A1063): the head check (10 s) and the session's heartbeat (hourly). */
  readonly channelCheckMs?: number;
  readonly heartbeatMs?: number;
  readonly lockWaitMs?: number;
  /** Search by meaning (T75), in the app's binary: absent, searches are by words only. */
  readonly meaning?: MeaningIo;
  /** How often `penmoss mcp` indexes for meaning while it holds the lease (default 30 s). */
  readonly indexEveryMs?: number;
  /**
   * How often `penmoss mcp` tries for the indexing lease while another process holds it, and
   * checks it still holds it (default 30 s; A1350).
   */
  readonly leaseRetryMs?: number;
  /** How often `penmoss mcp` renews its notebook's claim on the vectors it uses (default 10 min). */
  readonly claimEveryMs?: number;
  /**
   * Whether a person is at this machine's terminal (`/dev/tty` opens). Only then does signing get
   * its full minute.
   */
  readonly terminal?: () => boolean;
  /** For the tests: each clone over another transport than system git (A1516). */
  readonly transport?: NonNullable<ClonesOptions['transport']>;
}

/** How long a command waits for its stopped sync to end once its time is up (A852). */
const LATE_SYNC_MS = 5_000;
/** Resolves after `ms`, without keeping the process alive for it. */
const sleep = (ms: number) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export function nodeNotebooks(options: NodeNotebooksOptions): NotebookIo {
  const home = options.home;
  const secrets: TokenStore =
    options.secrets ??
    nodeTokenStore({
      platform: options.platform,
      env: options.env,
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
      service: 'penmoss-git',
      file: join(home, 'credentials.json'),
      accepts: isTokenText,
    });
  const registry = new NotebookRegistry(home, options.lockWaitMs);
  const clones = new Clones(options, secrets, registry);

  return {
    async list() {
      return (await registry.read()).notebooks.map(publicEntry);
    },

    async add(input) {
      const parts = remoteParts(input.remote);
      if (!parts) {
        throw new CliError(
          EXIT.USAGE,
          `“${redactRemote(input.remote)}” is not a git remote (an https://, ssh:// or git@host:path URL).`,
          'invalid_remote',
        );
      }
      if (parts.credentials) {
        throw new CliError(
          EXIT.USAGE,
          'The remote has a user name or password in it: Penmoss never keeps a credential in a remote, where status, logs and git would show it.',
          'remote_credentials',
          { remote: redactRemote(input.remote) },
          [
            'Give the remote without it, and the token on stdin: --token - (saved in the keychain; later: penmoss notebook token <name> -).',
          ],
        );
      }
      if (input.tokenUser !== undefined && !isTokenUser(input.tokenUser)) {
        throw new CliError(
          EXIT.USAGE,
          `“${input.tokenUser}” cannot be a token user name: use letters, digits, ., _ and -.`,
          'invalid_token_user',
        );
      }
      const branchOk = await gitRunner({ env: { GIT_DIR: undefined, ...options.gitEnv } })(
        ['check-ref-format', '--branch', input.branch],
        { ok: [0, 1, 128] },
      )
        .then((done) => done.code === 0 && !input.branch.startsWith('-'))
        .catch(() => false);
      if (!branchOk) {
        throw new CliError(
          EXIT.USAGE,
          `“${input.branch}” is not a branch name git takes.`,
          'invalid_branch',
        );
      }
      const known = await registry.read();
      const localId = ulid();
      const label = input.agent?.trim() || hostname();
      const author = await clones.gitIdentity(label);
      // This notebook's own identity from the start (#198): the name is git's when not given.
      const identity = input.author
        ? { name: input.author.name ?? author.name, email: input.author.email }
        : undefined;
      const repoName = (parts.path.split('/').filter(Boolean).at(-1) ?? 'notes').replace(
        /\.git$/,
        '',
      );
      const wanted =
        input.name ?? (input.dir ? `${repoName}-${input.dir.split('/').at(-1)}` : repoName);
      if (!NAME.test(wanted)) {
        throw new CliError(
          EXIT.USAGE,
          `“${wanted}” cannot name a notebook: use letters, digits, ., _ and -.`,
          'invalid_name',
        );
      }
      if (known.notebooks.some((each) => each.name === wanted)) {
        throw new CliError(
          EXIT.CONFLICT,
          `A git notebook named “${wanted}” is on this machine already.`,
          'notebook_exists',
          undefined,
          ['Pass --name to call this one something else.'],
        );
      }
      const entry: StoredNotebook = {
        name: wanted,
        localId,
        remote: input.remote,
        branch: input.branch,
        dir: input.dir,
        writer: { kind: input.agent ? 'agent' : 'device', label },
        ...(input.automatic && input.agent ? { automatic: true as const } : {}),
        author,
        ...(identity ? { identity } : {}),
        added: new Date().toISOString(),
        ...(input.tokenUser ? { tokenUser: input.tokenUser } : {}),
        ...(input.sign === false ? { sign: false } : {}),
      };
      await mkdir(clones.dir(entry), { recursive: true, mode: 0o700 });
      if (input.token) await secrets.set(clones.tokenKey(entry), input.token, 'auto');
      const cleanUp = async () => {
        await rm(clones.dir(entry), { recursive: true, force: true });
        await secrets.delete(clones.tokenKey(entry)).catch(() => undefined);
        await secrets.delete(clones.writerKey(entry)).catch(() => undefined);
      };
      try {
        const stored: StoredNotebook = entry;
        const transport = clones.transportFor(stored);
        await transport.init();
        const head = await transport.fetch().catch((error: unknown) => {
          throw cliError(error, stored.name);
        });
        const root = stored.dir ? `${stored.dir}/` : '';
        const files = head ? await transport.list(head) : new Map<string, string>();
        const exists = files.has(`${root}.penmoss/notebook.json`);
        if (!exists && input.existing) {
          throw new CliError(
            EXIT.NOT_FOUND,
            'The target holds no notebook yet.',
            'notebook_not_there',
            { remote: redactRemote(stored.remote), branch: stored.branch, dir: stored.dir },
          );
        }
        const created = exists ? undefined : { id: ulid(), name: input.name ?? wanted };
        let taken = false;
        await registry.change((now) => {
          taken = now.notebooks.some((each) => each.name === stored.name);
          return taken ? now : { version: 1, notebooks: [...now.notebooks, stored] };
        });
        if (taken) {
          throw new CliError(
            EXIT.CONFLICT,
            `A git notebook named “${stored.name}” is on this machine already.`,
            'notebook_exists',
            undefined,
            ['Pass --name to call this one something else.'],
          );
        }
        try {
          const synced = await clones.withLock(stored, 'penmoss notebook add', async () => {
            const opened = await clones.open(stored, created);
            try {
              return await clones.sync(stored, opened, false, undefined, true);
            } finally {
              await opened.engine.save();
            }
          });
          const final = await registry.find(stored.name);
          return {
            entry: publicEntry(final),
            created: !exists,
            sync: synced,
          };
        } catch (error) {
          await registry.change((after) => ({
            version: 1,
            notebooks: after.notebooks.filter((each) => each.localId !== stored.localId),
          }));
          throw error;
        }
      } catch (error) {
        await cleanUp();
        throw error;
      }
    },

    async remove(name, force) {
      const entry = await registry.find(name);
      await clones.withLock(entry, 'penmoss notebook remove', async () => {
        const meta = (await new FileStorage(clones.dir(entry)).load())?.meta;
        const unsynced = meta ? Object.keys(meta.dirty).length + (meta.workspaceDirty ? 1 : 0) : 0;
        if (unsynced > 0 && !force) {
          throw new CliError(
            EXIT.CONFLICT,
            `${name} has changes made here that have not synced yet.`,
            'unsynced_changes',
            { unsynced },
            [`Sync them first (penmoss notebook sync ${name}), or pass --force to drop them.`],
          );
        }
      });
      await rm(clones.dir(entry), { recursive: true, force: true });
      await secrets.delete(clones.tokenKey(entry)).catch(() => undefined);
      await secrets.delete(clones.writerKey(entry)).catch(() => undefined);
      await registry.change((now) => ({
        version: 1,
        notebooks: now.notebooks.filter((each) => each.localId !== entry.localId),
      }));
      return publicEntry(entry);
    },

    async set(name, change) {
      await registry.find(name);
      await registry.update(name, (each) => {
        const next: { -readonly [K in keyof StoredNotebook]: StoredNotebook[K] } = { ...each };
        if (change.sign === false) next.sign = false;
        else if (change.sign === true) delete next.sign;
        if (change.author === null) delete next.identity;
        else if (change.author) next.identity = change.author;
        return change.notebookName ? renamedTo(next, change.notebookName) : next;
      });
    },

    async setToken(name, token) {
      const entry = await registry.find(name);
      if (token === null) await secrets.delete(clones.tokenKey(entry));
      else await secrets.set(clones.tokenKey(entry), token, 'auto');
    },

    async status(asked): Promise<NotebookStatus> {
      const entry = await registry.resolve(asked, 'device');
      const storage = new FileStorage(clones.dir(entry));
      const snapshot = await storage.load();
      const meta = snapshot?.meta;
      const transport = clones.transportFor(entry);
      const cloneBytes = await (async () => {
        try {
          await stat(clones.gitDir(entry));
          return await transport.storeBytes();
        } catch {
          return 0;
        }
      })();
      return {
        ...publicEntry(entry),
        skipped: meta?.skipped ?? {},
        signing: entry.sign === false ? 'off' : 'as git config says',
        author: entry.identity
          ? { ...entry.identity, own: true }
          : { ...(await clones.gitIdentity(entry.writer.label)), own: false },
        writerId: meta?.writer?.id ?? null,
        lastHead: meta?.lastHead ?? null,
        unsynced: meta ? Object.keys(meta.dirty).length + (meta.workspaceDirty ? 1 : 0) : 0,
        notes: snapshot?.notes.size ?? 0,
        cloneBytes,
        stateBytes: await storage.bytes(),
        token: (await secrets.get(clones.tokenKey(entry)).catch(() => null))
          ? 'saved'
          : (await clones.tokenOf(entry)) !== null
            ? 'environment'
            : null,
        filterIgnored: entry.filterIgnored ?? false,
      };
    },

    async sync(asked, syncOptions = {}) {
      const entry = await registry.resolve(asked, 'device');
      return clones.withLock(
        entry,
        'penmoss notebook sync',
        async () => {
          const opened = await clones.open(entry);
          try {
            return await clones.sync(entry, opened, syncOptions.full === true);
          } finally {
            await opened.engine.save();
          }
        },
        syncOptions.waitMs,
      );
    },

    async session(asked, what) {
      const entry = await registry.resolve(asked, 'device');
      const name = entry.name;
      let lock;
      try {
        lock = await lockNotebook(clones.dir(entry), what, {
          waitMs: options.lockWaitMs ?? 10_000,
        });
      } catch (error) {
        throw cliError(error, name);
      }
      let opened;
      try {
        opened = await clones.open(entry);
      } catch (error) {
        await lock.release();
        throw cliError(error, name);
      }
      const held = lock;
      const engine = opened;
      // `history --save` commits now, through the same checks as any sync (A841).
      const notebook = new LocalNotebook(
        new NotebookOps(opened.engine),
        Date.now,
        async () => {
          await clones.sync(entry, engine);
        },
        // The CLI is an agent's side (A920): Agent activity is the apps'.
        { side: 'cli' },
      );
      let meaning: OpenedMeaning | null = null;
      return {
        async useMeaning() {
          if (!options.meaning || meaning) return;
          try {
            meaning = await options.meaning.open('cli');
          } catch (error) {
            throw new CliError(
              EXIT.ERROR,
              error instanceof Error ? error.message : String(error),
              'model_unusable',
              undefined,
              ['Fetch the model again: penmoss models fetch'],
            );
          }
          if (!meaning) return;
          const cache = meaning.cache;
          notebook.useMeaning({
            index: new MeaningIndex(meaning.embedder, cache),
            budgetMs: CLI_MEANING_BUDGET_MS,
            // The app's compaction keeps what this notebook uses, though it never opens it.
            ...(cache.claim ? { claim: (keys) => cache.claim!(clones.dir(entry), keys) } : {}),
          });
        },
        notebook,
        // Every change is on disk before the command goes on (B1 of #165): a command killed
        // during the sync that follows loses nothing; the next sync sends it.
        save: () => engine.engine.save(),
        sync: async (syncOptions = {}) => {
          const timeoutMs = syncOptions.timeoutMs;
          if (timeoutMs === undefined) return clones.sync(entry, engine);
          // A command's own sync is bounded (A852): on a network that drops connections a fetch
          // can wait minutes, and an agent's Bash call would hang with it. Stopped is stopped:
          // the engine makes no git call after the signal (a cancel between two calls was lost).
          const stop = new AbortController();
          let timer: ReturnType<typeof setTimeout> | null = null;
          const running = clones.sync(entry, engine, false, stop.signal);
          const outOfTime = new Promise<'late'>((resolve) => {
            timer = setTimeout(() => resolve('late'), timeoutMs);
          });
          try {
            const first = await Promise.race([running, outOfTime]);
            if (first !== 'late') return first;
            stop.abort();
            engine.transport.cancel();
            // The stopped sync ends at once (its git was killed); a push that landed before
            // that is reported as pushed. Never waited on for more than LATE_SYNC_MS.
            const settled = await Promise.race([
              running.then(
                (summary) => ({ summary }),
                () => null,
              ),
              sleep(LATE_SYNC_MS).then(() => null),
            ]);
            if (settled?.summary.commit) return settled.summary;
            throw new CliError(
              EXIT.ERROR,
              `the host did not answer within ${Math.round(timeoutMs / 1000)} s`,
              'sync_timeout',
            );
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        detachedLog: join(clones.dir(entry), 'detached-sync.log'),
        async close() {
          try {
            await engine.engine.save();
          } finally {
            engine.engine.replica.destroy();
            await held.release();
            await meaning?.close();
          }
        },
      };
    },

    async serveMcp(asked, io, serveOptions = {}) {
      // An agent's server: nobody can answer a signer here.
      clones.unattended = true;
      if (asked === undefined) {
        await new McpNotebooks(clones, registry, home, io, options).serve();
        return;
      }
      const entry = await registry.resolve(asked, 'agent');
      await new McpSession(entry, clones, registry, io, options, serveOptions.channel).serve();
    },
  };
}
