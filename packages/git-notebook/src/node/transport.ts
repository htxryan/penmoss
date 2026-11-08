/**
 * `GitTransport` over system git (T50 G2, #150; A824): what the CLI, the local MCP and (in G3)
 * the Mac app's main process use. Any host, HTTPS or SSH, with git's own credential helpers, or a
 * personal access token through `GIT_ASKPASS` (never argv, never the URL).
 *
 * The clone is a bare partial clone (`--filter=blob:none`) with no working tree at all (G0's
 * change 4): commits are built with plumbing in a temporary index on the fetched remote head, and
 * reads go through `cat-file` after one batched fetch of the blobs that are missing. So only what
 * the engine reads is ever downloaded (a directory target in a big code repository fetches its
 * trees and the notebook's own blobs), nothing is ever checked out, and no merge, rebase or
 * checkout of local work can run. The clone is disposable: deleting it loses nothing that the
 * notebook's own state does not hold.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitTransportError,
  type CommitInfo,
  type GitTransport,
  type PushOutcome,
} from '../transport';
import {
  gitError,
  gitRunner,
  LOCAL_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
  preflight,
  type GitRunner,
  type RunOptions,
} from './git';

/** A commit's author and committer. */
export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface NodeGitTransportOptions {
  /** The clone's git directory (created by `init`). */
  readonly gitDir: string;
  /** The remote: an HTTPS, SSH or `file://` URL. */
  readonly remote: string;
  readonly branch: string;
  /** `docs/notes/` (with the slash) or '' for the repository's top. */
  readonly root: string;
  /**
   * Who commits: the device's git identity (A825), or the notebook's own (#170 F6). A function is
   * asked before each commit, so a changed `user.email` applies to the next one (#170 F3).
   */
  readonly author: GitAuthor | (() => Promise<GitAuthor>);
  /**
   * A personal access token for HTTPS, when one is set for this notebook: given to git through
   * `GIT_ASKPASS`, with git's credential helpers turned off for these calls so a stale stored
   * password never wins. Without it, git's own helpers and SSH keys are used.
   */
  readonly token?: () => Promise<string | null>;
  /** The user name sent with the token (default `x-access-token`, which github.com expects). */
  readonly tokenUser?: string;
  /** Extra environment for every git call (the tests isolate git's config with it). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly gitPath?: string;
  readonly platform?: NodeJS.Platform;
  /** Loose objects before `git gc --auto` packs them (G0: 91 MB unpacked after 1,000 commits). */
  readonly gcAuto?: number;
  /**
   * Sign commits as git's own configuration says (`commit.gpgSign`, `gpg.format`, the signing
   * key), as #147 asks; false never signs (`notebook add --no-sign`). Default true.
   */
  readonly sign?: boolean;
  /**
   * How long signing may take. A signer can wait for a person (pinentry, 1Password, Touch ID):
   * where nobody can answer (the local MCP, a detached sync, no terminal), keep this short, so it
   * fails as `signing` instead of holding the clone's lock for a minute. Default 60 s.
   */
  readonly signTimeoutMs?: number;
}

/** What a fetch noticed, for Status and `penmoss notebook status`. */
export interface FetchNotes {
  /** The server ignored `--filter`, so the clone holds every blob (a full clone, A824). */
  filterIgnored: boolean;
}

const BLOB_BATCH = 2_000;

/** The calls queued on each clone, by its git directory (#170 F2). */
const queues = new Map<string, Promise<void>>();

export class NodeGitTransport implements GitTransport {
  readonly root: string;
  readonly notes: FetchNotes = { filterIgnored: false };
  private readonly git: GitRunner;
  private readonly ref: string;
  private listed: { head: string; files: Map<string, string> } | null = null;
  private checked = false;
  /** Aborted by `cancel`: stops every git this transport runs (A852). */
  private stop = new AbortController();

  constructor(private readonly options: NodeGitTransportOptions) {
    this.root = options.root;
    this.ref = `refs/remotes/origin/${options.branch}`;
    const run = gitRunner({
      ...(options.gitPath ? { gitPath: options.gitPath } : {}),
      env: { ...options.env, GIT_DIR: options.gitDir },
    });
    this.git = (args, runOptions = {}) => run(args, { ...runOptions, signal: this.stop.signal });
    if (options.root && !options.root.endsWith('/')) {
      throw new Error(`root must end with a slash: ${options.root}`);
    }
  }

  /**
   * Creates the clone's git directory if it is not there: a bare repository whose `origin` is a
   * promisor remote, so a blob the engine reads is fetched on demand. Nothing is downloaded yet.
   */
  init(): Promise<void> {
    this.initialised ??= this.exclusive(() => this.initNow()).catch((error: unknown) => {
      this.initialised = null;
      throw error;
    });
    return this.initialised;
  }

  private initialised: Promise<void> | null = null;

  /**
   * Runs `work` once no other writing call on this clone runs (#170 F2): git's own lock on the
   * clone's config (`config.lock`), and on its refs, refuses a second writer rather than waiting,
   * so two at once could fail. The calls that write the clone's refs or config (init, fetch,
   * commit, push, gc, the target check) queue per clone, across transports in this process; a
   * `cancel` stops the queued ones too. Reads (list, read, sizes, changed, log, readAt, head,
   * storeBytes) never queue (#174 review): History and Status do not wait for a fetch. A blob a
   * read lacks is fetched into the object store, which never touches a ref or the config.
   */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const signal = this.stop.signal;
    const before = queues.get(this.options.gitDir) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const chained = before.then(() => mine);
    queues.set(this.options.gitDir, chained);
    try {
      await before;
      if (signal.aborted) {
        throw new GitTransportError('timeout', 'git was stopped: the sync ran out of time.');
      }
      return await work();
    } finally {
      release();
      if (queues.get(this.options.gitDir) === chained) queues.delete(this.options.gitDir);
    }
  }

  private async initNow(): Promise<void> {
    await this.preflight();
    const head = await stat(join(this.options.gitDir, 'HEAD')).catch(() => null);
    if (!head) {
      await mkdir(this.options.gitDir, { recursive: true });
      await this.git(['init', '--bare', '--quiet', '--template=', this.options.gitDir], {
        env: { GIT_DIR: undefined },
      });
    }
    await this.ensureConfig();
  }

  /**
   * The clone's settings, and the protections among them (no hooks, only these protocols, a
   * stalled transfer ends): what differs is written, nothing else (#170 F2). Run by `init` and
   * again before each fetch and push (#174 review), so a protection changed by hand is put back
   * before git talks to a host; the network's own calls also pass them on the command line.
   */
  private async ensureConfig(): Promise<void> {
    const settings: Array<[string, string]> = [
      ['core.repositoryformatversion', '1'],
      ['extensions.partialClone', 'origin'],
      ['remote.origin.url', this.options.remote],
      ['remote.origin.fetch', `+refs/heads/${this.options.branch}:${this.ref}`],
      ['remote.origin.promisor', 'true'],
      ['remote.origin.partialclonefilter', 'blob:none'],
      ['remote.origin.tagOpt', '--no-tags'],
      ['gc.auto', String(this.options.gcAuto ?? 1_000)],
      // gc in the foreground: a detached one would outlive the command and its lock.
      ['gc.autoDetach', 'false'],
      ['core.logAllRefUpdates', 'false'],
      ...this.protections(),
    ];
    // Only what differs is written (#170 F2): an unchanged clone's config is never rewritten.
    const listed = (await this.git(['config', '--local', '--list', '-z'], { ok: [0, 1] })).stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const now = new Map<string, string[]>();
    for (const entry of listed) {
      const newline = entry.indexOf('\n');
      const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
      now.set(key, [...(now.get(key) ?? []), newline < 0 ? '' : entry.slice(newline + 1)]);
    }
    for (const [key, value] of settings) {
      const has = now.get(key.toLowerCase());
      if (has?.length === 1 && has[0] === value) continue;
      await this.git(['config', '--replace-all', key, value]);
    }
    // Clones made before signing was honoured turned it off here.
    if (now.has('commit.gpgsign')) {
      await this.git(['config', '--unset-all', 'commit.gpgSign'], { ok: [0, 5] });
    }
  }

  /** What keeps a host, a hand edit or a hook from running anything: also given as `-c`. */
  private protections(): Array<[string, string]> {
    return [
      ['core.hooksPath', '/dev/null'],
      // Only these transports, whatever a remote or a promisor fetch names (no ext::, fd::).
      ['protocol.allow', 'never'],
      ['protocol.https.allow', 'always'],
      ['protocol.ssh.allow', 'always'],
      ['protocol.file.allow', 'always'],
      // Plain http only when the remote itself is http (a host on this machine's network).
      ['protocol.http.allow', /^http:\/\//i.test(this.options.remote) ? 'always' : 'never'],
      // A transfer that stalls ends on its own, even if this process is gone (60 s under 1 KB/s).
      ['http.lowSpeedLimit', '1000'],
      ['http.lowSpeedTime', '60'],
    ];
  }

  private async preflight(): Promise<void> {
    if (this.checked) return;
    await preflight(this.options.platform, this.options.gitPath);
    this.checked = true;
  }

  /**
   * Runs a git command that talks to the host, with the token when there is one. git follows its
   * own configuration, rewrites (`url.<base>.insteadOf`, `pushInsteadOf`) included (D62).
   */
  private async network(given: readonly string[], options: RunOptions = {}) {
    await this.preflight();
    // The protections on the command line too, over anything the clone's config says now.
    const args = [
      ...this.protections().flatMap(([key, value]) => ['-c', `${key}=${value}`]),
      ...given,
    ];
    const token = (await this.options.token?.()) ?? null;
    if (token === null) {
      return this.git(args, { timeoutMs: NETWORK_TIMEOUT_MS, ...options });
    }
    const dir = join(this.options.gitDir, 'penmoss-askpass');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const script = join(dir, `askpass-${randomUUID()}.sh`);
    // The script holds no secret: it prints what git's environment gives it.
    await writeFile(
      script,
      '#!/bin/sh\ncase "$1" in\n  Username*|username*) printf "%s\\n" "$PENMOSS_GIT_USER" ;;\n  *) printf "%s\\n" "$PENMOSS_GIT_SECRET" ;;\nesac\n',
      { mode: 0o700 },
    );
    await chmod(script, 0o700);
    try {
      return await this.git(['-c', 'credential.helper=', ...args], {
        timeoutMs: NETWORK_TIMEOUT_MS,
        ...options,
        env: {
          ...options.env,
          GIT_ASKPASS: script,
          PENMOSS_GIT_USER: this.options.tokenUser ?? 'x-access-token',
          PENMOSS_GIT_SECRET: token,
        },
      });
    } finally {
      await rm(script, { force: true });
    }
  }

  fetch(): Promise<string | null> {
    return this.exclusive(() => this.fetchNow());
  }

  private async fetchNow(): Promise<string | null> {
    await this.ensureConfig();
    const result = await this.network(
      [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--recurse-submodules=no',
        '--filter=blob:none',
        'origin',
        `+refs/heads/${this.options.branch}:${this.ref}`,
      ],
      { ok: [0, 128] },
    );
    if (result.code === 128) {
      if (/couldn't find remote ref/i.test(result.stderr)) {
        // A new notebook on a new branch, or a branch deleted on the host.
        await this.git(['update-ref', '-d', this.ref], { ok: [0, 1] });
        return null;
      }
      throw gitError(['fetch'], result);
    }
    if (/filtering not recognized by server|filter.*ignor/i.test(result.stderr)) {
      this.notes.filterIgnored = true;
    }
    return this.revParse(this.ref);
  }

  private async revParse(ref: string): Promise<string | null> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      ok: [0, 1],
    });
    return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
  }

  list(head: string): Promise<ReadonlyMap<string, string>> {
    return this.listNow(head);
  }

  private async listNow(head: string): Promise<ReadonlyMap<string, string>> {
    if (this.listed?.head === head) return this.listed.files;
    const args = ['ls-tree', '-r', '-z', '--full-tree', head];
    if (this.root) args.push('--', this.root);
    const out = (await this.git(args)).stdout.toString('utf8');
    const files = new Map<string, string>();
    for (const entry of out.split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      const [, type, id] = entry.slice(0, tab).split(' ');
      if (type === 'blob') files.set(entry.slice(tab + 1), id!);
    }
    this.listed = { head, files };
    return files;
  }

  /**
   * The sizes of `paths` at `head`, so the engine never loads a huge log (A822). A partial clone
   * knows no size of a blob it lacks, so the missing ones are fetched first (in one batch, as a
   * read does); only their size is read here.
   */
  sizes(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return this.sizesNow(head, paths);
  }

  private async sizesNow(
    head: string,
    paths: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const files = await this.listNow(head);
    const ids = new Map<string, string>();
    for (const path of paths) {
      const id = files.get(path);
      if (id !== undefined) ids.set(path, id);
    }
    const unique = [...new Set(ids.values())];
    const out = new Map<string, number>();
    if (unique.length === 0) return out;
    await this.fetchMissing(unique);
    const bySize = new Map<string, number>();
    for (let i = 0; i < unique.length; i += BLOB_BATCH) {
      const result = await this.git(['cat-file', '--batch-check'], {
        input: `${unique.slice(i, i + BLOB_BATCH).join('\n')}\n`,
      });
      for (const line of result.stdout.toString('utf8').split('\n')) {
        const [id, type, size] = line.split(' ');
        if (id && type === 'blob') bySize.set(id, Number(size));
      }
    }
    for (const [path, id] of ids) {
      const size = bySize.get(id);
      if (size !== undefined) out.set(path, size);
    }
    return out;
  }

  changed(from: string, to: string): Promise<readonly string[] | null> {
    return this.changedNow(from, to);
  }

  private async changedNow(from: string, to: string): Promise<readonly string[] | null> {
    const known = await this.git(['cat-file', '-e', `${from}^{commit}`], { ok: [0, 1, 128] });
    if (known.code !== 0) return null;
    const args = ['diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to];
    if (this.root) args.push('--', this.root);
    const out = (await this.git(args)).stdout.toString('utf8');
    return out.split('\0').filter(Boolean).sort();
  }

  read(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> {
    return this.readNow(head, paths);
  }

  private async readNow(
    head: string,
    paths: readonly string[],
  ): Promise<ReadonlyMap<string, Uint8Array>> {
    const files = await this.listNow(head);
    const wanted = new Map<string, string>();
    for (const path of paths) {
      const id = files.get(path);
      if (id !== undefined) wanted.set(path, id);
    }
    const ids = [...new Set(wanted.values())];
    const blobs = await this.blobs(ids);
    const out = new Map<string, Uint8Array>();
    for (const [path, id] of wanted) {
      const bytes = blobs.get(id);
      if (bytes) out.set(path, bytes);
    }
    return out;
  }

  /** Blobs by id: the missing ones fetched in batches first, then all read with one `cat-file`. */
  private async blobs(ids: readonly string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    if (ids.length === 0) return out;
    await this.fetchMissing(ids);
    for (let i = 0; i < ids.length; i += BLOB_BATCH) {
      const batch = ids.slice(i, i + BLOB_BATCH);
      const result = await this.git(['cat-file', '--batch'], { input: `${batch.join('\n')}\n` });
      parseBatch(result.stdout, out);
    }
    return out;
  }

  /** Fetches the blobs of `ids` this clone lacks, in batches, with no round trip per blob. */
  private async fetchMissing(ids: readonly string[]): Promise<void> {
    // `--missing=print` never fetches on demand, so this costs no round trip per blob.
    const listed = await this.git(
      ['rev-list', '--objects', '--no-walk', '--missing=print', '--stdin'],
      {
        input: `${ids.join('\n')}\n`,
      },
    );
    const missing = listed.stdout
      .toString('utf8')
      .split('\n')
      .filter((line) => line.startsWith('?'))
      .map((line) => line.slice(1).trim());
    for (let i = 0; i < missing.length; i += BLOB_BATCH) {
      await this.network(
        [
          '-c',
          'fetch.negotiationAlgorithm=noop',
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--recurse-submodules=no',
          '--filter=blob:none',
          '--stdin',
          'origin',
        ],
        { input: `${missing.slice(i, i + BLOB_BATCH).join('\n')}\n` },
      );
    }
  }

  commit(
    head: string | null,
    changes: ReadonlyMap<string, Uint8Array | null>,
    message: string,
  ): Promise<string | null> {
    return this.exclusive(() => this.commitNow(head, changes, message));
  }

  private async commitNow(
    head: string | null,
    changes: ReadonlyMap<string, Uint8Array | null>,
    message: string,
  ): Promise<string | null> {
    for (const path of changes.keys()) {
      if (
        !path.startsWith(this.root) ||
        path.split('/').some((part) => part === '..' || part === '')
      ) {
        throw new GitTransportError(
          'git',
          `Refusing to write outside ${this.root || '/'}: ${path}`,
        );
      }
    }
    const scratch = join(this.options.gitDir, 'penmoss-tmp', randomUUID());
    await mkdir(scratch, { recursive: true });
    try {
      const env = { GIT_INDEX_FILE: join(scratch, 'index') };
      await this.git(head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
      const writes = [...changes].filter(
        (entry): entry is [string, Uint8Array] => entry[1] !== null,
      );
      const files: string[] = [];
      for (const [i, [, bytes]] of writes.entries()) {
        const file = join(scratch, `blob-${i}`);
        await writeFile(file, bytes);
        files.push(file);
      }
      const ids =
        files.length > 0
          ? (
              await this.git(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
                input: `${files.join('\n')}\n`,
              })
            ).stdout
              .toString('utf8')
              .trim()
              .split('\n')
          : [];
      const lines: string[] = writes.map(([path], i) => `100644 ${ids[i]}\t${path}`);
      for (const [path, bytes] of changes) {
        if (bytes === null) lines.push(`0 ${'0'.repeat(40)}\t${path}`);
      }
      if (lines.length > 0) {
        await this.git(['update-index', '-z', '--index-info'], {
          env,
          input: `${lines.join('\0')}\0`,
        });
      }
      // Blobs outside what the engine read were never fetched: the tree only names them.
      const tree = (await this.git(['write-tree', '--missing-ok'], { env })).stdout
        .toString('utf8')
        .trim();
      if (head) {
        const before = (await this.git(['rev-parse', `${head}^{tree}`])).stdout
          .toString('utf8')
          .trim();
        if (before === tree) return null;
      }
      const author = this.options.author;
      const { name, email } = typeof author === 'function' ? await author() : author;
      // Signed when git's configuration says so (a branch may require it), unless turned off.
      // `commit-tree` itself never reads commit.gpgSign, so it is asked for here.
      const signs = await this.signs();
      const args = ['commit-tree', ...(signs ? ['-S'] : ['--no-gpg-sign']), tree];
      args.push('-F', '-');
      if (head) args.push('-p', head);
      const limit = limitOf(this.options);
      const commit = (
        await this.git(args, {
          input: message,
          ...(signs ? { timeoutMs: limit } : {}),
          env: {
            GIT_AUTHOR_NAME: name,
            GIT_AUTHOR_EMAIL: email,
            GIT_COMMITTER_NAME: name,
            GIT_COMMITTER_EMAIL: email,
          },
        })
      ).stdout
        .toString('utf8')
        .trim();
      return commit;
    } catch (error) {
      if (error instanceof GitTransportError && error.code === 'timeout') {
        // Only signing waits: a signer asking for a passphrase, a fingerprint or an app's approval.
        throw new GitTransportError(
          'signing',
          `Signing the commit did not finish within ${Math.round(limitOf(this.options) / 1000)} s: the signer is waiting for something nobody can answer here (a passphrase, Touch ID, 1Password). Sign from a terminal, or turn signing off for this notebook (notebook set <name> --no-sign).`,
        );
      }
      throw error;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private signing: Promise<boolean> | null = null;

  /** Whether commits are signed: git's commit.gpgSign (global, or this clone's), unless off. */
  private signs(): Promise<boolean> {
    if (this.options.sign === false) return Promise.resolve(false);
    this.signing ??= this.git(['config', '--type=bool', '--get', 'commit.gpgSign'], { ok: [0, 1] })
      .then((done) => done.stdout.toString('utf8').trim() === 'true')
      .catch(() => false);
    return this.signing;
  }

  push(commit: string): Promise<PushOutcome> {
    return this.exclusive(() => this.pushNow(commit));
  }

  private async pushNow(commit: string): Promise<PushOutcome> {
    await this.ensureConfig();
    const result = await this.network(
      ['push', '--porcelain', 'origin', `${commit}:refs/heads/${this.options.branch}`],
      { ok: [0, 1, 128] },
    );
    const porcelain = result.stdout.toString('utf8');
    if (result.code === 0) {
      // The remote-tracking ref follows, so History and Status see the commit at once.
      await this.git(['update-ref', this.ref, commit]);
      return 'pushed';
    }
    const rejected = porcelain
      .split('\n')
      .find((line) => line.startsWith('!') && line.includes(`refs/heads/${this.options.branch}`));
    if (rejected && /\[rejected\]|non-fast-forward|fetch first|stale info/.test(rejected)) {
      return 'rejected';
    }
    throw gitError(['push'], result);
  }

  log(
    options: { readonly paths?: readonly string[]; readonly limit?: number } = {},
  ): Promise<CommitInfo[]> {
    return this.logNow(options);
  }

  private async logNow(
    options: { readonly paths?: readonly string[]; readonly limit?: number } = {},
  ): Promise<CommitInfo[]> {
    const head = await this.revParse(this.ref);
    if (!head) return [];
    const args = ['log', '-z', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B', head];
    if (options.limit !== undefined) args.splice(1, 0, `--max-count=${options.limit}`);
    const paths = options.paths ?? (this.root ? [this.root] : []);
    if (paths.length > 0) args.push('--', ...paths);
    const out = (await this.git(args)).stdout.toString('utf8');
    return out
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const [id, parents, name, email, at, ...message] = record.split('\x1f');
        return {
          id: id!,
          parents: parents ? parents.split(' ') : [],
          author: { name: name!, email: email! },
          at: Number(at) * 1000,
          message: message.join('\x1f').trimEnd(),
        };
      });
  }

  readAt(commit: string, path: string): Promise<Uint8Array | null> {
    return this.readAtNow(commit, path);
  }

  private async readAtNow(commit: string, path: string): Promise<Uint8Array | null> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', `${commit}:${path}`], {
      ok: [0, 1, 128],
    });
    if (result.code !== 0) return null;
    const id = result.stdout.toString('utf8').trim();
    return (await this.blobs([id])).get(id) ?? null;
  }

  /** Housekeeping after a sync (G0: a clone grew to 91 MB unpacked over 1,000 commits). */
  maintain(): Promise<void> {
    return this.exclusive(() => this.maintainNow());
  }

  private async maintainNow(): Promise<void> {
    await this.git(['gc', '--auto', '--quiet']);
  }

  /** The clone's object store in bytes (Status). */
  storeBytes(): Promise<number> {
    return this.storeBytesNow();
  }

  private async storeBytesNow(): Promise<number> {
    const out = (await this.git(['count-objects', '-v'])).stdout.toString('utf8');
    const kb = (key: string) => Number(new RegExp(`^${key}: (\\d+)`, 'm').exec(out)?.[1] ?? 0);
    return (kb('size') + kb('size-pack') + kb('size-garbage')) * 1024;
  }

  /**
   * Stops every git command this transport is running, at once (A852): each fails as `timeout`,
   * so a sync that waits on a stalled network gives up when its caller's time is up, with every
   * change kept. Later calls run as usual.
   */
  cancel(): void {
    this.stop.abort();
    this.stop = new AbortController();
  }

  /** The remote-tracking head as of the last fetch, without fetching. */
  head(): Promise<string | null> {
    return this.revParse(this.ref);
  }

  /**
   * The branch's head at the remote now (T60, A1063, A1067): one `git ls-remote`, a few hundred
   * bytes, with no fetch and nothing written to the clone, so it never queues behind a sync.
   * Null when the branch does not exist there. `head()` stays the local remote-tracking ref.
   */
  async remoteHead(): Promise<string | null> {
    const ref = `refs/heads/${this.options.branch}`;
    const result = await this.network(['ls-remote', 'origin', ref], { ok: [0, 128] });
    if (result.code !== 0) throw gitError(['ls-remote'], result);
    for (const line of result.stdout.toString('utf8').split('\n')) {
      const [id, name] = line.trim().split('\t');
      if (name === ref && id && /^[0-9a-f]{40,64}$/.test(id)) return id;
    }
    return null;
  }
}

/** Parses `git cat-file --batch` output into `out` (blob id → bytes). */
function parseBatch(stdout: Buffer, out: Map<string, Uint8Array>): void {
  let at = 0;
  while (at < stdout.length) {
    const newline = stdout.indexOf(0x0a, at);
    if (newline < 0) break;
    const header = stdout.subarray(at, newline).toString('utf8');
    at = newline + 1;
    const [id, type, size] = header.split(' ');
    if (type === 'missing' || size === undefined) continue;
    const length = Number(size);
    const bytes = new Uint8Array(stdout.subarray(at, at + length));
    if (type === 'blob') out.set(id!, bytes);
    at += length + 1;
  }
}

function limitOf(options: NodeGitTransportOptions): number {
  return options.signTimeoutMs ?? LOCAL_TIMEOUT_MS;
}
