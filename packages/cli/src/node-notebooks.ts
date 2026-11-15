/**
 * Git notebooks for the CLI in Node (T50 G2, #150): the registry in `~/.penmoss/notebooks.json`,
 * each clone in `~/.penmoss/git/<localId>/` (a bare partial clone and the notebook's state),
 * a lock per clone shared with the local MCP server, and the tokens and writer secrets in the
 * keychain or `~/.penmoss/credentials.json` (0600). `PENMOSS_HOME` moves all of it.
 *
 * Only git talks to the notebook's host; nothing else is reached (A820). Penmoss does not ask
 * anyone whether the repository is private (D61), and git follows its own configuration,
 * rewrites (`insteadOf`, `pushInsteadOf`) included (D62).
 */
import { ulid } from '@penmoss/core';
import { notebookTag } from '@penmoss/core/note-ref';
import { LEASE_RETRY_MS, LeaseKeeper, MeaningIndex } from '@penmoss/core/search';
import {
  GitNotebookEngine,
  GitTransportError,
  privateEmailAdvice,
  NotebookError,
  NotebookOps,
  type SyncReport,
  type WriterSecrets,
} from '@penmoss/git-notebook';
import {
  CHANNEL_CHECK_MS,
  CHANNEL_INSTRUCTIONS,
  CommentChannel,
  HEARTBEAT_MS,
  LOCAL_INSTRUCTIONS,
  LOCAL_MEANING_INSTRUCTIONS,
  LocalMcpServer,
  LocalNotebook,
  localFetch,
  type NotebookAccess,
} from '@penmoss/git-notebook/local';
import {
  FileStorage,
  gitRunner,
  LockHeldError,
  lockNotebook,
  NodeGitTransport,
  redactRemote,
  remoteParts,
} from '@penmoss/git-notebook/node';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { CliError, EXIT } from './errors';
import type {
  MeaningIo,
  NotebookEntry,
  NotebookIo,
  NotebookStatus,
  NotebookSyncSummary,
  OpenedMeaning,
  TokenStore,
} from './io';
import { nodeTokenStore } from './token-store';

/** What `notebooks.json` keeps of each notebook. */
interface StoredNotebook extends NotebookEntry {
  /** git's identity when the notebook was added: kept for older files, no longer used (#170 F3). */
  readonly author: { readonly name: string; readonly email: string };
  /** This notebook's own commit identity, over git's (#170 F6: `notebook set --author-email`). */
  readonly identity?: { readonly name: string; readonly email: string };
  readonly added: string;
  /** The host ignored the partial-clone filter at the last sync. */
  readonly filterIgnored?: boolean;
  /** The user name sent with the token (default `x-access-token`, which github.com takes). */
  readonly tokenUser?: string;
  /** False: never sign this notebook's commits (`--no-sign`). Default: as git's config says. */
  readonly sign?: boolean;
}

interface Registry {
  readonly version: 1;
  readonly notebooks: StoredNotebook[];
}

/** A git personal access token, or a writer secret: nothing a keychain command must quote. */
const SECRET = /^[A-Za-z0-9_.~+/=-]{8,1000}$/;
/** A token user name: no quoting, nothing a URL or a credential prompt treats specially. */
const TOKEN_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** How long a detached exit sync waits for the stopping server's lock (A847). */
const DETACHED_SYNC_WAIT_S = 120;
/**
 * Search by meaning's budgets (A1157, A1160): a one-shot search embeds at most this long of the
 * chunks the cache lacks; `penmoss mcp` without the lease a little; the holder indexes in the
 * background, a slice at a time, so a query waits for one small batch at most.
 */
const CLI_MEANING_BUDGET_MS = 1_500;
const MCP_MEANING_BUDGET_MS = 300;
const INDEX_SLICE_MS = 5_000;
/** How long after an agent's edit the holder indexes it. */
const EDIT_INDEX_DELAY_MS = 1_000;
const INDEX_EVERY_MS = 30_000;
/** How often an MCP server renews its notebook's claim on the vectors it uses (PEN-134). */
const CLAIM_EVERY_MS = 10 * 60_000;
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
}

/** How long signing may wait where nobody can answer it (the local MCP, a detached sync). */
const SIGN_UNATTENDED_MS = 5_000;
/** How long a command waits for its stopped sync to end once its time is up (A852). */
const LATE_SYNC_MS = 5_000;
/** Resolves after `ms`, without keeping the process alive for it. */
const sleep = (ms: number) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** A git failure as the CLI reports it: an exit code, the host's words, what to do. */
/**
 * The CLI's error for `error`. `adding`: it ended a `notebook add`, which rolled back, so advice
 * names add again, never a command on the notebook that is not there (#198).
 */
export function cliError(error: unknown, name: string, adding = false): unknown {
  if (error instanceof GitTransportError) {
    const exit =
      error.code === 'auth'
        ? EXIT.AUTH
        : error.code === 'not_found'
          ? EXIT.NOT_FOUND
          : error.code === 'protected' || error.code === 'rules' || error.code === 'refused'
            ? EXIT.REFUSED
            : EXIT.ERROR;
    const hints: string[] = [];
    if (error.hostMessage) hints.push(...error.hostMessage.split('\n').map((line) => `  ${line}`));
    if (error.code === 'auth') {
      hints.push(
        `Check git's credentials for this host, or save a personal access token: penmoss notebook token ${name} -`,
      );
    }
    if (error.code === 'signing') {
      hints.push(`To commit unsigned from now on: penmoss notebook set ${name} --no-sign`);
    }
    if (error.code === 'host_key') {
      hints.push(
        'Check the host key: connect once with ssh to the host and compare its fingerprint with the one the host publishes, then try again.',
      );
    }
    const said = error.hostMessage ?? error.message;
    if (adding) {
      if (privateEmailAdvice(said, '')) {
        hints.push(
          "GitHub refused the push: its commits would make your private email address public (GH007). Nothing was added: run the same penmoss notebook add again with --author-email <that address>, your GitHub no-reply address (the one ending in @users.noreply.github.com in GitHub's Settings → Emails).",
        );
      }
    } else {
      const advice = privateEmailAdvice(
        said,
        `penmoss notebook set ${name} --author-email <that address>`,
      );
      if (advice) hints.push(advice);
    }
    if (
      !adding &&
      (error.code === 'protected' || error.code === 'rules' || error.code === 'refused')
    ) {
      hints.push(
        'Nothing is lost: the changes stay here and go with the next sync that is allowed.',
      );
    }
    return new CliError(exit, error.message, `git_${error.code}`, undefined, hints);
  }
  if (error instanceof NotebookError) {
    const exit =
      error.code === 'no_notebook'
        ? EXIT.NOT_FOUND
        : error.code === 'busy'
          ? EXIT.ERROR
          : EXIT.REFUSED;
    const hints =
      error.code === 'branch_gone'
        ? [
            `If the branch was renamed, add the notebook again with --branch <the new name> (remove this one first: penmoss notebook remove ${name}).`,
          ]
        : [];
    return new CliError(exit, error.message, error.code, undefined, hints);
  }
  if (error instanceof LockHeldError)
    return new CliError(EXIT.CONFLICT, error.message, 'notebook_busy');
  return error;
}

export function nodeNotebooks(options: NodeNotebooksOptions): NotebookIo {
  const home = options.home;
  const registryPath = join(home, 'notebooks.json');
  const secrets: TokenStore =
    options.secrets ??
    nodeTokenStore({
      platform: options.platform,
      env: options.env,
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
      service: 'penmoss-git',
      file: join(home, 'credentials.json'),
      accepts: (secret) => SECRET.test(secret),
    });
  const cloneDir = (entry: { localId: string }) => join(home, 'git', entry.localId);
  /** Set by `penmoss mcp`: nobody at a terminal answers for it, whatever stdin is. */
  let unattended = false;
  const attended = () => !unattended && (options.terminal?.() ?? false);
  const gitDir = (entry: { localId: string }) => join(cloneDir(entry), 'repo.git');

  async function readRegistry(): Promise<Registry> {
    const text = await readFile(registryPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (text === null) return { version: 1, notebooks: [] };
    const parsed = JSON.parse(text) as Partial<Registry>;
    const notebooks = Array.isArray(parsed.notebooks) ? parsed.notebooks : [];
    // An older registry's confirmations (`confirmedPrivate`, gone with D51) and visibility
    // answers (gone with D61) are read and dropped, so the next write leaves them out (A1081).
    return {
      version: 1,
      notebooks: notebooks.map((each) => {
        if (!('confirmedPrivate' in each) && !('visibility' in each)) return each;
        const rest: StoredNotebook & { confirmedPrivate?: unknown; visibility?: unknown } = {
          ...each,
        };
        delete rest.confirmedPrivate;
        delete rest.visibility;
        return rest;
      }),
    };
  }

  async function writeRegistry(registry: Registry): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700).catch(() => undefined);
    const temporary = `${registryPath}.${process.pid}.tmp`;
    await rm(temporary, { force: true });
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    await rename(temporary, registryPath);
  }

  /** Changes `notebooks.json` under its own lock, so two commands never lose each other's. */
  async function changeRegistry(change: (registry: Registry) => Registry): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = await lockNotebook(home, 'penmoss (notebooks.json)', {
        file: 'notebooks.lock',
        waitMs: options.lockWaitMs ?? 10_000,
        pollMs: 20,
      });
    } catch (error) {
      throw cliError(error, 'notebooks.json');
    }
    try {
      await writeRegistry(change(await readRegistry()));
    } finally {
      await lock.release();
    }
  }

  async function find(name: string): Promise<StoredNotebook> {
    const found = (await readRegistry()).notebooks.find((each) => each.name === name);
    if (!found) {
      throw new CliError(
        EXIT.NOT_FOUND,
        `No git notebook named “${name}” on this machine.`,
        'notebook_not_found',
        undefined,
        ['List them with penmoss notebook ls, or add one with penmoss notebook add <remote>.'],
      );
    }
    return found;
  }

  /**
   * The clone `--notebook <name>` names (D52): its own name, else its notebook's (`notebook.json`'s,
   * which the Mac app shows and its Copy Agent Reference gives: “Quanta”), exactly, then ignoring
   * case. Of several clones of that notebook, `prefer`'s writer kind comes first (an agent's for
   * `penmoss mcp`, a device's for a person's commands), then the Mac app's own agent clone, then
   * the earliest added. Two notebooks
   * of that name are refused: the clone's own name says which.
   */
  async function resolve(name: string, prefer: 'agent' | 'device'): Promise<StoredNotebook> {
    const all = (await readRegistry()).notebooks;
    const own = all.find((each) => each.name === name);
    if (own) return own;
    const folded = name.toLowerCase();
    // A name the notebook had before a Rename (Ryan's review of PR #192) still finds it, so an
    // agent's MCP config keeps working; a notebook named that now comes first.
    const formerly = (each: StoredNotebook, match: (former: string) => boolean) =>
      (each.formerNames ?? []).some(match);
    const matches =
      [
        all.filter((each) => each.notebookName === name),
        all.filter((each) => each.notebookName?.toLowerCase() === folded),
        all.filter((each) => formerly(each, (former) => former === name)),
        all.filter((each) => formerly(each, (former) => former.toLowerCase() === folded)),
      ].find((list) => list.length > 0) ?? [];
    if (new Set(matches.map((each) => each.notebookId)).size > 1) {
      throw new CliError(
        EXIT.USAGE,
        `Several git notebooks on this machine are named “${name}”.`,
        'notebook_ambiguous',
        { names: matches.map((each) => each.name) },
        [`Pass the clone's own name: ${matches.map((each) => each.name).join(', ')}.`],
      );
    }
    const rank = (each: StoredNotebook) =>
      (each.writer.kind === prefer ? 0 : 2) + (each.automatic ? 0 : 1);
    const best = [...matches].sort(
      (a, b) => rank(a) - rank(b) || a.added.localeCompare(b.added),
    )[0];
    return best ?? find(name);
  }

  async function update(
    name: string,
    change: (entry: StoredNotebook) => StoredNotebook,
  ): Promise<void> {
    await changeRegistry((registry) => ({
      version: 1,
      notebooks: registry.notebooks.map((each) => (each.name === name ? change(each) : each)),
    }));
  }

  const tokenKey = (entry: { localId: string }) => `token:${entry.localId}`;
  const writerKey = (entry: { localId: string }) => `writer:${entry.localId}`;

  /**
   * The notebook's token: its own saved one, else PENMOSS_GIT_TOKEN, which is only for
   * PENMOSS_GIT_TOKEN_HOST's repositories (github.com unless set), never sent to another host.
   */
  async function tokenOf(entry: { localId: string; remote: string }): Promise<string | null> {
    const saved = (await secrets.get(tokenKey(entry)).catch(() => null))?.token ?? null;
    if (saved) return saved;
    const fromEnv = options.env['PENMOSS_GIT_TOKEN']?.trim();
    const host = (options.env['PENMOSS_GIT_TOKEN_HOST']?.trim() || 'github.com').toLowerCase();
    const parts = remoteParts(entry.remote);
    return fromEnv && parts && parts.protocol !== 'file' && parts.host === host ? fromEnv : null;
  }

  function writerSecrets(entry: { localId: string }): WriterSecrets {
    return {
      get: async () => (await secrets.get(writerKey(entry)))?.token ?? null,
      set: async (secret) => {
        await secrets.set(writerKey(entry), secret, 'auto');
      },
    };
  }

  function transportFor(
    entry: StoredNotebook | (NotebookEntry & { author: StoredNotebook['author'] }),
  ) {
    return new NodeGitTransport({
      gitDir: gitDir(entry),
      remote: entry.remote,
      branch: entry.branch,
      root: entry.dir ? `${entry.dir}/` : '',
      // Asked before each commit: the notebook's own, read from the registry again (a
      // `notebook set` from another terminal reaches a running `penmoss mcp`, #174 review),
      // else git's identity now (#170 F3, F6).
      author: async () => {
        const now = (await readRegistry().catch(() => null))?.notebooks.find(
          (each) => each.localId === entry.localId,
        );
        const identity = now ? now.identity : 'identity' in entry ? entry.identity : undefined;
        return identity ?? gitIdentity(entry.writer.label);
      },
      token: () => tokenOf(entry),
      ...('tokenUser' in entry && entry.tokenUser ? { tokenUser: entry.tokenUser } : {}),
      ...('sign' in entry && entry.sign === false ? { sign: false } : {}),
      ...(attended() ? {} : { signTimeoutMs: SIGN_UNATTENDED_MS }),
      ...(options.gitEnv ? { env: options.gitEnv } : {}),
    });
  }

  async function engineFor(
    entry: StoredNotebook,
    create?: { id: string; name: string; salt?: string },
  ): Promise<{ engine: GitNotebookEngine; transport: NodeGitTransport; storage: FileStorage }> {
    const transport = transportFor(entry);
    await transport.init();
    const storage = new FileStorage(cloneDir(entry));
    const engine = await GitNotebookEngine.open({
      transport,
      storage,
      secrets: writerSecrets(entry),
      writer: entry.writer,
      ...(create ? { create } : {}),
    });
    return { engine, transport, storage };
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

  function summary(
    name: string,
    report: SyncReport,
    transport: NodeGitTransport,
  ): NotebookSyncSummary {
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

  async function syncEngine(
    entry: StoredNotebook,
    opened: { engine: GitNotebookEngine; transport: NodeGitTransport },
    full = false,
    signal?: AbortSignal,
    adding = false,
  ): Promise<NotebookSyncSummary> {
    checkRemote(entry);
    try {
      const report = await opened.engine.sync({ full, ...(signal ? { signal } : {}) });
      const info = opened.engine.info;
      const filterIgnored = opened.transport.notes.filterIgnored;
      if (
        info &&
        (info.id !== entry.notebookId ||
          info.name !== entry.notebookName ||
          filterIgnored !== (entry.filterIgnored ?? false))
      ) {
        await update(entry.name, (each) => ({
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

  async function withLock<T>(
    entry: StoredNotebook,
    what: string,
    run: () => Promise<T>,
    waitMs = options.lockWaitMs ?? 10_000,
  ): Promise<T> {
    let lock;
    try {
      lock = await lockNotebook(cloneDir(entry), what, { waitMs });
    } catch (error) {
      throw cliError(error, entry.name);
    }
    try {
      return await run();
    } finally {
      await lock.release();
    }
  }

  async function gitIdentity(label: string): Promise<{ name: string; email: string }> {
    const git = gitRunner({ env: { GIT_DIR: undefined, ...options.gitEnv } });
    // The person's own identity (global, then system config), never the repository the command
    // happens to run in (#165).
    const read = async (key: string) => {
      for (const scope of ['--global', '--system']) {
        try {
          const value = (await git(['config', scope, '--get', key], { ok: [0, 1] })).stdout
            .toString('utf8')
            .trim();
          if (value) return value;
        } catch {
          // No such config file: the next scope.
        }
      }
      return '';
    };
    const name = (await read('user.name')) || label;
    const email = (await read('user.email')) || 'penmoss@localhost';
    return { name, email };
  }

  return {
    async list() {
      return (await readRegistry()).notebooks.map(publicEntry);
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
      if (input.tokenUser !== undefined && !TOKEN_USER.test(input.tokenUser)) {
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
      const registry = await readRegistry();
      const localId = ulid();
      const label = input.agent?.trim() || hostname();
      const author = await gitIdentity(label);
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
      if (registry.notebooks.some((each) => each.name === wanted)) {
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
      await mkdir(cloneDir(entry), { recursive: true, mode: 0o700 });
      if (input.token) await secrets.set(tokenKey(entry), input.token, 'auto');
      const cleanUp = async () => {
        await rm(cloneDir(entry), { recursive: true, force: true });
        await secrets.delete(tokenKey(entry)).catch(() => undefined);
        await secrets.delete(writerKey(entry)).catch(() => undefined);
      };
      try {
        const stored: StoredNotebook = entry;
        const transport = transportFor(stored);
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
        await changeRegistry((now) => {
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
          const synced = await withLock(stored, 'penmoss notebook add', async () => {
            const opened = await engineFor(stored, created);
            try {
              return await syncEngine(stored, opened, false, undefined, true);
            } finally {
              await opened.engine.save();
            }
          });
          const final = await find(stored.name);
          return {
            entry: publicEntry(final),
            created: !exists,
            sync: synced,
          };
        } catch (error) {
          await changeRegistry((after) => ({
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
      const entry = await find(name);
      await withLock(entry, 'penmoss notebook remove', async () => {
        const meta = (await new FileStorage(cloneDir(entry)).load())?.meta;
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
      await rm(cloneDir(entry), { recursive: true, force: true });
      await secrets.delete(tokenKey(entry)).catch(() => undefined);
      await secrets.delete(writerKey(entry)).catch(() => undefined);
      await changeRegistry((registry) => ({
        version: 1,
        notebooks: registry.notebooks.filter((each) => each.localId !== entry.localId),
      }));
      return publicEntry(entry);
    },

    async set(name, change) {
      await find(name);
      await update(name, (each) => {
        const next: { -readonly [K in keyof StoredNotebook]: StoredNotebook[K] } = { ...each };
        if (change.sign === false) next.sign = false;
        else if (change.sign === true) delete next.sign;
        if (change.author === null) delete next.identity;
        else if (change.author) next.identity = change.author;
        return change.notebookName ? renamedTo(next, change.notebookName) : next;
      });
    },

    async setToken(name, token) {
      const entry = await find(name);
      if (token === null) await secrets.delete(tokenKey(entry));
      else await secrets.set(tokenKey(entry), token, 'auto');
    },

    async status(asked): Promise<NotebookStatus> {
      const entry = await resolve(asked, 'device');
      const storage = new FileStorage(cloneDir(entry));
      const snapshot = await storage.load();
      const meta = snapshot?.meta;
      const transport = transportFor(entry);
      const cloneBytes = await (async () => {
        try {
          await stat(gitDir(entry));
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
          : { ...(await gitIdentity(entry.writer.label)), own: false },
        writerId: meta?.writer?.id ?? null,
        lastHead: meta?.lastHead ?? null,
        unsynced: meta ? Object.keys(meta.dirty).length + (meta.workspaceDirty ? 1 : 0) : 0,
        notes: snapshot?.notes.size ?? 0,
        cloneBytes,
        stateBytes: await storage.bytes(),
        token: (await secrets.get(tokenKey(entry)).catch(() => null))
          ? 'saved'
          : (await tokenOf(entry)) !== null
            ? 'environment'
            : null,
        filterIgnored: entry.filterIgnored ?? false,
      };
    },

    async sync(asked, syncOptions = {}) {
      const entry = await resolve(asked, 'device');
      return withLock(
        entry,
        'penmoss notebook sync',
        async () => {
          const opened = await engineFor(entry);
          try {
            return await syncEngine(entry, opened, syncOptions.full === true);
          } finally {
            await opened.engine.save();
          }
        },
        syncOptions.waitMs,
      );
    },

    async session(asked, what) {
      const entry = await resolve(asked, 'device');
      const name = entry.name;
      let lock;
      try {
        lock = await lockNotebook(cloneDir(entry), what, { waitMs: options.lockWaitMs ?? 10_000 });
      } catch (error) {
        throw cliError(error, name);
      }
      let opened;
      try {
        opened = await engineFor(entry);
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
          await syncEngine(entry, engine);
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
            ...(cache.claim ? { claim: (keys) => cache.claim!(cloneDir(entry), keys) } : {}),
          });
        },
        // Every change is on disk before its reply (B1 of #165): a command killed during the
        // sync that follows loses nothing; the next sync sends it.
        fetch: localFetch(notebook, () => engine.engine.save()),
        sync: async (syncOptions = {}) => {
          const timeoutMs = syncOptions.timeoutMs;
          if (timeoutMs === undefined) return syncEngine(entry, engine);
          // A command's own sync is bounded (A852): on a network that drops connections a fetch
          // can wait minutes, and an agent's Bash call would hang with it. Stopped is stopped:
          // the engine makes no git call after the signal (a cancel between two calls was lost).
          const stop = new AbortController();
          let timer: ReturnType<typeof setTimeout> | null = null;
          const running = syncEngine(entry, engine, false, stop.signal);
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
        detachedLog: join(cloneDir(entry), 'detached-sync.log'),
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
      unattended = true;
      const entry = await resolve(asked, 'agent');
      const name = entry.name;
      const channelMode = serveOptions.channel !== undefined;
      // In channel mode the clone's own writes go at once (A1063): a reply is waited for.
      const pushDelay = channelMode ? 0 : (options.pushDelayMs ?? 60_000);
      const pullEvery = options.pullEveryMs ?? 120_000;
      let state: {
        engine: GitNotebookEngine;
        transport: NodeGitTransport;
        storage: FileStorage;
        notebook: LocalNotebook;
        generation: number;
      } | null = null;
      // Edits a stopped server left unsynced (its detached sync may have failed) go first.
      const saved = (await new FileStorage(cloneDir(entry)).load().catch(() => null))?.meta;
      let pending = saved ? Object.keys(saved.dirty).length > 0 || saved.workspaceDirty : false;
      let pushTimer: ReturnType<typeof setTimeout> | null = null;
      let queue: Promise<unknown> = Promise.resolve();
      // Search by meaning (A1156, A1157): with the model here and the setting on, the tools say
      // so from the start; the model opens in a worker thread in the background.
      const meaningStatus = options.meaning
        ? await options.meaning.status().catch(() => null)
        : null;
      const meaningOn = meaningStatus?.enabled === true && meaningStatus.state === 'ready';
      // Set once the model opens, so not narrowed to its first value.
      let meaning = null as {
        opened: OpenedMeaning;
        index: MeaningIndex;
        /** Tries for the indexing lease for as long as the model is open (A1350). */
        keeper: LeaseKeeper;
        holder: boolean;
      } | null;
      const giveMeaning = (notebook: LocalNotebook) => {
        if (!meaning) return;
        notebook.useMeaning({
          index: meaning.index,
          budgetMs: meaning.holder ? 0 : MCP_MEANING_BUDGET_MS,
        });
      };
      /** One thing at a time, under the clone's lock, on the latest state on disk. */
      const exclusive = <T>(
        what: string,
        run: (current: NonNullable<typeof state>) => Promise<T>,
      ): Promise<T> => {
        const next = queue.then(() =>
          withLock(
            entry,
            what,
            async () => {
              const storage = new FileStorage(cloneDir(entry));
              const generation = await storage.generation();
              if (!state || state.generation !== generation) {
                const opened = await engineFor(entry);
                state = {
                  ...opened,
                  // save_version commits now (G6), through the same checks as any sync (A841).
                  notebook: new LocalNotebook(
                    new NotebookOps(opened.engine),
                    Date.now,
                    async () => {
                      await syncEngine(entry, opened);
                    },
                    { side: 'mcp' },
                  ),
                  generation,
                };
                giveMeaning(state.notebook);
              }
              const current = state;
              try {
                return await run(current);
              } finally {
                await current.engine.save();
                current.generation = await current.storage.generation();
              }
            },
            30_000,
          ),
        );
        queue = next.catch(() => undefined);
        return next;
      };
      const sync = (why: string) =>
        exclusive(`penmoss mcp (${why})`, async (current) => {
          const done = await syncEngine(entry, current);
          const meta = current.engine.replica.state;
          pending = Object.keys(meta.dirty).length > 0 || meta.workspaceDirty;
          for (const warning of done.warnings) io.log(`penmoss: ${warning}`);
          for (const [path, why] of Object.entries(done.skipped)) {
            io.log(`penmoss: skipped ${path}: ${why}`);
          }
          if (done.copies.length > 0) {
            io.log(`penmoss: left alone, copies of notes made by hand: ${done.copies.join(', ')}`);
          }
          return done;
        }).catch((error: unknown) => {
          io.log(
            `penmoss: could not sync ${name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      /** Tool calls wait for the model to open (once, about two seconds), so meaning answers. */
      let modelOpened: Promise<void> = Promise.resolve();
      /**
       * Settings → Search by Meaning switched off while serving (A1158): the model closes and the
       * tools answer by words (the app removes the model and the vectors).
       */
      const meaningStillOn = async () => {
        const current = meaning;
        if (!current) return;
        const status = await options.meaning!.status().catch(() => null);
        if (status?.enabled && status.state === 'ready') return;
        if (meaning !== current) return;
        // The background indexing stops with it: its next slice finds no model.
        meaning = null;
        (state as { notebook: LocalNotebook } | null)?.notebook.useMeaning(null);
        io.log(`penmoss: Search by Meaning is off: searching ${name} by words only`);
        await current.keeper.stop();
        await current.opened.close();
      };
      const access: NotebookAccess = {
        use: async (write, run) => {
          await modelOpened;
          await meaningStillOn();
          return exclusive('penmoss mcp', async (current) => {
            const out = await run(current.notebook);
            if (write) {
              pending = true;
              if (pushTimer) clearTimeout(pushTimer);
              pushTimer = setTimeout(() => void sync('push'), pushDelay);
              // An agent's edit is found by meaning a moment after it settles (A1160).
              indexSoon(EDIT_INDEX_DELAY_MS);
            }
            return out;
          });
        },
      };
      // The channel (T60, A1063): its session entry, the head check and delivery.
      let channel: CommentChannel | null = null;
      /** A sync went through: only then is the remote asked. */
      let syncedOnce = false;
      if (serveOptions.channel) {
        const cwd = process.cwd();
        const sessionName = serveOptions.channel.name ?? `${hostname()}:${cwd}`;
        const heads = transportFor(entry);
        channel = new CommentChannel(
          {
            use: (write, run) => access.use(write, run),
            remoteHead: () =>
              syncedOnce
                ? heads.remoteHead()
                : Promise.reject(new Error('the notebook has not synced yet')),
            sync: (why) => sync(why),
            notify: (message) => io.write(JSON.stringify(message)),
            log: (text) => io.log(text),
          },
          {
            name: sessionName,
            label: `${entry.writer.label} · ${serveOptions.channel.name ?? (basename(cwd) || cwd)}`,
            host: hostname(),
          },
        );
      }
      const server = new LocalMcpServer(access, name, (text) => io.log(text), {
        meaning: meaningOn,
        // A short reference of another notebook on this machine (PEN-69): its name, for the
        // refusal to say which server reads it.
        notebookNamed: async (tag) => {
          const other = (await readRegistry()).notebooks.find(
            (each) => each.notebookId !== undefined && notebookTag(each.notebookId) === tag,
          );
          return other ? (other.notebookName ?? other.name) : null;
        },
        ...(channel
          ? {
              channel: true,
              instructions: `${meaningOn ? LOCAL_MEANING_INSTRUCTIONS : LOCAL_INSTRUCTIONS}\n${CHANNEL_INSTRUCTIONS}`,
              onInitialized: () => {
                channel.start();
                void channel.tick();
              },
            }
          : {}),
      });
      // A sync at once, so the agent starts from what other writers pushed (#165); a channel then
      // lists its session (A1060).
      const started = sync('start').then(async (done) => {
        if (done) syncedOnce = true;
        await channel?.heartbeat().catch((error: unknown) => {
          io.log(
            `penmoss: could not list this session in ${name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      });
      void started;
      // The holder of the lease indexes this notebook in the background, a slice at a time. It
      // never compacts: the cache is every notebook's, and the app's service compacts, keeping
      // what each notebook's claim names (PEN-134).
      let indexTimer: ReturnType<typeof setTimeout> | null = null;
      let serving = true;
      const indexSoon = (ms: number) => {
        if (!serving || !meaning?.holder) return;
        if (indexTimer) clearTimeout(indexTimer);
        indexTimer = setTimeout(() => void indexSlice(), ms);
        indexTimer.unref?.();
      };
      const indexSlice = async () => {
        const current = meaning;
        if (!current || !serving) return;
        try {
          // The app's service may have taken the lease (A1350): then this one only searches.
          if (!(await current.keeper.check())) return;
          const notes = await access.use(false, (notebook) => notebook.meaningNotes());
          await current.index.update(notes, { budgetMs: INDEX_SLICE_MS, batch: 2 });
          indexSoon(current.index.waiting > 0 ? 0 : (options.indexEveryMs ?? INDEX_EVERY_MS));
        } catch (error) {
          io.log(
            `penmoss: indexing for meaning stopped: ${error instanceof Error ? error.message : String(error)}`,
          );
          indexSoon(options.indexEveryMs ?? INDEX_EVERY_MS);
        }
      };
      // Whoever holds the lease, this notebook claims the vectors its notes use, so the app's
      // compaction keeps them though the app may never open this notebook (PEN-134).
      let claimTimer: ReturnType<typeof setInterval> | null = null;
      const claimUsed = async () => {
        const current = meaning;
        const claim = current?.opened.cache.claim?.bind(current.opened.cache);
        if (!current || !claim || !serving) return;
        try {
          const notes = await access.use(false, (notebook) => notebook.meaningNotes());
          await current.index.update(notes, { embed: false });
          await claim(cloneDir(entry), current.index.usedKeys());
        } catch (error) {
          io.log(
            `penmoss: could not claim ${name}'s vectors: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      const opening = meaningOn
        ? (async () => {
            try {
              const opened = await options.meaning!.open('mcp', { thread: true });
              if (!opened) return;
              if (!serving) {
                await opened.close();
                return;
              }
              // Tried for at once and again every retryMs, so a holder that dies or quits is
              // replaced: one try at the start left nobody indexing once the app quit (A1350).
              const next: NonNullable<typeof meaning> = {
                opened,
                index: new MeaningIndex(opened.embedder, opened.cache),
                holder: false,
                keeper: new LeaseKeeper(() => opened.lease(), {
                  retryMs: options.leaseRetryMs ?? LEASE_RETRY_MS,
                  onChange: (held) => {
                    if (meaning !== next) return;
                    next.holder = held;
                    const current = state as { notebook: LocalNotebook } | null;
                    if (current) giveMeaning(current.notebook);
                    if (held) {
                      io.log(`penmoss: indexing ${name} for meaning`);
                      indexSoon(0);
                    } else {
                      io.log(`penmoss: another process indexes for meaning now`);
                      if (indexTimer) clearTimeout(indexTimer);
                      indexTimer = null;
                    }
                  },
                  log: (text) => io.log(`penmoss: ${text}`),
                }),
              };
              meaning = next;
              await next.keeper.start();
              const current = state as { notebook: LocalNotebook } | null;
              if (current && meaning === next) giveMeaning(current.notebook);
              indexSoon(0);
              void claimUsed();
              claimTimer = setInterval(
                () => void claimUsed(),
                options.claimEveryMs ?? CLAIM_EVERY_MS,
              );
              claimTimer.unref?.();
            } catch (error) {
              io.log(
                `penmoss: searching ${name} by words only: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          })()
        : null;
      if (opening) modelOpened = opening;
      const puller = setInterval(() => void sync('pull'), pullEvery);
      const checker = channel
        ? setInterval(
            () =>
              void channel.tick().catch((error: unknown) => io.log(`penmoss: ${String(error)}`)),
            options.channelCheckMs ?? CHANNEL_CHECK_MS,
          )
        : null;
      const heartbeat = channel
        ? setInterval(
            () =>
              void channel
                .heartbeat()
                .catch((error: unknown) => io.log(`penmoss: ${String(error)}`)),
            options.heartbeatMs ?? HEARTBEAT_MS,
          )
        : null;
      // Set by the signal's callback, so not narrowed to its first value.
      let stoppedBy = null as string | null;
      const stop = io.stopped?.then((signal) => {
        stoppedBy = signal;
        return null;
      });
      const lines = io.lines[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await (stop ? Promise.race([lines.next(), stop]) : lines.next());
          if (next === null || next.done) break;
          // A signal waits for the call in hand: its reply, and its edit marked pending.
          const reply = await server.line(next.value);
          if (reply !== null) io.write(reply);
        }
      } finally {
        clearInterval(puller);
        channel?.stop();
        if (checker) clearInterval(checker);
        if (heartbeat) clearInterval(heartbeat);
        if (pushTimer) clearTimeout(pushTimer);
        if (stoppedBy !== null) void lines.return?.();
        serving = false;
        if (indexTimer) clearTimeout(indexTimer);
        if (claimTimer) clearInterval(claimTimer);
        await opening;
        await meaning?.keeper.stop();
        await meaning?.opened.close();
      }
      // On exit, what is left goes (A825). An agent's client stops its server by closing stdin or
      // with a signal, and kills it moments later (Claude Code: stdin closed, SIGINT, SIGTERM, then
      // SIGKILL within half a second), too soon to push, so a detached `penmoss notebook sync`
      // does it, once this process lets go of the lock or dies holding it (A847). The edits are on
      // disk either way. Only where nothing can be detached does this process push itself.
      // Detached first: waiting for queued work (a lock, a sync) could outlast the kill.
      if (pending) {
        const args = ['notebook', 'sync', name, '--wait', String(DETACHED_SYNC_WAIT_S)];
        if (io.detach?.(args, join(cloneDir(entry), 'detached-sync.log'))) {
          io.log(
            `penmoss: ${stoppedBy !== null ? `stopped by ${stoppedBy}` : 'stdin closed'}: syncing ${name} in the background (log: ${join(cloneDir(entry), 'detached-sync.log')})`,
          );
          await queue;
          return;
        }
      }
      await queue;
      if (pending) await sync('exit');
    },
  };
}

/** How many former names a clone keeps (Ryan's review of PR #192). */
export const MAX_FORMER_NAMES = 5;

/**
 * A clone whose notebook is now called `name`: the name it had joins its former names (the
 * latest last, at most MAX_FORMER_NAMES), so `--notebook <old name>` still finds it.
 */
export function renamedTo<T extends NotebookEntry>(entry: T, name: string): T {
  if (entry.notebookName === name) return entry;
  const former = [...(entry.formerNames ?? []), ...(entry.notebookName ? [entry.notebookName] : [])]
    .filter((each, at, all) => each !== name && all.lastIndexOf(each) === at)
    .slice(-MAX_FORMER_NAMES);
  const next: T = { ...entry, notebookName: name, formerNames: former };
  if (former.length === 0) delete (next as { formerNames?: readonly string[] }).formerNames;
  return next;
}

function publicEntry(entry: StoredNotebook): NotebookEntry {
  return {
    name: entry.name,
    localId: entry.localId,
    remote: redactRemote(entry.remote),
    branch: entry.branch,
    dir: entry.dir,
    writer: entry.writer,
    ...(entry.notebookId ? { notebookId: entry.notebookId } : {}),
    ...(entry.notebookName ? { notebookName: entry.notebookName } : {}),
    ...(entry.formerNames?.length ? { formerNames: entry.formerNames } : {}),
    ...(entry.automatic ? { automatic: true as const } : {}),
  };
}
