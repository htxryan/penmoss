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
 * Nothing is marked sent, so a crash anywhere loses nothing: the next sync recomputes the same
 * difference from the remote head. The local clone is disposable; the truth is the remote plus
 * the device's docs.
 */
import { ulid } from '@penmoss/core';
import { gitBlobSha } from '@penmoss/core/mirror';
import { attachmentFiles, noteBody } from '@penmoss/editor/markdown';
import { NOTE_META, readTitle } from '@penmoss/sync-client/note';
import { readWorkspace } from '@penmoss/sync-client/workspace';
import * as Y from '@y/y';
import { actorFile, parseActor, type ActorFile } from './actors';
import {
  cleanNotebookName,
  encodeNotebookInfo,
  FORMAT,
  formatOf,
  Layout,
  parseNotebookInfo,
  RENDER_VERSION,
  type NotebookInfo,
} from './layout';
import { assignNames, foreignOf, frontmatterId, storeClaims, storedNotePath } from './names';
import {
  isPurged,
  markPurged,
  purgedIds,
  racedCopies,
  recoveredFromOf,
  unregisterCopy,
  WORKSPACE_PURGED_FROM,
} from './purge';
import { CHANGED_AT_PREFIX, renderNoteFile, renderSet } from './render';
import {
  NotebookReplica,
  type GitChanges,
  type NotebookStorage,
  type WithheldCopy,
} from './replica';
import { commitPurges } from './purge-check';
import { GitTransportError, type GitTransport } from './transport';
import {
  ensureWriter,
  sha256Hex,
  type WriterKind,
  type WriterRecord,
  type WriterSecrets,
} from './writer';
import {
  applyKeepingId,
  ENGINE_ORIGIN,
  forkDoc,
  GIT_ORIGIN,
  hasPending,
  isUpdate,
  mergeUpdates,
  freshClientId,
  ownFile,
  randomClientId,
} from './yjs';

/** "At most 3 times" (A822): the first attempt and three rebuilds. */
export const MAX_ATTEMPTS = 4;
/** The largest writer log read (A822): a bigger one is skipped and reported, never loaded. */
export const MAX_LOG_BYTES = 32 * 1024 * 1024;
/** The largest actor file read. */
export const MAX_ACTOR_BYTES = 1024 * 1024;
/**
 * A writer that has written with this many client ids retires (A850): the next sync makes a new
 * writer, with a new id, secret and actor file, as a copied profile does. Every writing process
 * takes a new client id (A821) and its actor file lists them all; 20,000 ids are about 220 KB,
 * well inside `MAX_ACTOR_BYTES`.
 */
export const RETIRE_WRITER_AFTER_IDS = 20_000;

/**
 * Commits name how many notes they carry; `[skip ci]` keeps a code repo's CI quiet (A825). The
 * author is the device's git identity; the trailer names the writer, so History can tell an
 * agent's commit from its person's.
 */
export function commitMessage(
  notes: number,
  writer?: { readonly id: string; readonly kind: WriterKind; readonly label: string },
): string {
  const subject = `Penmoss: ${notes} ${notes === 1 ? 'note' : 'notes'} [skip ci]`;
  if (!writer) return subject;
  const label = writer.label.replace(/["\r\n]/g, ' ').trim();
  return `${subject}\n\nPenmoss-Writer: ${writer.id} (${writer.kind} "${label}")\n`;
}

/** Why a notebook cannot sync, as opposed to how git failed (`GitTransportError`). */
export type NotebookErrorCode =
  /** The target holds no notebook and this device was not asked to make one. */
  | 'no_notebook'
  /** The target holds another notebook than the one this profile is of. */
  | 'other_notebook'
  /** `notebook.json` is newer than this client knows, or unreadable. */
  | 'format'
  /** Every attempt's push was rejected (others kept pushing). */
  | 'busy'
  /** The branch was synced before and is gone now: never recreated as a new history (A822). */
  | 'branch_gone'
  /** Even a new writer's actor file would pass `MAX_ACTOR_BYTES` (a writer retires before). */
  | 'actor_full'
  /** A copy brought back after a store was cleared would land without its own log (A886). */
  | 'copy_unwritten';

/** A writer's actor file is full: the sync retires it and goes on (internal). */
class WriterFull extends Error {
  constructor(readonly carry: readonly number[]) {
    super("The writer's actor file is full");
  }
}

export class NotebookError extends Error {
  constructor(
    readonly code: NotebookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotebookError';
  }
}

export interface EngineOptions {
  readonly transport: GitTransport;
  readonly storage: NotebookStorage;
  /** Where this writer's secret lives (A821): the Keychain, the CLI's credential store. */
  readonly secrets: WriterSecrets;
  readonly writer: { readonly kind: WriterKind; readonly label: string };
  /**
   * Make the notebook when the target has none (a new notebook); otherwise it must be there.
   * `salt` only for the notebook imported from the personal workspace (`''`, A1021).
   */
  readonly create?: { readonly id?: string; readonly name: string; readonly salt?: string };
  readonly clock?: () => number;
  /** The writer's Yjs client id, overriding the stored one (tests only). */
  readonly clientID?: number;
  /** When this writer retires for a new one (default `RETIRE_WRITER_AFTER_IDS`; tests lower it). */
  readonly retireWriterAfterIds?: number;
  /** The largest actor file written (default `MAX_ACTOR_BYTES`; tests lower it). */
  readonly maxActorBytes?: number;
  /**
   * The client confirms what it showed of the repository's changes (`confirmGitChanges`): until
   * then they are given again, after a restart too. The Mac's engine host, whose windows read a
   * separate store, sets it; the CLI reads the docs themselves.
   */
  readonly confirmDelivery?: boolean;
  readonly random?: () => number;
  readonly newId?: () => string;
  readonly log?: (message: string) => void;
  /** The largest log read (default `MAX_LOG_BYTES`; tests lower it). */
  readonly maxLogBytes?: number;
  /**
   * Where copies withheld from the push are kept (A886): Android's Room, as kept-aside rows the
   * person can save, delete or keep and sync. Called before a copy leaves the notebook; a throw
   * fails the sync with nothing changed or pushed. Without it, the engine's own store keeps each
   * copy's whole doc (`withheld` in its bookkeeping).
   */
  readonly withhold?: (copies: readonly CopyToWithhold[]) => Promise<void>;
  /**
   * Test hook: a deliberate bug, to show the convergence checks catch it (G0's mutations).
   * `no-claims` stores no names; `narrow-render` renders only notes whose own logs changed.
   */
  readonly mutation?: 'no-claims' | 'narrow-render';
}

/** A copy the engine withholds from the push (A886), as `withhold` is handed it. */
export interface CopyToWithhold {
  readonly id: string;
  /** The original's id, deleted for good on another device. */
  readonly origin: string;
  readonly title: string;
  readonly folderId: string | null;
  /** The copy's whole doc, every edit made on it here included. */
  readonly update: Uint8Array;
}

export interface SyncOptions {
  /** Recompute every note's own file, not only changed ones (`penmoss notebook sync --full`). */
  readonly full?: boolean;
  /**
   * Stops the sync: once aborted, every git call it would make next fails as `timeout`, so a
   * caller whose time is up ends it at the next call (with the transport's `cancel` for the one
   * running). Changes are kept, as after any failure.
   */
  readonly signal?: AbortSignal;
  /** Test hook: between building a commit and pushing it (throw to crash there). */
  readonly beforePush?: (commit: string) => void | Promise<void>;
  /** Test hook: once the push landed, before the engine records it (throw to lose it). */
  readonly afterPush?: (commit: string) => void | Promise<void>;
}

export interface SyncReport {
  /** The branch's head after the sync. */
  readonly head: string | null;
  /** The commit this sync landed, or null when there was nothing to commit. */
  readonly commit: string | null;
  /** Builds it took (1 when no push was rejected). */
  readonly attempts: number;
  /** Notes the repository changed here (other writers' edits), for the client to refresh. */
  readonly changed: readonly string[];
  /** The WorkspaceDoc changed here (tree, names, Trash, purges). */
  readonly workspaceChanged: boolean;
  /** Notes dropped because someone deleted them for good. */
  readonly purged: readonly string[];
  /** Notes the commit carries (logs or rendered files). */
  readonly notes: number;
  /** Rendered files someone edited by hand, overwritten by this render (Status lists them). */
  readonly handEdits: readonly string[];
  /** Files under `<dir>` Penmoss did not write, relative to it (A217; left alone). */
  readonly foreign: readonly string[];
  /** A newer client owns the render (`renderVersion`): this one wrote logs only (A823). */
  readonly renderSkipped: boolean;
  /** This profile got a new writer id (its first sync, or a copied profile, A821). */
  readonly newWriter: string | null;
  /** The client id this writer writes with (a new one for every process, A821). */
  readonly clientId: number;
  /** Files at head this writer could not read and left out (path → why); Status lists them. */
  readonly skipped: Readonly<Record<string, string>>;
  /** `.md` files carrying a note's id where Penmoss did not put them: left alone, reported. */
  readonly copies: readonly string[];
}

interface Built {
  readonly head: string | null;
  readonly commit: string | null;
  readonly notes: number;
  readonly handEdits: string[];
  readonly foreign: readonly string[];
  readonly copies: readonly string[];
  readonly renderSkipped: boolean;
  /** Joins the claims into the local WorkspaceDoc: called once the commit landed. */
  readonly landed: () => void;
  readonly dirtyAt: ReadonlyMap<string, number>;
  readonly workspaceDirty: boolean;
  readonly info: NotebookInfo;
}

export class GitNotebookEngine {
  readonly replica: NotebookReplica;
  readonly layout: Layout;
  private readonly random: () => number;
  private readonly newId: () => string;
  private writerRecord: WriterRecord | null;
  /** Blob bytes read during this process, by git blob id (logs are content-addressed). */
  private readonly blobs = new Map<string, Uint8Array>();
  /** Blobs that are not Yjs updates, by git blob id: why (A822). */
  private readonly unreadable = new Map<string, string>();
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
      if (!secret || (await sha256Hex(secret)) !== writer.secretHash) {
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
    return this.replica.state.pendingName ?? null;
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
    return this.replica.state.withheld ?? {};
  }

  /**
   * Keep and sync (A886): the person confirmed pushing the withheld copy `id`, whose doc the
   * caller has put back in the notebook with its link. It is pushed as it is from the next sync,
   * and main lets it through only with the person's confirmation for that copy.
   */
  keepCopy(id: string): void {
    const withheld = { ...this.withheld() };
    delete withheld[id];
    const kept = new Set(this.replica.state.keptCopies ?? []);
    kept.add(id);
    this.replica.update({ withheld, keptCopies: [...kept].sort() });
  }

  /** A withheld copy the person deleted for good or that another store took over: forgotten. */
  forgetWithheld(id: string): void {
    if (!(id in this.withheld())) return;
    const withheld = { ...this.withheld() };
    delete withheld[id];
    this.replica.update({ withheld });
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
        const built = await this.build(options.full === true || ensured.fresh);
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

  /** Reads blobs at `head`, from this process's cache where it has them. */
  private async readBlobs(
    head: string,
    files: ReadonlyMap<string, string>,
    paths: Iterable<string>,
  ): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    const missing: string[] = [];
    for (const path of paths) {
      const blob = files.get(path);
      if (blob === undefined) continue;
      const cached = this.blobs.get(blob);
      if (cached) out.set(path, cached);
      else missing.push(path);
    }
    if (missing.length > 0) {
      const read = await this.git.read(head, missing);
      for (const [path, bytes] of read) {
        out.set(path, bytes);
        const blob = files.get(path);
        // Logs and actor files are kept; rendered files are read once for their frontmatter id.
        if (blob !== undefined && path.startsWith(this.layout.base)) this.blobs.set(blob, bytes);
      }
    }
    return out;
  }

  /**
   * Writers' logs at `head` this writer can use (A822): one too large to read, or not a Yjs
   * update (a corrupt file, a bad merge), is left out and recorded in `skipped`, so one bad file
   * never stops every device's sync. Its writer's other files still count.
   */
  private async readLogs(
    head: string,
    files: ReadonlyMap<string, string>,
    paths: Iterable<string>,
    skipped: Map<string, string>,
  ): Promise<Map<string, Uint8Array>> {
    const max = this.options.maxLogBytes ?? MAX_LOG_BYTES;
    const candidates: string[] = [];
    for (const path of paths) {
      const blob = files.get(path);
      if (blob === undefined) continue;
      const known = this.unreadable.get(blob);
      if (known) skipped.set(path, known);
      else candidates.push(path);
    }
    const uncached = candidates.filter((path) => !this.blobs.has(files.get(path)!));
    const sizes =
      uncached.length > 0 && this.git.sizes ? await this.git.sizes(head, uncached) : null;
    const wanted: string[] = [];
    for (const path of candidates) {
      if ((sizes?.get(path) ?? 0) > max) {
        this.unreadable.set(files.get(path)!, tooLarge(max));
        skipped.set(path, tooLarge(max));
      } else {
        wanted.push(path);
      }
    }
    const read = await this.readBlobs(head, files, wanted);
    const out = new Map<string, Uint8Array>();
    for (const [path, bytes] of read) {
      const blob = files.get(path)!;
      const why =
        bytes.byteLength > max ? tooLarge(max) : isUpdate(bytes) ? null : 'not a Yjs update';
      if (why) {
        this.unreadable.set(blob, why);
        this.blobs.delete(blob);
        skipped.set(path, why);
      } else {
        out.set(path, bytes);
      }
    }
    return out;
  }

  private async build(full: boolean): Promise<Built> {
    const transport = this.git;
    const replica = this.replica;
    const layout = this.layout;
    const writer = this.writerRecord!;
    const head = await transport.fetch();
    if (head === null && replica.state.lastHead !== null) {
      // Pushing now would start a new history on a branch someone deleted or renamed.
      throw new NotebookError(
        'branch_gone',
        `The branch is gone from the repository (it was at ${replica.state.lastHead.slice(0, 7)} at the last sync). Nothing was pushed; your changes are kept. Restore the branch, or point the notebook at another.`,
      );
    }
    const files: ReadonlyMap<string, string> = head ? await transport.list(head) : new Map();
    const skipped = new Map<string, string>();

    // The notebook at the target.
    let info: NotebookInfo;
    let writeInfo = false;
    // notebook.json and the actor files (small, read together: one fetch for both).
    const actorPaths = [...files.keys()].filter((path) => layout.parse(path)?.kind === 'actor');
    const firstRead =
      head && (files.has(layout.notebook) || actorPaths.length > 0)
        ? await this.readBlobs(head, files, [layout.notebook, ...actorPaths])
        : null;
    const infoBytes = firstRead && files.has(layout.notebook) ? firstRead : null;
    const atHead = infoBytes?.get(layout.notebook)
      ? parseNotebookInfo(infoBytes.get(layout.notebook)!)
      : null;
    if (infoBytes && !atHead) {
      throw new NotebookError(
        'format',
        `${layout.notebook} is not a notebook file Penmoss can read.`,
      );
    }
    if (atHead) {
      if (atHead.format > FORMAT) {
        throw new NotebookError(
          'format',
          `This notebook is format ${atHead.format}; this Penmoss reads format ${FORMAT}. Update Penmoss.`,
        );
      }
      const mine = replica.state.info;
      if (mine && mine.id !== atHead.id) {
        throw new NotebookError(
          'other_notebook',
          `The target holds the notebook “${atHead.name}” (${atHead.id}), not “${mine.name}” (${mine.id}).`,
        );
      }
      info = atHead;
      if (atHead.renderVersion < RENDER_VERSION) {
        info = { ...atHead, renderVersion: RENDER_VERSION };
        writeInfo = true;
      }
    } else {
      const mine = replica.state.info;
      if (!mine) {
        throw new NotebookError('no_notebook', 'There is no Penmoss notebook at this target yet.');
      }
      info = mine;
      writeInfo = true;
    }
    // A Rename made here (Ryan's review of PR #192) goes into notebook.json with this commit.
    const pendingName = replica.state.pendingName ?? null;
    if (pendingName !== null && pendingName !== info.name) {
      info = { ...info, name: pendingName };
      writeInfo = true;
    }

    // 1. Apply the logs that changed (all of them without a known last head).
    const lastHead = replica.state.lastHead;
    let changedList: readonly string[] | null;
    if (head === null || lastHead === head) changedList = [];
    else if (lastHead === null) changedList = null;
    else changedList = await transport.changed(lastHead, head);
    // No known last head (a first sync, or history rewritten): read and render everything.
    const everything = head !== null && changedList === null;
    const changed = new Set(changedList ?? files.keys());
    const workspaceLogs: string[] = [];
    const noteLogs: Array<[string, string]> = [];
    // Every log at head by doc ('' for the WorkspaceDoc): [path, writer].
    const byDoc = new Map<string, Array<[string, string]>>();
    for (const path of files.keys()) {
      const parsed = layout.parse(path);
      if (!parsed || (parsed.kind !== 'note' && parsed.kind !== 'workspace')) continue;
      const key = parsed.kind === 'note' ? parsed.noteId : '';
      let list = byDoc.get(key);
      if (!list) byDoc.set(key, (list = []));
      list.push([path, parsed.writer]);
      if (!changed.has(path)) continue;
      if (parsed.kind === 'workspace') workspaceLogs.push(path);
      else noteLogs.push([path, parsed.noteId]);
    }
    // This writer's own content arriving from the branch means this profile's files are older
    // than what it pushed (a restored backup): its client clocks may repeat, so it moves on to
    // a new client id before it writes more (A821).
    let behind = false;
    const apply = (doc: Y.Doc, path: string, bytes: Uint8Array) => {
      try {
        if (applyKeepingId(doc, bytes, GIT_ORIGIN)) behind = true;
      } catch (error) {
        skipped.set(path, `could not be applied (${(error as Error).message})`);
      }
    };
    if (head && workspaceLogs.length > 0) {
      const read = await this.readLogs(head, files, workspaceLogs, skipped);
      replica.workspace.transact(() => {
        for (const path of workspaceLogs) {
          const bytes = read.get(path);
          if (bytes) apply(replica.workspace, path, bytes);
        }
      }, GIT_ORIGIN);
    }
    // A Delete for good that landed is never taken back (A855): a mark the head holds and this
    // WorkspaceDoc dropped (a stale Keep note, or a page script) is set again, so the note's
    // content cannot come back from a writer that still holds an old copy.
    let landedPurges = new Set<string>();
    if (head) {
      const atHead = await this.readLogs(
        head,
        files,
        (byDoc.get('') ?? []).map(([path]) => path),
        skipped,
      );
      const merged = new Y.Doc();
      for (const bytes of atHead.values()) Y.applyUpdate(merged, bytes);
      landedPurges = purgedIds(merged);
      merged.destroy();
      for (const id of landedPurges) {
        if (isPurged(replica.workspace, id)) continue;
        this.options.log?.(`Note ${id} is already deleted for good: it stays deleted`);
        // A change of this writer's (its own log carries it), shown to the client like the
        // repository's changes, so the client's copy is marked again too.
        markPurged(replica.workspace, id, (this.options.clock ?? Date.now)());
        replica.showWorkspace();
      }
      // Where a landed purge's note was filed is only for Keep note, which a landed purge never
      // has (A855): the entry goes, in this writer's next commit.
      const from = replica.workspace.get(WORKSPACE_PURGED_FROM);
      const spent = [...landedPurges].filter((id) => from.hasAttr(id));
      if (spent.length > 0) {
        replica.workspace.transact(() => {
          for (const id of spent) from.deleteAttr(id);
        });
        replica.showWorkspace();
      }
    }
    // Purged notes go before any of their logs are applied (G0's change 7).
    const purged = purgedIds(replica.workspace);
    for (const id of purged) if (replica.note(id)) replica.dropNoteFromGit(id);
    // A copy brought back after a store was cleared (A886) whose original another device deleted
    // for good before the copy first reached the branch (the purge raced its push): withheld from
    // the push, never deleted. Its whole doc, every edit made on it here included, is kept on this
    // device first (Room on Android, else the engine's store); then it leaves the notebook, so
    // neither its logs nor its entry are committed. Only a purge fetched from the branch counts:
    // one made here leaves the copy, which the person can see, to be pushed. A copy on the branch
    // stays, whatever later happens to the original; one the person confirmed (Keep and sync) is
    // pushed as it is.
    const links = recoveredFromOf(replica.workspace);
    const keptCopies = (replica.state.keptCopies ?? []).filter((id) => !byDoc.has(id));
    if (keptCopies.length !== (replica.state.keptCopies ?? []).length) {
      replica.update({ keptCopies });
    }
    const raced = racedCopies(replica.workspace, {
      landed: landedPurges,
      purged,
      atHead: (id) => byDoc.has(id),
      held: (id) => replica.note(id) !== undefined,
      kept: new Set(keptCopies),
    });
    if (raced.length > 0) {
      const filed = new Map(
        readWorkspace(replica.workspace).notes.map((note) => [note.id, note.folderId]),
      );
      const copies = raced.map((id): CopyToWithhold => ({
        id,
        origin: links.get(id)!,
        title: readTitle(replica.note(id)!),
        folderId: filed.get(id) ?? null,
        update: Y.encodeStateAsUpdate(replica.note(id)!),
      }));
      const at = (this.options.clock ?? Date.now)();
      await this.options.withhold?.(copies);
      const withheld = { ...(replica.state.withheld ?? {}) };
      for (const copy of copies) {
        withheld[copy.id] = {
          origin: copy.origin,
          title: copy.title,
          folderId: copy.folderId,
          at,
          ...(this.options.withhold ? {} : { update: base64(copy.update) }),
        };
      }
      replica.update({ withheld });
      replica.workspace.transact(() => {
        for (const id of raced) unregisterCopy(replica.workspace, id);
      });
      for (const id of raced) replica.dropNoteFromGit(id);
      replica.showWorkspace();
      this.options.log?.(
        `${raced.length === 1 ? 'A copy' : `${raced.length} copies`} of a note deleted for good on another device kept on this device only, not pushed`,
      );
    }
    // A copy's entry never lands without its log (A886), so every device agrees on whether it
    // has: one whose doc this device lacks, or holds empty (no log to write), leaves the tree
    // before anything is committed.
    const unpushedCopies = [...recoveredFromOf(replica.workspace).keys()].filter(
      (id) => !byDoc.has(id) && !purged.has(id),
    );
    const contentless = (id: string) => {
      const doc = replica.note(id);
      return doc === undefined || Y.decodeStateVector(Y.encodeStateVector(doc)).size === 0;
    };
    const orphans = unpushedCopies.filter(contentless);
    if (orphans.length > 0) {
      replica.workspace.transact(() => {
        for (const id of orphans) unregisterCopy(replica.workspace, id);
      });
      replica.showWorkspace();
      this.options.log?.(
        `${orphans.length === 1 ? 'A recovered copy' : `${orphans.length} recovered copies`} with no content here left the tree`,
      );
    }
    // A note at head this device has no copy of, not purged: a purge taken back before it landed
    // (Keep note, A855). All of its logs are read, changed or not.
    const back = new Set(
      [...byDoc.keys()].filter((id) => id !== '' && !purged.has(id) && !replica.note(id)),
    );
    const toApply = [
      ...noteLogs.filter(([, id]) => !purged.has(id) && !back.has(id)),
      ...[...back].flatMap((id) =>
        (byDoc.get(id) ?? []).map(([path]): [string, string] => [path, id]),
      ),
    ];
    if (head && toApply.length > 0) {
      const read = await this.readLogs(
        head,
        files,
        toApply.map(([path]) => path),
        skipped,
      );
      for (const [path, id] of toApply) {
        const bytes = read.get(path);
        if (bytes) apply(replica.ensureNote(id), path, bytes);
      }
    }
    const applied = new Set(toApply.map(([, id]) => id));
    // A doc left with content Yjs could not apply gets every one of its files at head again
    // (A1148): @y/y rc.29 can drop a struct whose dependency came in a file applied after its own,
    // and the files at head hold every dependency, so this writer ends where the others do.
    if (head) {
      const stuck = [
        ...(hasPending(replica.workspace) ? [''] : []),
        ...replica.noteIds().filter((id) => !purged.has(id) && hasPending(replica.note(id)!)),
      ].filter((id) => byDoc.has(id));
      if (stuck.length > 0) {
        const paths = stuck.flatMap((id) => byDoc.get(id)!.map(([path]) => path));
        const read = await this.readLogs(head, files, paths, skipped);
        for (const id of stuck) {
          const doc = id === '' ? replica.workspace : replica.note(id)!;
          const again = () => {
            for (const [path] of byDoc.get(id)!) {
              const bytes = read.get(path);
              if (bytes) apply(doc, path, bytes);
            }
          };
          if (id === '') replica.workspace.transact(again, GIT_ORIGIN);
          else again();
          if (id !== '') applied.add(id);
        }
        if (stuck.includes('')) replica.showWorkspace();
      }
    }
    if (behind && this.options.clientID === undefined) {
      const next = freshClientId(
        new Set([...replica.usedClientIds(), ...replica.state.ownClients]),
        this.random,
      );
      this.options.log?.(
        `This profile was older than what it had pushed: writing as client ${next} from now on`,
      );
      replica.setClientId(next);
    }

    // 2. `updated` (A823): this writer's key on the notes it changed, at most once per commit.
    const dirtyAt = new Map(Object.entries(replica.state.dirty));
    const workspaceDirty = replica.state.workspaceDirty;
    const key = `${CHANGED_AT_PREFIX}${writer.id}`;
    for (const [id, at] of dirtyAt) {
      const doc = replica.note(id);
      if (!doc || purged.has(id)) continue;
      const meta = doc.get(NOTE_META);
      const current: unknown = meta.getAttr(key);
      if (typeof current !== 'number' || current < at) {
        doc.transact(() => meta.setAttr(key, at), ENGINE_ORIGIN);
      }
    }

    const changes = new Map<string, Uint8Array | null>();
    const touchedNotes = new Set<string>();
    const handEdits: string[] = [];

    // 3. Names and the render, unless a newer client owns the render (A823).
    const renders = info.renderVersion <= RENDER_VERSION;
    const known = new Set([
      ...replica.noteIds(),
      ...purged,
      ...readWorkspace(replica.workspace).notes.map((note) => note.id),
    ]);
    const mdIds: Record<string, string> = {};
    const mdPaths = [...files.keys()].filter(
      (path) => path.endsWith('.md') && !path.startsWith(layout.base) && layout.contains(path),
    );
    const unreadMd = mdPaths.filter((path) => replica.state.mdIds[files.get(path)!] === undefined);
    const readMd: ReadonlyMap<string, Uint8Array> =
      head && unreadMd.length > 0 ? await this.readBlobs(head, files, unreadMd) : new Map();
    for (const path of mdPaths) {
      const blob = files.get(path)!;
      mdIds[blob] = replica.state.mdIds[blob] ?? frontmatterId(readMd.get(path)) ?? '';
    }
    const foreign = foreignOf(
      files.keys(),
      (path) => mdIds[files.get(path)!] || null,
      layout.root,
      known,
      owner(replica.workspace, purged),
    );

    // Other writers' actor files: no two writers may write with one client id (A821).
    const others = new Set<number>();
    for (const path of actorPaths) {
      if (path === layout.actor(writer.id)) continue;
      const bytes = firstRead?.get(path);
      if (!bytes || bytes.byteLength > MAX_ACTOR_BYTES) continue;
      for (const id of parseActor(bytes)?.clientIds ?? []) others.add(id);
    }
    if (others.has(replica.clientID) && this.options.clientID === undefined) {
      const used = new Set([...others, ...replica.usedClientIds(), ...replica.state.ownClients]);
      const next = freshClientId(used, this.random);
      this.options.log?.(
        `Another writer uses client id ${replica.clientID}: writing as ${next} from now on`,
      );
      replica.setClientId(next);
    }

    let claimsDoc: Y.Doc = replica.workspace;
    let claims = 0;
    if (renders) {
      // The claims' own client id, kept per writer: a new one only for a new writer, or when
      // another writer lists it; then one no doc and no writer has used (A821).
      let claimsId = replica.state.claimsClientId;
      if (claimsId === null || claimsId === replica.clientID || others.has(claimsId)) {
        claimsId = freshClientId(
          new Set([
            ...others,
            ...replica.usedClientIds(),
            ...replica.state.ownClients,
            replica.clientID,
          ]),
          this.random,
        );
        replica.update({ claimsClientId: claimsId });
      }
      claimsDoc = forkDoc(replica.workspace, claimsId);
      const named = assignNames({
        workspace: replica.workspace,
        notes: replica.notes,
        purged,
        foreign,
        root: layout.root,
      });
      claims =
        this.options.mutation === 'no-claims'
          ? 0
          : storeClaims(named, claimsDoc, ENGINE_ORIGIN, layout.root);
      const headPath = new Map([...foreign.penmoss].map(([path, id]) => [id, path]));
      const touched = new Set<string>();
      for (const path of changed) {
        const id = foreign.penmoss.get(path);
        if (id) touched.add(id);
      }
      const all = everything || writeInfo;
      const set = all
        ? null
        : this.options.mutation === 'narrow-render'
          ? new Set([...applied, ...dirtyAt.keys()])
          : renderSet({
              named,
              notes: replica.notes,
              changed: [...applied, ...dirtyAt.keys()],
              headPath,
              touched,
            });
      const own = set
        ? renderSet({
            named,
            notes: replica.notes,
            changed: [...applied, ...dirtyAt.keys()],
            headPath,
          })
        : new Set<string>();
      const wanted = new Set<string>();
      for (const [id, path] of named.paths) {
        wanted.add(path);
        if (set && !set.has(id) && headPath.get(id) === path) continue;
        const bytes = new TextEncoder().encode(
          renderNoteFile(replica.note(id)!, id, path, named, layout.root),
        );
        const blob = files.get(path);
        if (blob !== undefined && blob === (await gitBlobSha(bytes))) continue;
        changes.set(path, bytes);
        touchedNotes.add(id);
        if (!all && touched.has(id) && !own.has(id) && headPath.get(id) === path) {
          handEdits.push(path.slice(layout.root.length));
        }
      }
      // Penmoss's files no longer wanted: moved, in Trash, purged. Nothing else is removed.
      for (const [path, id] of foreign.penmoss) {
        if (!wanted.has(path)) {
          changes.set(path, null);
          touchedNotes.add(id);
        }
      }
    }

    // 4. Own files (A821): the WorkspaceDoc (with this render's claims) and the notes.
    const candidates =
      full || everything ? new Set(replica.noteIds()) : new Set([...applied, ...dirtyAt.keys()]);
    // A copy not on the branch yet is always written with its entry (A886).
    const firstPushes = unpushedCopies.filter((id) => !contentless(id));
    for (const id of firstPushes) candidates.add(id);
    const ownPath = (docKey: string) =>
      docKey === '' ? layout.workspace(writer.id) : layout.note(docKey, writer.id);
    const docKeys = [
      '',
      ...[...candidates].filter((id) => replica.note(id) && !purged.has(id)).sort(),
    ];
    const needed = new Set<string>();
    for (const docKey of docKeys) for (const [path] of byDoc.get(docKey) ?? []) needed.add(path);
    const parts = head
      ? await this.readLogs(head, files, needed, skipped)
      : new Map<string, Uint8Array>();
    // A log of this writer's own that it cannot read (too large, or not a Yjs update) is never
    // written over: what it holds would be lost, and main refuses a log replaced with less. The
    // writer retires instead, and the new one writes its own log beside it.
    let ownLogUnread = false;
    for (const docKey of docKeys) {
      const doc = docKey === '' ? claimsDoc : replica.note(docKey)!;
      const logs = byDoc.get(docKey) ?? [];
      const mine = logs.find(([, w]) => w === writer.id);
      if (mine && !parts.has(mine[0])) {
        ownLogUnread = true;
        continue;
      }
      const next = ownFile(
        Y.encodeStateAsUpdate(doc),
        logs.map(([path]) => parts.get(path)).filter((bytes): bytes is Uint8Array => !!bytes),
        mine ? (parts.get(mine[0]) ?? null) : null,
      );
      if (next) {
        changes.set(ownPath(docKey), next);
        if (docKey !== '') touchedNotes.add(docKey);
      }
    }
    // A purged note's logs and file go, whoever wrote them (the one exception, A828).
    for (const id of purged) {
      for (const [path] of byDoc.get(id) ?? []) changes.set(path, null);
    }
    const unwritten = firstPushes.filter((id) => !changes.has(ownPath(id)));
    if (unwritten.length > 0 && !ownLogUnread) {
      throw new NotebookError(
        'copy_unwritten',
        'A note brought back after the store was cleared could not be written, so nothing was pushed; your changes are kept.',
      );
    }

    // 5. Attachments the notes use that the branch lacks, from this device's store.
    for (const id of touchedNotes) {
      const doc = replica.note(id);
      if (!doc) continue;
      for (const file of attachmentFiles(noteBody(doc))) {
        const path = layout.attachment(`${file.sha256}.${file.ext}`);
        if (files.has(path) || changes.has(path)) continue;
        const bytes = await this.options.storage.readAttachment(`${file.sha256}.${file.ext}`);
        if (bytes) changes.set(path, bytes);
      }
    }

    // 6. The actor file (A829) and notebook.json.
    const actorPath = layout.actor(writer.id);
    const ownActor = firstRead?.get(actorPath);
    const maxActor = this.options.maxActorBytes ?? MAX_ACTOR_BYTES;
    const actorAtHead: ActorFile | null =
      ownActor && ownActor.byteLength <= maxActor ? parseActor(ownActor) : null;
    const ownClients = new Set(replica.state.ownClients);
    if (claims > 0) ownClients.add(claimsDoc.clientID);
    // What this writer could not read: kept while the file is unchanged, so Status shows it.
    const stillSkipped: Record<string, string> = {};
    for (const [path, why] of Object.entries(replica.state.skipped)) {
      if (files.has(path) && !changed.has(path)) stillSkipped[path] = why;
    }
    for (const [path, why] of skipped) stillSkipped[path] = why;
    for (const [path, why] of skipped) {
      if (replica.state.skipped[path] !== why) this.options.log?.(`Skipped ${path}: ${why}`);
    }
    const headFull = (ownActor?.byteLength ?? 0) > maxActor;
    const actor = actorFile(writer, actorAtHead, ownClients);
    if (ownLogUnread || headFull || (actor && actor.bytes.byteLength > maxActor)) {
      if (ownLogUnread || headFull || ownClients.size > 1) {
        // Retire it: the new writer lists what this one never pushed. A file at head too large
        // for other clients is still read here, up to the log limit, to tell what it lists; past
        // that, all of it is carried, or only this process's id if even that would not fit.
        const listed =
          actorAtHead ??
          (ownActor && ownActor.byteLength <= (this.options.maxLogBytes ?? MAX_LOG_BYTES)
            ? parseActor(ownActor)
            : null);
        const atHead = new Set(listed?.clientIds ?? []);
        const unpushed = [...ownClients].filter((id) => !atHead.has(id));
        const carried = actorFile(writer, null, new Set(unpushed));
        throw new WriterFull(
          carried && carried.bytes.byteLength <= maxActor ? unpushed : [replica.clientID],
        );
      }
      throw new NotebookError(
        'actor_full',
        `Even a new writer's actor file would pass ${maxActor / 1024 / 1024} MB. Nothing was pushed; your changes are kept.`,
      );
    }
    if (actor) changes.set(actorPath, actor.bytes);
    if (writeInfo) changes.set(layout.notebook, encodeNotebookInfo(info));

    // Bookkeeping: frontmatter ids of the files at head (and of what this commit writes).
    const nextMdIds: Record<string, string> = { ...mdIds };
    for (const [path, bytes] of changes) {
      if (bytes && path.endsWith('.md'))
        nextMdIds[await gitBlobSha(bytes)] = frontmatterId(bytes) ?? '';
    }
    replica.update({ mdIds: nextMdIds, skipped: stillSkipped });

    const onlyActor = [...changes.keys()].every((path) => path === actorPath);
    const landed = () => {
      if (claims === 0) return;
      Y.applyUpdate(
        replica.workspace,
        Y.encodeStateAsUpdate(claimsDoc, Y.encodeStateVector(replica.workspace)),
        ENGINE_ORIGIN,
      );
      replica.update({ ownClients: [...ownClients].sort((a, b) => a - b) });
    };
    const base = {
      head,
      handEdits,
      foreign: foreign.paths,
      copies: foreign.copies,
      renderSkipped: !renders,
      dirtyAt,
      workspaceDirty,
      info,
      notes: touchedNotes.size,
    };
    // An actor file alone waits for the next commit with content in it: a device that only
    // reads never commits.
    if (changes.size === 0 || onlyActor) {
      if (claimsDoc !== replica.workspace) claimsDoc.destroy();
      return { ...base, commit: null, landed: () => undefined };
    }
    // An agent's clone (the CLI's `--agent`, `penmoss mcp`) never commits an undo mark: only a
    // person's writer marks an agent's change undone (#174 merge check). Agent activity believes
    // a mark only when nothing is left to undo; this is defence in depth, where agents commit.
    if (writer.kind === 'agent') {
      const { undoneMarks } = await commitPurges(transport, layout.root, head, changes);
      if (undoneMarks.length > 0) {
        // As a commit main refuses: the error goes up, and the sync stops.
        throw new GitTransportError(
          'refused',
          'Sync stopped: this agent clone would mark an agent’s change undone, but only a person marks an agent’s change undone, so nothing was committed.',
        );
      }
    }
    let commit: string | null;
    try {
      commit = await transport.commit(head, changes, commitMessage(touchedNotes.size, writer));
    } catch (error) {
      // Main refused a copy whose original is deleted for good (A886): a Keep and sync whose
      // confirmation ran out. The copy is withheld again at the next sync, for the person.
      if ((error as { code?: unknown }).code === 'purge_raced' && keptCopies.length > 0) {
        replica.update({ keptCopies: [] });
      }
      throw error;
    }
    if (commit === null) {
      if (claimsDoc !== replica.workspace) claimsDoc.destroy();
      return { ...base, commit: null, landed: () => undefined };
    }
    return {
      ...base,
      commit,
      landed: () => {
        landed();
        if (claimsDoc !== replica.workspace) claimsDoc.destroy();
      },
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
    const known = new Set([
      ...replica.noteIds(),
      ...purged,
      ...readWorkspace(replica.workspace).notes.map((note) => note.id),
    ]);
    const mdPaths = [...files.keys()].filter(
      (path) => path.endsWith('.md') && !path.startsWith(layout.base),
    );
    const read = await this.options.transport.read(head, mdPaths);
    const foreign = foreignOf(
      files.keys(),
      (path) => frontmatterId(read.get(path)),
      layout.root,
      known,
      owner(replica.workspace, purged),
    );
    const named = assignNames({
      workspace: replica.workspace,
      notes: replica.notes,
      purged,
      foreign,
      root: layout.root,
    });
    const wanted = new Map<string, string>();
    for (const [id, path] of named.paths) {
      wanted.set(path, renderNoteFile(replica.note(id)!, id, path, named, layout.root));
    }
    return { wanted, penmoss: foreign.penmoss, foreign: foreign.paths };
  }

  /** Every writer's logs of one note at `head`, merged (History reads it at older commits). */
  async noteAt(commit: string, noteId: string): Promise<Y.Doc | null> {
    const files = await this.options.transport.list(commit);
    const paths = [...files.keys()].filter((path) => path.startsWith(this.layout.noteDir(noteId)));
    if (paths.length === 0) return null;
    const read = await this.options.transport.read(commit, paths);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, mergeUpdates([...read.values()].filter(isUpdate)));
    return doc;
  }
}

/**
 * Whether Penmoss put the file at `rel` (relative to `<dir>`) for note `id` (A823): where it
 * last rendered it, as stored with the names that landed. A file with the note's id anywhere
 * else is a copy someone made: Penmoss leaves it. A purged note's files all go (A828); a note
 * with no stored path (rendered before the record existed) owns every file with its id.
 */
function owner(workspace: Y.Doc, purged: ReadonlySet<string>) {
  return (rel: string, id: string) => {
    if (purged.has(id)) return true;
    const at = storedNotePath(workspace, id);
    return at === undefined || at === rel;
  };
}

function tooLarge(max: number): string {
  return `larger than ${Math.round(max / (1024 * 1024))} MB`;
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

/** Base64 of `bytes` (a withheld copy kept in the engine's bookkeeping). */
function base64(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
}
