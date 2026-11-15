/**
 * The sync engine of a git notebook (T50, A822; #147's A742). One engine per notebook per device
 * (a file lock per CLI clone, a Web Lock across the Mac app's windows). A sync:
 *
 * 1. fetches the branch;
 * 2. applies every writer's logs that changed since the last synced head, the WorkspaceDoc first
 *    (it carries `purged`, A828), skipping purged notes before applying anything;
 * 3. stamps `changedAt/<writer>` on the notes this writer changed (A823), once per commit;
 * 4. names (claims in a fork of the WorkspaceDoc, joining it only once the commit lands) and
 *    renders the render set, unless a newer client owns the render (`renderVersion`);
 * 5. recomputes this writer's own files from content ids (A821), never for a purged note;
 * 6. commits only under `<dir>`, on top of the remote head, and pushes a fast-forward;
 * 7. on a rejected push, fetches and builds again, up to 3 times (G0: never needed a fourth).
 *
 * Steps 1 to 6 are one `Build` (`./build.ts`); this class holds the retry loop, the writer, and
 * what a client asks of the notebook between syncs.
 *
 * Nothing is marked sent, so a crash anywhere loses nothing: the next sync recomputes the same
 * difference from the remote head. The local clone is disposable; the truth is the remote plus
 * the device's docs.
 */
import { sha256HexText } from '@penmoss/core/attachments';
import { ulid } from '@penmoss/core/ids';
import { cleanNotebookName, formatOf, Layout, RENDER_VERSION, type NotebookInfo } from '../layout';
import { purgedIds } from '../purge';
import { renderNoteFile } from '../render';
import {
  NotebookReplica,
  type GitChanges,
  type NotebookStorage,
  type WithheldCopy,
} from '../replica';
import { GitTransportError, type GitTransport } from '../transport';
import { ensureWriter, type WriterKind, type WriterRecord } from '../writer';
import { freshClientId, randomClientId } from '../yjs';
import { frontmatterId } from '../names';
import { BlobReader } from './blobs';
import { Build, type Built } from './build';
import { forgetWithheld, keepCopy, withheldCopies } from './copies';
import { NotebookError, WriterFull } from './errors';
import { foreignAt, headPaths, namesAt, renderedPaths } from './names-at';
import {
  MAX_ATTEMPTS,
  MAX_LOG_BYTES,
  RETIRE_WRITER_AFTER_IDS,
  type EngineOptions,
  type SyncOptions,
  type SyncReport,
} from './options';

export class GitNotebookEngine {
  readonly replica: NotebookReplica;
  readonly layout: Layout;
  private readonly random: () => number;
  private readonly newId: () => string;
  private writerRecord: WriterRecord | null;
  /** Logs and actor files read during this process, by git blob id (A822). */
  private readonly blobs: BlobReader;
  private chain: Promise<unknown> = Promise.resolve();
  /** The transport the sync in progress uses: refuses every call once its signal is aborted. */
  private git: GitTransport;
  private constructor(
    private readonly options: EngineOptions,
    replica: NotebookReplica,
  ) {
    this.replica = replica;
    this.layout = new Layout(options.transport.root);
    this.random = options.random ?? Math.random;
    this.newId = options.newId ?? ulid;
    this.writerRecord = replica.state.writer;
    this.git = options.transport;
    this.blobs = new BlobReader(this.layout, options.maxLogBytes ?? MAX_LOG_BYTES);
  }

  static async open(options: EngineOptions): Promise<GitNotebookEngine> {
    const snapshot = await options.storage.load();
    // A new client id for every process (A821), one no doc here holds content of and this writer
    // has not listed: a profile rolled back (a VM snapshot, a backup, a copied ~/.penmoss) may
    // edit before it syncs, and its stored id's clocks may already be on the branch. A clash with
    // another writer's actor file is caught at the sync (build).
    const replica = new NotebookReplica(
      snapshot,
      options.clientID ?? randomClientId(options.random),
      options.clock ?? Date.now,
      options.confirmDelivery ?? false,
    );
    if (options.clientID === undefined) {
      replica.setClientId(
        freshClientId(
          new Set([
            ...replica.usedClientIds(),
            ...replica.state.ownClients,
            ...(snapshot?.meta.clientId != null ? [snapshot.meta.clientId] : []),
          ]),
          options.random,
        ),
      );
    }
    // A copied profile (its writer's secret is not here) is a new writer: never the original's
    // claims id.
    const writer = snapshot?.meta.writer;
    if (writer && replica.state.claimsClientId !== null) {
      const secret = await options.secrets.get();
      if (!secret || (await sha256HexText(secret)) !== writer.secretHash) {
        replica.update({ claimsClientId: null });
      }
    }
    if (!replica.state.info && options.create) {
      // A new notebook has its id from the start: its derived ids are salted with it (A820).
      replica.update({
        info: {
          id: options.create.id ?? (options.newId ?? ulid)(),
          name: options.create.name,
          format: formatOf(options.create),
          renderVersion: RENDER_VERSION,
          ...(options.create.salt !== undefined ? { salt: options.create.salt } : {}),
        },
      });
    }
    return new GitNotebookEngine(options, replica);
  }

  get info(): NotebookInfo | null {
    return this.replica.state.info;
  }

  /** The name Rename gave it here, until a sync lands it in `notebook.json`; null: none. */
  get pendingName(): string | null {
    return this.replica.state.pendingName;
  }

  /**
   * Rename (Ryan's review of PR #192): `info.name` is `name` at once, and the next sync writes it
   * to `notebook.json`, so every device and agent that syncs follows. A rename made on two
   * devices before either synced: the later push wins. Saved with the next save; throws a
   * RangeError for a name with nothing in it.
   */
  rename(name: string): void {
    const clean = cleanNotebookName(name);
    if (clean === null) throw new RangeError('A notebook needs a name.');
    const info = this.replica.state.info;
    if (!info) throw new NotebookError('no_notebook', 'There is no Penmoss notebook here yet.');
    if (info.name === clean && this.pendingName === null) return;
    this.replica.update({ info: { ...info, name: clean }, pendingName: clean });
  }

  /** What a sync that landed leaves: its `notebook.json`, with a Rename made since kept. */
  private settleInfo(info: NotebookInfo): void {
    const pending = this.pendingName;
    if (pending === null || pending === info.name) {
      this.replica.update({ info, pendingName: null });
    } else {
      this.replica.update({ info: { ...info, name: pending } });
    }
  }

  get writer(): WriterRecord | null {
    return this.writerRecord;
  }

  /** Who this engine writes as (its writer's kind and label, before the first sync too). */
  get who(): { readonly kind: WriterKind; readonly label: string } {
    return this.options.writer;
  }

  get transport(): GitTransport {
    return this.options.transport;
  }

  get storage(): NotebookStorage {
    return this.options.storage;
  }

  /**
   * Runs `work` alone: local changes and syncs never interleave (each awaits git), so a change
   * made while a sync waits on the network is seen by the next one, never half-way.
   */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Saves the docs and bookkeeping (after local changes; a sync saves by itself). */
  save(): Promise<void> {
    return this.replica.save(this.options.storage);
  }

  sync(options: SyncOptions = {}): Promise<SyncReport> {
    return this.exclusive(() => this.syncNow(options));
  }

  /**
   * What the repository changed here that no report has given yet: after a sync that failed
   * once its fetch was applied (a refused or dropped push), so the client still shows it. A
   * report takes these too, so each change is given once.
   */
  takeGitChanges(): GitChanges {
    return this.replica.takeGitChanges();
  }

  /** The client showed these (`confirmDelivery`); saved at the next save. */
  confirmGitChanges(shown: GitChanges): void {
    this.replica.confirmGitChanges(shown);
  }

  /** Copies withheld from the push (A886), by copy id: kept on this device only. */
  withheld(): Readonly<Record<string, WithheldCopy>> {
    return withheldCopies(this.replica);
  }

  /**
   * Keep and sync (A886): the person confirmed pushing the withheld copy `id`, whose doc the
   * caller has put back in the notebook with its link. It is pushed as it is from the next sync,
   * and main lets it through only with the person's confirmation for that copy.
   */
  keepCopy(id: string): void {
    keepCopy(this.replica, id);
  }

  /** A withheld copy the person deleted for good or that another store took over: forgotten. */
  forgetWithheld(id: string): void {
    forgetWithheld(this.replica, id);
  }

  private async syncNow(options: SyncOptions): Promise<SyncReport> {
    // Stopped is stopped for the rest of this sync: no git call after it (a cancel that only
    // killed the git running then was lost between calls).
    this.git = options.signal
      ? stoppable(this.options.transport, options.signal)
      : this.options.transport;
    try {
      return await this.syncGuarded(options);
    } finally {
      this.git = this.options.transport;
    }
  }

  private async syncGuarded(options: SyncOptions): Promise<SyncReport> {
    try {
      return await this.syncAs(options, null);
    } catch (error) {
      if (!(error instanceof WriterFull)) throw error;
      // Its actor file at head (or with this sync's ids) is past what clients read: a new writer
      // takes over now, with the ids of what was never pushed, and the sync goes on (A850).
      this.options.log?.(
        `Writer ${this.writerRecord?.id ?? ''}'s actor file is full: a new writer takes over`,
      );
      try {
        return await this.syncAs(options, error.carry);
      } catch (again) {
        if (!(again instanceof WriterFull)) throw again;
        throw new NotebookError(
          'actor_full',
          'Even a new writer’s actor file would be too large for other clients to read. Nothing was pushed; your changes are kept.',
        );
      }
    }
  }

  /** One sync; `carry` (a full writer's unpushed client ids) retires the writer first. */
  private async syncAs(options: SyncOptions, carry: readonly number[] | null): Promise<SyncReport> {
    const replica = this.replica;
    // A writer that has used this many client ids retires: a new writer from this sync on, so
    // its actor file never grows past what every client reads (A850). Never a reused id: a
    // profile cannot prove from inside itself that an id's clocks are not on some other device.
    const retire =
      this.writerRecord !== null &&
      (carry !== null ||
        replica.state.ownClients.length >=
          (this.options.retireWriterAfterIds ?? RETIRE_WRITER_AFTER_IDS));
    if (retire && carry === null) {
      this.options.log?.(
        `Writer ${this.writerRecord!.id} has used ${replica.state.ownClients.length} client ids: a new writer takes over`,
      );
    }
    const ensured = await ensureWriter(
      retire ? null : this.writerRecord,
      this.options.secrets,
      this.options.writer,
      this.newId,
    );
    this.writerRecord = ensured.writer;
    if (ensured.fresh) {
      // A new writer's own client ids are only its own (A821): the one chosen when this profile
      // opened, if it wrote with it already, and none of the original's.
      const own = replica.usedClientIds().has(replica.clientID) ? [replica.clientID] : [];
      replica.update({
        writer: ensured.writer,
        ownClients: [...new Set([...(carry ?? []), ...own])],
      });
    } else if (replica.state.writer !== ensured.writer) {
      replica.update({ writer: ensured.writer });
    }
    if (ensured.previous) {
      this.options.log?.(`New writer ${ensured.writer.id} (the profile was copied or restored)`);
    }
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const built = await new Build({
          git: this.git,
          replica,
          layout: this.layout,
          writer: ensured.writer,
          options: this.options,
          blobs: this.blobs,
          random: this.random,
          full: options.full === true || ensured.fresh,
        }).run();
        if (built.commit === null) {
          this.settleInfo(built.info);
          replica.synced(built.head, built.dirtyAt, built.workspaceDirty);
          return this.report(built, null, attempt, ensured);
        }
        // Everything this sync wrote into the docs (the `changedAt` stamps) is on disk before the
        // push, so a process killed during it never reuses a client clock the branch holds.
        await this.save();
        await options.beforePush?.(built.commit);
        const pushed = await this.git.push(built.commit);
        if (pushed === 'pushed') {
          await options.afterPush?.(built.commit);
          built.landed();
          this.settleInfo(built.info);
          replica.synced(built.commit, built.dirtyAt, built.workspaceDirty);
          return this.report(built, built.commit, attempt, ensured);
        }
        this.options.log?.(`Push rejected (someone pushed first); building again (${attempt})`);
      }
      throw new NotebookError(
        'busy',
        `Others kept pushing: ${MAX_ATTEMPTS} pushes in a row were rejected. Your changes are kept; sync again.`,
      );
    } finally {
      await this.save();
      if (!options.signal?.aborted) await this.git.maintain?.().catch(() => undefined);
    }
  }

  private report(
    built: Built,
    commit: string | null,
    attempts: number,
    ensured: { fresh: boolean; writer: WriterRecord },
  ): SyncReport {
    // Everything the repository changed here since the client last took it, this sync's and
    // what a sync whose push failed applied before it.
    const changes = this.replica.takeGitChanges();
    return {
      head: commit ?? built.head,
      commit,
      attempts,
      changed: changes.changed,
      workspaceChanged: changes.workspaceChanged,
      purged: changes.purged,
      notes: built.notes,
      handEdits: built.handEdits,
      foreign: built.foreign,
      renderSkipped: built.renderSkipped,
      newWriter: ensured.fresh ? ensured.writer.id : null,
      clientId: this.replica.clientID,
      skipped: this.replica.state.skipped,
      copies: built.copies,
    };
  }

  /**
   * Every file this writer's state renders at `head`, in full (no render set), and Penmoss's
   * files there: what the tests compare after each sync (a render set never misses, G0 check 7),
   * and what Status uses to list stale or hand-edited files.
   */
  async renderAll(head: string): Promise<{
    readonly wanted: ReadonlyMap<string, string>;
    readonly penmoss: ReadonlyMap<string, string>;
    readonly foreign: readonly string[];
  }> {
    const replica = this.replica;
    const layout = this.layout;
    const files = await this.options.transport.list(head);
    const purged = purgedIds(replica.workspace);
    const read = await this.options.transport.read(head, renderedPaths(layout, files));
    const foreign = foreignAt(
      replica,
      layout,
      files,
      (path) => frontmatterId(read.get(path)),
      purged,
    );
    const named = namesAt(replica, layout, purged, foreign);
    const headPath = headPaths(foreign);
    const wanted = new Map<string, string>();
    for (const [id, path] of named.paths) {
      const markdown = renderNoteFile(replica.note(id)!, id, path, named, layout.root);
      if (markdown !== null) {
        wanted.set(path, markdown);
        continue;
      }
      // Content from a newer Penmoss (A1493): the file at head is kept as it is, as a sync keeps it.
      const atHead = headPath.get(id);
      const bytes = atHead === undefined ? undefined : read.get(atHead);
      if (atHead !== undefined && bytes) wanted.set(atHead, new TextDecoder().decode(bytes));
    }
    return { wanted, penmoss: foreign.penmoss, foreign: foreign.paths };
  }
}

/** `transport`, refusing every call once `signal` is aborted (a stopped sync stays stopped). */
function stoppable(transport: GitTransport, signal: AbortSignal): GitTransport {
  return new Proxy(transport, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (signal.aborted) {
          return Promise.reject(
            new GitTransportError('timeout', 'The sync was stopped: it ran out of time.'),
          );
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
