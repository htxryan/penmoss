/**
 * A git notebook as a source in the Mac app (T50 G3, #151; A822, A860): its own notes store
 * (`penmoss-git-<id>`), its own `Notes`, `Workspace` and `NoteDirectory`, and its engine, run by one window at a time (A822: a Web Lock named
 * after the notebook). The other windows hand their changes over through the store and its
 * announcements, and show the engine's status from a BroadcastChannel; when the engine's window
 * closes, the next window in line takes the lock and runs it, picking up everything stored.
 */
import { AgentActivity, Layout, type ActivityEntry, type UndoResult } from '@penmoss/git-notebook';
import type { AttachmentsElsewhere } from '@penmoss/sync-client/attachments';
import { NoteStore } from '@penmoss/sync-client';
import { WORKSPACE_RECORD_KEY } from '@penmoss/sync-client/workspace';
import type { DesktopGit, GitNotebookInfo, GitPendingPurge } from '../desktop/bridge';
import type { NoteDirectory } from '../notes/directory';
import {
  Notes,
  type LocalNotes,
  type LocalSyncBackend,
  type LocalSyncState,
} from '../notes/service';
import { Workspace, type RestorePlace } from '../workspace/service';
import { EngineStorage, engineDbName, idbEngineKv, type EngineKv } from './engine-store';
import { GitEngineHost, MAC_WRITER_LABEL, STARTING, type GitSyncStatus } from './engine-host';
import { IpcGitTransport } from './ipc-transport';

/** The notes store of a git notebook (A860). */
export const gitStoreName = (notebookId: string) => `penmoss-git-${notebookId}`;
/** Held by the window that runs a notebook's engine (A822). */
export const engineLockName = (notebookId: string) => `penmoss-git-engine:${notebookId}`;
/** Where the engine's window tells the others how it stands, and hears "Sync now". */
export const GIT_STATUS_CHANNEL = 'penmoss:git-status';

/** What a BroadcastChannel needs (injectable for tests). */
export interface StatusChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

type StatusMessage =
  | { readonly notebookId: string; readonly status: GitSyncStatus; readonly settled?: string }
  | { readonly notebookId: string; readonly command: 'hello' | 'sync' }
  | { readonly notebookId: string; readonly command: 'settle'; readonly id: string }
  | {
      readonly notebookId: string;
      readonly command: 'agent';
      readonly noteId: string;
      readonly threadId: string;
    };

/** How long a window waits for the engine's window to say what is not pushed. */
const SETTLE_WAIT_MS = 5_000;
/** How long fetching an attachment waits for the engine to say which commit is the head. */
const HEAD_WAIT_MS = 10_000;

/** A notebook's sync status in this window: the engine's here, or its window's (A860). */
export class GitStatusFeed {
  private current: GitSyncStatus = STARTING;
  private localState: LocalSyncState = { phase: 'syncing', detail: null, pending: new Set() };
  private readonly listeners = new Set<() => void>();
  private host: GitEngineHost | null = null;
  /** Asked of the engine's window: what is not pushed once it took in every stored change. */
  private readonly settling = new Map<string, (status: GitSyncStatus) => void>();
  private readonly onMessage = (event: MessageEvent) => this.heard(event.data as StatusMessage);

  constructor(
    private readonly notebookId: string,
    private readonly channel: StatusChannel | null,
  ) {
    channel?.addEventListener('message', this.onMessage);
    // The engine's window answers with how it stands.
    this.post({ notebookId, command: 'hello' });
  }

  get status(): GitSyncStatus {
    return this.current;
  }

  /** As the notes service shows it (a stable reference between changes). */
  local = (): LocalSyncState => this.localState;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** This window runs the engine now. */
  attach(host: GitEngineHost): () => void {
    this.host = host;
    const off = host.onStatus((status) => {
      this.set(status);
      this.post({ notebookId: this.notebookId, status: { ...status, here: false } });
    });
    this.set(host.status);
    return () => {
      off();
      if (this.host === host) this.host = null;
    };
  }

  /**
   * The status once the engine has taken in everything the windows stored (null: no engine
   * answered in time): here, or asked of the engine's window.
   */
  async settled(): Promise<GitSyncStatus | null> {
    if (this.host) {
      await this.host.settleAll();
      return this.host.status;
    }
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settling.delete(id);
        resolve(null);
      }, SETTLE_WAIT_MS);
      this.settling.set(id, (status) => {
        clearTimeout(timer);
        this.settling.delete(id);
        resolve(status);
      });
      this.post({ notebookId: this.notebookId, command: 'settle', id });
    });
  }

  /**
   * The branch's head as the engine last synced it (null: none yet), waiting a little while the
   * engine is starting or its window has not answered.
   */
  head(): Promise<string | null> {
    if (this.current.phase !== 'starting') return Promise.resolve(this.current.head);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve(this.current.head);
      };
      const timer = setTimeout(done, HEAD_WAIT_MS);
      const off = this.subscribe(() => {
        if (this.current.phase !== 'starting') done();
      });
    });
  }

  /** Sync now: here, or in the engine's window. */
  syncNow(): void {
    if (this.host) void this.host.syncNow('now');
    else this.post({ notebookId: this.notebookId, command: 'sync' });
  }

  /** A thread was sent to an agent session (A1072): here, or in the engine's window. */
  agentSent(noteId: string, threadId: string): void {
    if (this.host) void this.host.agentSent(noteId, threadId);
    else this.post({ notebookId: this.notebookId, command: 'agent', noteId, threadId });
  }

  close(): void {
    this.channel?.removeEventListener('message', this.onMessage);
  }

  private heard(message: StatusMessage | null | undefined): void {
    if (!message || message.notebookId !== this.notebookId) return;
    if ('status' in message) {
      if (!this.host) this.set(message.status);
      if (message.settled) this.settling.get(message.settled)?.(message.status);
      return;
    }
    const host = this.host;
    if (!host) return;
    if (message.command === 'settle') {
      const id = message.id;
      void host.settleAll().then(
        () =>
          this.post({
            notebookId: this.notebookId,
            status: { ...host.status, here: false },
            settled: id,
          }),
        () => undefined,
      );
    } else if (message.command === 'hello') {
      this.post({ notebookId: this.notebookId, status: { ...host.status, here: false } });
    } else if (message.command === 'sync') {
      void host.syncNow('now');
    } else if (message.command === 'agent') {
      void host.agentSent(message.noteId, message.threadId);
    }
  }

  private post(message: StatusMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // A closed channel: the window is going.
    }
  }

  private set(status: GitSyncStatus): void {
    this.current = status;
    this.localState = {
      phase:
        status.phase === 'starting'
          ? 'syncing'
          : status.phase === 'syncing'
            ? 'syncing'
            : status.phase,
      detail: status.detail,
      pending: new Set(status.pending),
    };
    for (const listener of this.listeners) listener();
  }
}

/** The part of the Web Locks API the engine election uses. */
export interface EngineLocks {
  request<T>(
    name: string,
    options: { readonly mode?: LockMode; readonly signal?: AbortSignal },
    callback: (lock: Lock | null) => Promise<T>,
  ): Promise<T>;
}

export interface GitSourceDeps {
  readonly git: DesktopGit;
  /** The notebook's link registry, as the app builds one (navigation, windows). */
  readonly directory: (notes: Notes, workspace: Workspace) => NoteDirectory;
  /** Runs the engine when this window gets the lock (main and note windows: true). */
  readonly canHost: boolean;
  /** This window shows the folder notice (the main window). */
  readonly notices: boolean;
  readonly locks: EngineLocks | null;
  readonly channel: StatusChannel | null;
  /** Opens the notes store (tests: memory). */
  readonly openStore?: (name: string) => Promise<LocalNotes>;
  readonly engineKv?: (name: string) => Promise<EngineKv>;
  readonly log?: (message: string, error?: unknown) => void;
}

export class GitSource {
  readonly kind = 'git' as const;
  readonly id: string;
  readonly notes: Notes;
  readonly workspace: Workspace;
  readonly directory: NoteDirectory;
  readonly feed: GitStatusFeed;
  private infoNow: GitNotebookInfo;
  private host: GitEngineHost | null = null;
  /** The engine's run in this window (the lock's request), until it has stopped. */
  private engineRun: Promise<unknown> | null = null;
  private release: (() => void) | null = null;
  private readonly abort = new AbortController();
  private readonly offs: Array<() => void> = [];
  private readonly infoListeners = new Set<() => void>();
  /** The engine's store, open in this window for the attachments it is handed (A1032). */
  private attachmentKv: Promise<EngineKv> | null = null;

  constructor(
    info: GitNotebookInfo,
    private readonly deps: GitSourceDeps,
  ) {
    this.id = info.notebookId;
    this.infoNow = info;
    this.feed = new GitStatusFeed(this.id, deps.channel);
    const backend: LocalSyncBackend = {
      state: this.feed.local,
      subscribe: this.feed.subscribe,
      purge: async (id) => {
        // Delete for good asks the Mac's owner (D34, A828).
        const asked = await deps.git.purgeCheck(this.infoNow.localId, id);
        if (!asked?.ok) throw new Error(asked?.error.message ?? 'Not done.');
        this.workspace.markPurged(id);
      },
    };
    const opener = deps.openStore;
    // `workspace` is set just below: the registry is only called once the app runs.
    const notes = new Notes({
      openStore: (hooks) =>
        opener ? opener(gitStoreName(this.id)) : NoteStore.open(gitStoreName(this.id), hooks),
      registry: {
        unregister: (id) => this.workspace.unregisterNote(id),
        register: (id, besideId) => this.workspace.registerCopy(id, besideId),
        restorePlace: (id, folderId): RestorePlace => this.workspace.restorePlace(id, folderId),
        folderOf: (id): string | null => this.workspace.folderOfNote(id),
        restore: (id, folderId): void => this.workspace.restoreNote(id, folderId),
        notebookOf: (folderId): string | null => this.workspace.notebookOf(folderId),
      },
      backend,
      // The notebook's own salt, when it has one (`''`: the imported workspace's ids, A1021).
      periodicSalt: info.salt ?? this.id,
      isPurged: (id) => this.workspace.isPurged(id),
      attachments: this.attachmentsElsewhere(),
    });
    this.notes = notes;
    this.workspace = new Workspace({
      openStore: () => notes.openLocal(),
      notices: deps.notices,
      gitNotebook: { id: this.id, ...(info.salt !== undefined ? { salt: info.salt } : {}) },
    });
    this.offs.push(notes.watchKeeper(this.workspace.keeper));
    this.offs.push(
      this.workspace.onNotebookMove((id, notebook) => void notes.recordNotebook(id, notebook)),
    );
    this.directory = deps.directory(notes, this.workspace);
  }

  get info(): GitNotebookInfo {
    return this.infoNow;
  }

  get name(): string {
    return this.infoNow.name;
  }

  /** The Mac app's git bridge (History reads the notebook's commits through it, A858). */
  get git(): DesktopGit {
    return this.deps.git;
  }

  /**
   * Agent activity (#172, A920): what this notebook's agents changed in its folders, note places
   * and settings in the last 30 days, read from the branch on this Mac (offline too).
   */
  async agentActivity(): Promise<ActivityEntry[]> {
    return (await this.activity().list(this.workspace.doc)).entries;
  }

  /** Undoes one of them as this Mac's own change, which the next sync pushes; or says why not. */
  async undoAgentActivity(id: number): Promise<UndoResult> {
    const result = await this.activity().undo(this.workspace.doc, id, MAC_WRITER_LABEL);
    if (result.ok && !result.alreadyUndone) {
      // Stored, then pushed soon (Android asks a sync too).
      await this.workspace.flush();
      this.syncNow();
    }
    return result;
  }

  private activityReader: { readonly key: string; readonly reader: AgentActivity } | null = null;

  private activity(): AgentActivity {
    const info = this.infoNow;
    const root = info.dir ? `${info.dir}/` : '';
    const key = `${info.localId}:${root}`;
    if (this.activityReader?.key !== key) {
      const reader = new AgentActivity(
        new IpcGitTransport(this.deps.git, info.localId, root),
        new Layout(root),
        (id) => this.notes.list().find((entry) => entry.id === id)?.title ?? null,
      );
      this.activityReader = { key, reader };
    }
    return this.activityReader.reader;
  }

  /**
   * Where the notebook's attachments go and come from (T59, A1032), with the server gone: one
   * added is written to the engine's own store, which commits it with the note that uses it
   * (whichever window runs the engine: the store is the notebook's, not the window's); one this
   * device lacks is read from that store, or else from the clone at the head the engine synced.
   */
  private attachmentsElsewhere(): AttachmentsElsewhere {
    const storage = async (): Promise<EngineStorage> => {
      this.attachmentKv ??= (this.deps.engineKv ?? idbEngineKv)(engineDbName(this.id));
      try {
        return new EngineStorage(await this.attachmentKv);
      } catch (error) {
        this.attachmentKv = null;
        throw error;
      }
    };
    const retried = async <T>(run: (store: EngineStorage) => Promise<T>): Promise<T> => {
      try {
        return await run(await storage());
      } catch {
        // Closed under it (the notebook's database deleted and made again): open it afresh.
        this.attachmentKv = null;
        return run(await storage());
      }
    };
    return {
      kept: (file, bytes) => retried((store) => store.writeAttachment(file, bytes)),
      fetch: async (file) => {
        const stored = await retried((store) => store.readAttachment(file)).catch(() => null);
        if (stored) return stored;
        const head = await this.feed.head();
        if (!head) return null;
        const info = this.infoNow;
        const root = info.dir ? `${info.dir}/` : '';
        const path = new Layout(root).attachment(file);
        const read = await new IpcGitTransport(this.deps.git, info.localId, root).read(head, [
          path,
        ]);
        return read.get(path) ?? null;
      },
    };
  }

  /** Main listed it again (cadence, token, settings changed). */
  setInfo(info: GitNotebookInfo): void {
    this.infoNow = info;
    // The running engine follows a new Push after or Pull every at once.
    this.host?.setCadence(info.pushDelayS, info.pullEveryMin);
    for (const listener of this.infoListeners) listener();
  }

  onInfo(listener: () => void): () => void {
    this.infoListeners.add(listener);
    return () => this.infoListeners.delete(listener);
  }

  /**
   * Starts the notes and folders, and stands in line for the engine (A822): when this window
   * gets the lock it runs the engine until it goes.
   */
  start(): void {
    void this.notes.start().catch((error: unknown) => this.deps.log?.('notes', error));
    void this.workspace.start().catch((error: unknown) => this.deps.log?.('folders', error));
    if (!this.deps.canHost || !this.deps.locks) return;
    this.engineRun = this.deps.locks
      .request(engineLockName(this.id), { mode: 'exclusive', signal: this.abort.signal }, () =>
        this.runEngine(),
      )
      .catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name !== 'AbortError') {
          this.deps.log?.('engine', error);
        }
      });
  }

  private async runEngine(): Promise<void> {
    const info = this.infoNow;
    const kv = await (this.deps.engineKv ?? idbEngineKv)(engineDbName(this.id));
    const host = new GitEngineHost({
      notebookId: this.id,
      name: info.name,
      create: info.create,
      host: info.host,
      remote: info.remote,
      transport: new IpcGitTransport(this.deps.git, info.localId, info.dir ? `${info.dir}/` : ''),
      secrets: {
        get: async () => {
          const answer = await this.deps.git.writerSecret(info.localId);
          return answer?.ok ? answer.value : null;
        },
        set: async (secret) => {
          await this.deps.git.writerSecret(info.localId, secret);
        },
      },
      kv,
      store: () => this.notes.openLocal(),
      written: async (ids) => {
        const notes = ids.filter((id) => id !== WORKSPACE_RECORD_KEY);
        if (ids.includes(WORKSPACE_RECORD_KEY)) await this.workspace.pullStored();
        if (notes.length > 0) await this.notes.pullStored(notes);
      },
      pushDelayS: info.pushDelayS,
      pullEveryMin: info.pullEveryMin,
      ...(this.deps.log ? { log: this.deps.log } : {}),
    });
    this.host = host;
    const detach = this.feed.attach(host);
    // This window's own writes; other windows' come through `changed`.
    const offStored = this.notes.onStored((ids) => host.changed(ids));
    try {
      await host.start();
      await new Promise<void>((resolve) => {
        this.release = resolve;
        this.abort.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally {
      offStored();
      host.stop();
      detach();
      kv.close?.();
      this.host = null;
    }
  }

  /** Another window stored these records of this notebook (null: maybe any). */
  storedElsewhere(ids: readonly string[] | null): Promise<void> {
    this.host?.changed(ids);
    const notes = ids?.filter((id) => id !== WORKSPACE_RECORD_KEY) ?? null;
    const reads: Array<Promise<unknown>> = [];
    if (ids === null || ids.includes(WORKSPACE_RECORD_KEY)) reads.push(this.workspace.pullStored());
    if (notes === null || notes.length > 0) reads.push(this.notes.pullStored(notes));
    return Promise.all(reads).then(() => undefined);
  }

  syncNow(): void {
    this.feed.syncNow();
  }

  /**
   * A thread of `noteId` was sent to an agent session, or Ryan commented in one that is (A1061,
   * A1072): once the note is stored, the engine (here or in its window) pushes it at once and
   * pulls every 10 s until the reply lands or 10 minutes pass.
   */
  async agentSent(noteId: string, threadId: string): Promise<void> {
    await this.notes.saveAll();
    this.feed.agentSent(noteId, threadId);
  }

  /**
   * Changes not pushed yet (notes, and the folder tree as one), once every edit is stored and
   * taken in; null when it cannot be told (no engine has reported yet). Remove names them.
   */
  async unpushed(): Promise<{ readonly notes: number; readonly folders: boolean } | null> {
    await this.notes.saveAll();
    // The engine's window, here or another, takes in every stored change first: a window's
    // edit is counted before its announcement reaches the engine.
    const status = await this.feed.settled();
    if (!status || status.phase === 'starting') return null;
    return {
      notes: status.pending.filter((id) => id !== WORKSPACE_RECORD_KEY).length,
      folders: status.pending.includes(WORKSPACE_RECORD_KEY),
    };
  }

  /**
   * What confirming Delete for good again would take (A855), as main names it from the branch:
   * Settings lists these before it asks. Null when main could not say.
   */
  async purgesToConfirm(also: readonly string[] = []): Promise<readonly GitPendingPurge[] | null> {
    const answer = await this.deps.git.purgesToConfirm(this.infoNow.localId, also);
    return answer?.ok ? answer.value : null;
  }

  /**
   * Delete for good confirmed too long before its sync (A855): asks the Mac's owner again, once,
   * for `ids` (what Settings listed). Main confirms only notes this Mac confirmed before, and
   * refuses the lot if one was never confirmed here. Returns why not, or null when confirmed.
   */
  async reconfirmPurges(ids: readonly string[]): Promise<string | null> {
    if (ids.length === 0) return null;
    const asked = await this.deps.git.purgeCheck(this.infoNow.localId, ids);
    if (!asked?.ok) return asked?.error.message ?? 'Not done.';
    this.syncNow();
    return null;
  }

  /**
   * Keep note (A855): a Delete for good never confirmed on this Mac (a page script marked it) is
   * taken back, the note filed where it was. Nothing is deleted, so no Touch ID; the sync goes on,
   * and `undoKeep` marks it again. A purge that landed is refused ("already deleted for good").
   */
  async keepNote(id: string): Promise<string | null> {
    // Only a purge that has not landed (main checks the branch): one that landed is for good.
    const pending = await this.purgesToConfirm([id]);
    if (!pending?.some((note) => note.id === id)) {
      return 'This note is already deleted for good in the repository, so Keep note did nothing.';
    }
    this.workspace.unmarkPurged(id);
    await this.notes.saveAll();
    this.syncNow();
    return null;
  }

  /** Undoes Keep note: the note is marked deleted for good again, as it was. */
  async undoKeep(id: string): Promise<void> {
    this.workspace.markPurged(id);
    await this.notes.saveAll();
  }

  /**
   * Delete for good of a note never confirmed on this Mac: main's owner check, naming the note as
   * the branch has it. Returns why not, or null when confirmed (the sync goes on).
   */
  async confirmPurge(id: string): Promise<string | null> {
    const asked = await this.deps.git.purgeCheck(this.infoNow.localId, id);
    if (!asked?.ok) return asked?.error.message ?? 'Not done.';
    this.syncNow();
    return null;
  }

  /**
   * History's restore or revert asks the Mac's owner first, naming the note as the branch has it,
   * as Android's does (A877, A901). Returns why not, or null when the owner confirmed.
   */
  async restoreCheck(id: string, revert: boolean): Promise<string | null> {
    const asked = await this.deps.git.restoreCheck(this.infoNow.localId, id, revert);
    if (!asked?.ok) return asked?.error.message ?? 'Not done.';
    return null;
  }

  /** Whether this window runs the engine now. */
  get hostsEngine(): boolean {
    return this.host !== null;
  }

  /** As the window closes or the app quits: every change stored, then one short sync (A825). */
  async beforeClose(): Promise<void> {
    await this.notes.saveAll();
    await this.host?.beforeClose();
  }

  /**
   * Main asks the windows to store (#174 review): `close`, as a window closes or the app quits,
   * stores and pushes (`beforeClose`); `flush` only stores, starting no sync and stopping none
   * itself. Before the capture window reads the store, that is all. Before a title bar change,
   * main then reopens the windows: a sync still running in one ends with its page, as at any
   * window close, and what it had not pushed still waits in the engine's store, so the
   * reopened window's first sync pushes it (A724, A927).
   */
  async store(reason: 'close' | 'flush'): Promise<void> {
    if (reason === 'close') return this.beforeClose();
    await this.notes.saveAll();
  }

  /**
   * Stops it in this window, as `stop`, and resolves once its engine has: a sync running then
   * finishes first, so nothing of it still writes (its git calls included).
   */
  async halt(): Promise<void> {
    const host = this.host;
    this.stop();
    await host?.idle();
    await this.engineRun;
  }

  /** Stops it in this window: the engine's lock goes to the next window in line. */
  stop(): void {
    this.abort.abort();
    this.release?.();
    for (const off of this.offs.splice(0)) off();
    this.notes.stop();
    this.workspace.stop();
    this.feed.close();
    void this.attachmentKv?.then((kv) => kv.close?.()).catch(() => undefined);
    this.attachmentKv = null;
  }
}
