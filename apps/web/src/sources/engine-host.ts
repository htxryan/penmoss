/**
 * A git notebook's engine in the Mac app (T50 G3, G5; A822, A860, A862). One window per notebook
 * runs it (`EngineLock`); every window edits its own copies of the docs and stores them in the
 * notebook's notes store, as a server note's windows do. The engine:
 *
 * - takes in what the windows stored (A851: `adopt`, as a local change, so it is pushed) when a
 *   window says it stored something, and at its start everything stored since it last looked;
 * - syncs through the main process's git (`IpcGitTransport`): a push once edits settle, a pull
 *   on focus, on being shown again and on an interval (A1013: 12 s and 1 min by default), Sync
 *   now, and one short sync as the window closes (A825);
 * - writes what the repository changed into the store, so every window shows it.
 *
 * Its status is bounded (A859): a sync that runs out of time is stopped and counts as offline,
 * and every failure says when it tries again. Edits are never lost: they stay marked until a push
 * lands (A822).
 */
import { readThread } from '@penmoss/sync-client/comments';
import { WORKSPACE_RECORD_KEY } from '@penmoss/sync-client/workspace';
import { recordFromDoc } from '@penmoss/sync-client/records';
import type { NoteRecord } from '@penmoss/sync-client';
import {
  GitNotebookEngine,
  GitTransportError,
  isLocalRemote,
  isPurged,
  privateEmailAdvice,
  NotebookError,
  type GitChanges,
  type GitTransport,
  type SyncReport,
  type WriterSecrets,
} from '@penmoss/git-notebook';
import type { LocalNotes } from '../notes/service';
import { EngineStorage } from './engine-store';
import { GitRefused } from './ipc-transport';

/** What Settings → Notebooks and the pill show of a notebook's sync (A860). */
export interface GitSyncStatus {
  readonly phase: 'starting' | 'syncing' | 'synced' | 'offline' | 'stopped';
  /** Why it is offline or stopped, in plain words (with what to do). */
  readonly detail: string | null;
  /** What the host said, as it said it (A824). */
  readonly hostMessage: string | null;
  /** The refusal's code (`auth`, `not_found`, `network`, …), when it failed. */
  readonly code: string | null;
  readonly lastSyncAt: number | null;
  /** When it tries again after a failure (epoch ms). */
  readonly nextRetryAt: number | null;
  /** Notes (and `workspace`) with changes not in a pushed commit yet. */
  readonly pending: readonly string[];
  /** Rendered files someone edited by hand that the last render overwrote (A823). */
  readonly handEdits: readonly string[];
  /** Files at the head this device could not read (path → why). */
  readonly skipped: Readonly<Record<string, string>>;
  readonly head: string | null;
  /** Whether this window runs the engine (the others show what it says). */
  readonly here: boolean;
  /**
   * The engine's store was found cleared at its last start (A886): its writer was gone though
   * main still held its secret. `kept`: the windows' copies were there and were taken in again;
   * `lost`: they were cleared too, so changes not pushed before could not be kept. Null otherwise.
   */
  readonly cleared?: 'kept' | 'lost' | null;
  /**
   * Notes whose copy in the windows' store could not be read when taken in (A886): left in the
   * store as they are, skipped, so the notebook still opens and syncs the rest.
   */
  readonly unreadable?: readonly string[];
  /** Whether the stores are kept under low storage (`navigator.storage.persist()`); null: unknown. */
  readonly storageKept?: boolean | null;
  /** The app is quitting and waits for this push (#170 F8): "Pushing…". */
  readonly closing?: boolean;
}

/** This Mac's writer, as commits and History name it (A825). */
export const MAC_WRITER_LABEL = 'Penmoss for Mac';

export const STARTING: GitSyncStatus = {
  phase: 'starting',
  detail: null,
  hostMessage: null,
  code: null,
  lastSyncAt: null,
  nextRetryAt: null,
  pending: [],
  handEdits: [],
  skipped: {},
  head: null,
  here: false,
};

/** The longest one sync may take before it is stopped and counted as offline (A859). */
export const SYNC_LIMIT_MS = 90_000;
/**
 * As the window closes or the app quits (A825, #170 F8): how long a push may take, one already
 * running included; main waits this long, and a little more, for the window. A sync on a slow
 * Mac takes longer than the 2.5 s it once had, so the push was left to the next launch.
 */
export const CLOSING_SYNC_MS = 10_000;
/** Kept when a push could not finish before the app quit: the next start pushes first. */
const OWED_KEY = 'pushOwed';
/** Failures back off from this, doubling to `RETRY_MAX_MS`. */
export const RETRY_MIN_MS = 30_000;
export const RETRY_MAX_MS = 10 * 60_000;
/** A focus pulls at most this often. */
export const FOCUS_PULL_GAP_MS = 30_000;
/** Edits that keep coming are pushed at least this many push delays after the first. */
const MAX_DELAYS = 5;
/** After a Send to (A1065, A1072): the notebook is pulled this often… */
export const REPLY_PULL_MS = 10_000;
/** …for this long, or until the thread's delivery is replied. */
export const REPLY_WATCH_MS = 10 * 60_000;

export interface EngineHostOptions {
  readonly notebookId: string;
  readonly name: string;
  /** This Mac makes the notebook: the target held none when it was added. */
  readonly create: boolean;
  readonly host: string;
  /** `cancel` stops the git running now; it resolves once main has stopped it. */
  readonly transport: GitTransport & { cancel?(): void | Promise<void> };
  readonly secrets: WriterSecrets;
  readonly kv: ConstructorParameters<typeof EngineStorage>[0];
  /** The notebook's notes store (the windows' records). */
  readonly store: () => Promise<LocalNotes>;
  /** The repository changed these records: show them here (the store tells other windows). */
  readonly written: (ids: readonly string[]) => Promise<void>;
  readonly pushDelayS: number;
  readonly pullEveryMin: number;
  readonly label?: string;
  readonly now?: () => number;
  /** The longest one sync may take (default `SYNC_LIMIT_MS`; tests shorten it). */
  readonly syncLimitMs?: number;
  /** The longest a push may take as the app quits (default `CLOSING_SYNC_MS`; tests shorten it). */
  readonly closingSyncMs?: number;
  /** The remote as given: one on this Mac (file://, loopback) never waits for the network. */
  readonly remote?: string;
  /** How long the network must stay up before a sync chases it (default `ONLINE_SETTLE_MS`). */
  readonly onlineSettleMs?: number;
  readonly log?: (message: string, error?: unknown) => void;
}

/**
 * How long the network must stay up after an `online` event before the backoff is reset and a
 * sync runs (#174 review): a network that flaps is not chased on every event.
 */
export const ONLINE_SETTLE_MS = 2000;

/** A sync that ran out of time (A859). */
class SyncTimeout extends Error {
  constructor(ms: number) {
    super(`The git host did not answer within ${Math.round(ms / 1000)} s.`);
    this.name = 'SyncTimeout';
  }
}

export class GitEngineHost {
  private engine: GitNotebookEngine | null = null;
  private storage: EngineStorage;
  private adopted = new Map<string, string>();
  /** Records that could not be taken in (A886), by id. */
  private readonly unreadable = new Set<string>();
  private current: GitSyncStatus = { ...STARTING, here: true };
  private readonly listeners = new Set<(status: GitSyncStatus) => void>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private firstChangeAt: number | null = null;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private lastPullAt = -Infinity;
  private syncing: Promise<void> | null = null;
  private onlineTimer: ReturnType<typeof setTimeout> | null = null;
  /** The remote is on this Mac (file://, loopback): the network says nothing about it. */
  private readonly local: boolean;
  private closingRun: Promise<void> | null = null;
  private again = false;
  /** A Sync now was asked during the running sync: the one after it is a Sync now too. */
  private againAsked = false;
  private stopped = false;
  /** Records named by a window since the last adopt (null: read every record). */
  private named: Set<string> | null = new Set();
  private adopting: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly offs: Array<() => void> = [];
  private pushDelayS: number;
  private pullEveryMin: number;
  /** Counts syncs, so a late answer from a stopped one never overrides a newer status. */
  private generation = 0;
  /** Threads sent to an agent session (A1072): `noteId/threadId` → when the watch ends. */
  private readonly watched = new Map<
    string,
    { readonly noteId: string; readonly threadId: string; readonly until: number }
  >();
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: EngineHostOptions) {
    this.storage = new EngineStorage(options.kv);
    this.now = options.now ?? Date.now;
    this.pushDelayS = options.pushDelayS;
    this.local = options.remote !== undefined && isLocalRemote(options.remote);
    this.pullEveryMin = options.pullEveryMin;
  }

  /** Settings changed Push after or Pull every: the running engine follows at once. */
  setCadence(pushDelayS: number, pullEveryMin: number): void {
    const pullChanged = pullEveryMin !== this.pullEveryMin;
    this.pushDelayS = pushDelayS;
    this.pullEveryMin = pullEveryMin;
    if (this.stopped || !this.engine) return;
    if (pullChanged) this.startPulling();
    // A push already waiting goes at the new delay.
    if (this.pushTimer) {
      this.firstChangeAt = null;
      this.schedulePush();
    }
  }

  private startPulling(): void {
    if (this.pullTimer) clearInterval(this.pullTimer);
    const every = Math.max(1, this.pullEveryMin) * 60_000;
    this.pullTimer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void this.syncNow('pull');
    }, every);
  }

  get status(): GitSyncStatus {
    return this.current;
  }

  onStatus(listener: (status: GitSyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<GitSyncStatus>): void {
    const pending = this.engine ? pendingOf(this.engine) : this.current.pending;
    this.current = { ...this.current, pending, ...patch, here: true };
    for (const listener of this.listeners) listener(this.current);
  }

  /**
   * Opens the engine, takes in everything the windows stored since it last looked, and syncs.
   * Resolves once the engine is open (the first sync runs on its own).
   */
  async start(): Promise<void> {
    const engine = await GitNotebookEngine.open({
      transport: this.options.transport,
      storage: this.storage,
      secrets: this.options.secrets,
      writer: { kind: 'device', label: this.options.label ?? MAC_WRITER_LABEL },
      // What a sync fetched stays saved until the store holds it: a window that went mid-sync
      // leaves it to this one.
      confirmDelivery: true,
      ...(this.options.create
        ? { create: { id: this.options.notebookId, name: this.options.name } }
        : {}),
    });
    this.engine = engine;
    // Ask that the stores be kept under low storage, and say what was answered (A886).
    const storageKept = await persistStorage();
    // A store with no writer, though main holds this notebook's writer secret: it synced here
    // before, and its store was cleared since (A886). The windows' copies, if they are still
    // there, are taken in again below (A851); if not, what was not pushed is gone, and the
    // person is told so rather than nothing.
    const secret =
      engine.writer === null ? await this.options.secrets.get().catch(() => null) : null;
    const wasCleared = engine.writer === null && secret !== null;
    const windowsHeld = wasCleared
      ? (await (await this.options.store()).listMeta()).length > 0
      : false;
    this.adopted = await this.storage.adopted();
    this.named = null;
    await this.adoptStored();
    this.set({ storageKept, cleared: wasCleared ? (windowsHeld ? 'kept' : 'lost') : null });
    // What an engine before this one fetched and never got into the store.
    await this.deliver(engine).catch((failure: unknown) =>
      this.options.log?.('could not show what git changed', failure),
    );
    // Stored while that read ran: taken in now.
    const since = this.named as Set<string> | null;
    if (since === null || since.size > 0) this.changed([]);
    this.set({});
    if (typeof window !== 'undefined') {
      const onFocus = () => this.focused();
      // The network went or came back (#170 F9): say Offline at once rather than after the next
      // push fails, and try again at once rather than after the backoff.
      const onOffline = () => this.wentOffline();
      const onOnline = () => this.cameOnline();
      const target = window;
      target.addEventListener('focus', onFocus);
      target.addEventListener('offline', onOffline);
      target.addEventListener('online', onOnline);
      this.offs.push(() => {
        target.removeEventListener('focus', onFocus);
        target.removeEventListener('offline', onOffline);
        target.removeEventListener('online', onOnline);
      });
    }
    // Shown again (unhidden, or back from another Space) pulls as a focus does (A1013): the
    // interval skips its pulls while the window is hidden.
    if (typeof document !== 'undefined') {
      const doc = document;
      const onVisible = () => {
        if (!doc.hidden) this.focused();
      };
      doc.addEventListener('visibilitychange', onVisible);
      this.offs.push(() => doc.removeEventListener('visibilitychange', onVisible));
    }
    this.startPulling();
    // A push the last quit could not finish (#170 F8) goes first, and says so.
    if ((await this.options.kv.get(OWED_KEY).catch(() => undefined)) !== undefined) {
      this.set({ detail: 'Pushing what was not pushed when Penmoss last quit.' });
    }
    void this.syncNow('start');
  }

  /** Windows stored these records (null: maybe any): taken in, then pushed once they settle. */
  changed(ids: readonly string[] | null): void {
    // Before the engine is open there is nothing to take them into: `start` reads every record.
    if (this.stopped || !this.engine) return;
    if (ids === null) this.named = null;
    else if (this.named) for (const id of ids) this.named.add(id);
    this.adopting ??= Promise.resolve()
      .then(() => this.adoptStored())
      .catch((error: unknown) => this.options.log?.('could not take in stored changes', error))
      .finally(() => {
        this.adopting = null;
        if (this.named === null || this.named.size > 0) this.changed([]);
      });
  }

  /**
   * A thread of `noteId` was sent to an agent session, or Ryan commented in one that is (A1061,
   * A1072): the note is taken in and pushed at once, skipping the push delay, and the notebook
   * is then pulled every REPLY_PULL_MS for REPLY_WATCH_MS, or until the thread's delivery is
   * replied, whichever is first; then only the usual pull runs. The window that wrote it stored
   * the note before asking.
   */
  agentSent(noteId: string, threadId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.named?.add(noteId);
    this.watched.set(`${noteId}/${threadId}`, {
      noteId,
      threadId,
      until: this.now() + REPLY_WATCH_MS,
    });
    this.watchTimer ??= setInterval(() => this.watchTick(), REPLY_PULL_MS);
    return this.syncNow('push');
  }

  /** The threads still watched for a reply (tests). */
  get watchedThreads(): readonly string[] {
    return [...this.watched.keys()];
  }

  /** Drops the watches that are over: replied, untargeted, gone or out of time. */
  private settleWatches(): void {
    const engine = this.engine;
    for (const [key, watch] of this.watched) {
      const doc = engine?.replica.note(watch.noteId) ?? null;
      const thread = doc ? readThread(doc, watch.threadId) : null;
      const over =
        this.now() >= watch.until ||
        (engine !== null &&
          (!thread ||
            !thread.target ||
            thread.status === 'resolved' ||
            thread.delivery?.state === 'replied'));
      if (over) this.watched.delete(key);
    }
    if (this.watched.size === 0 && this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  private watchTick(): void {
    this.settleWatches();
    // Hidden or not: the reply is what Ryan waits for, and the watch ends on its own (A1072).
    if (this.watched.size > 0) void this.syncNow('pull').then(() => this.settleWatches());
  }

  /**
   * Takes in everything the windows stored up to now, reading every record (a window's
   * announcement may not have come yet), before Remove counts what is unpushed.
   */
  async settleAll(): Promise<void> {
    await this.adopting;
    this.named = null;
    await this.adoptStored();
  }

  /**
   * Whether the browser says this Mac has no network (`navigator.onLine`, #170 F9). Never for a
   * remote on this Mac (file://, loopback), which needs none (#174 review).
   */
  private offlineNow(): boolean {
    if (this.local) return false;
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  private offlineStatus(): Partial<GitSyncStatus> {
    return {
      phase: 'offline',
      code: 'network',
      detail: `This Mac is offline. Changes stay on this device and go once it is back online.`,
      hostMessage: null,
      nextRetryAt: null,
    };
  }

  private wentOffline(): void {
    if (this.onlineTimer) clearTimeout(this.onlineTimer);
    this.onlineTimer = null;
    if (this.stopped || !this.engine || this.local) return;
    if (!this.syncing) this.set(this.offlineStatus());
  }

  private cameOnline(): void {
    if (this.stopped || !this.engine) return;
    if (this.onlineTimer) clearTimeout(this.onlineTimer);
    // Once it has stayed up a moment (#174 review): a flapping network neither resets the
    // backoff nor starts a sync on every event.
    this.onlineTimer = setTimeout(() => {
      this.onlineTimer = null;
      if (this.stopped || !this.engine || this.offlineNow()) return;
      if (this.current.phase !== 'offline' && pendingOf(this.engine).length === 0) return;
      // At once: not after the backoff of the failures while it was offline.
      this.failures = 0;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      void this.syncNow('retry');
    }, this.options.onlineSettleMs ?? ONLINE_SETTLE_MS);
  }

  private focused(): void {
    if (this.now() - this.lastPullAt < FOCUS_PULL_GAP_MS) return;
    void this.syncNow('pull');
  }

  /** Takes in the records windows stored that the engine has not seen (A851). */
  private async adoptStored(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    const store = await this.options.store();
    const named = this.named;
    this.named = new Set();
    const ids = named ? [...named] : await allRecordIds(store);
    let any = false;
    await engine.exclusive(async () => {
      for (const id of ids) {
        const record = await store.get(id);
        if (!record) continue;
        if (this.adopted.get(id) === revOf(record)) continue;
        if (this.take(engine, record)) any = true;
      }
      await engine.save();
      await this.storage.setAdopted(this.adopted);
    });
    this.set(any && this.offlineNow() && !this.syncing ? this.offlineStatus() : {});
    if (any) this.schedulePush();
  }

  /**
   * Takes in one record; true when it held anything new. One that cannot be read is logged,
   * left in the store and named (A886): it never stops the notebook opening or syncing the rest.
   * It is marked taken in only once it is, so it is tried again at the next look and after a
   * restart, and named again until then.
   */
  private take(engine: GitNotebookEngine, record: NoteRecord): boolean {
    const id = record.noteId;
    let changed: boolean;
    try {
      changed =
        id === WORKSPACE_RECORD_KEY
          ? engine.replica.adopt(null, record.update)
          : // A note deleted for good is never taken back in (A828).
            !isPurged(engine.replica.workspace, id) && engine.replica.adopt(id, record.update);
    } catch (error) {
      if (!this.unreadable.has(id)) {
        this.options.log?.('could not read a stored copy; it is left as it is', error);
        this.unreadable.add(id);
        this.set({ unreadable: [...this.unreadable] });
      }
      return false;
    }
    this.adopted.set(id, revOf(record));
    if (this.unreadable.delete(id)) this.set({ unreadable: [...this.unreadable] });
    return changed;
  }

  private schedulePush(): void {
    if (this.stopped) return;
    const delay = Math.max(1, this.pushDelayS) * 1000;
    this.firstChangeAt ??= this.now();
    const latest = this.firstChangeAt + delay * MAX_DELAYS;
    const at = Math.min(this.now() + delay, latest);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(
      () => {
        this.pushTimer = null;
        void this.syncNow('push');
      },
      Math.max(0, at - this.now()),
    );
  }

  /**
   * Syncs now (Sync now, a push, a pull). One sync at a time; asked during one, another runs
   * after it. Never rejects: a failure is in `status`, and a retry is scheduled.
   */
  syncNow(reason: 'start' | 'push' | 'pull' | 'now' | 'retry' | 'closing' = 'now'): Promise<void> {
    if (this.stopped && reason !== 'closing') return Promise.resolve();
    if (this.syncing) {
      // Sync now pressed during one runs after it as a Sync now (#174 delta review): tried
      // whatever the network says, so it never ends on an Offline the browser guessed.
      this.again = true;
      if (reason === 'now') this.againAsked = true;
      return this.syncing.then(() => this.syncing ?? undefined);
    }
    this.syncing = this.runSync(
      reason === 'closing' ? this.closingMs() : (this.options.syncLimitMs ?? SYNC_LIMIT_MS),
      // Sync now (a person's) always tries: the browser's word on the network may be wrong.
      reason === 'now',
    ).finally(() => {
      this.syncing = null;
      if (this.again && !this.stopped) {
        const asked = this.againAsked;
        this.again = false;
        this.againAsked = false;
        void this.syncNow(asked ? 'now' : 'push');
      }
    });
    return this.syncing;
  }

  private closingMs(): number {
    return this.options.closingSyncMs ?? CLOSING_SYNC_MS;
  }

  private async runSync(limitMs: number, asked = false): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    if (!asked && this.offlineNow()) {
      // No network: nothing to try (#170 F9); the online event tries again at once.
      this.set(this.offlineStatus());
      return;
    }
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.firstChangeAt = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.lastPullAt = this.now();
    const generation = ++this.generation;
    this.set({ phase: 'syncing' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sync: Promise<SyncReport> | null = null;
    const stop = new AbortController();
    try {
      // What windows stored up to now goes in this sync.
      await this.adoptStored();
      sync = engine.sync({ signal: stop.signal });
      const report = await Promise.race([
        sync,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Stopped for good: no git call after this one (the engine checks the signal), and
            // the one running is killed in main before this counts as offline.
            stop.abort();
            void Promise.resolve(this.options.transport.cancel?.())
              .catch(() => undefined)
              .then(() => reject(new SyncTimeout(limitMs)));
          }, limitMs);
        }),
      ]);
      clearTimeout(timer);
      await this.writeBack(engine, report);
      this.landed(report);
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof SyncTimeout && sync) {
        // The stopped sync ends on its own: what it applied still reaches the windows, and a
        // push that landed after all is shown as synced, not offline.
        void sync.then(
          async (report) => {
            await this.writeBack(engine, report);
            if (this.generation === generation && !this.syncing) this.landed(report);
          },
          () => this.deliver(engine),
        );
      } else {
        // A fetch applied before a push failed: the windows show what it brought.
        await this.deliver(engine).catch((failure: unknown) =>
          this.options.log?.('could not show what git changed', failure),
        );
      }
      this.failed(error);
    }
  }

  /** A sync landed (or found nothing to commit). */
  private landed(report: SyncReport): void {
    const engine = this.engine;
    if (!engine) return;
    this.failures = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (pendingOf(engine).length === 0)
      void this.options.kv.write([], [OWED_KEY]).catch(() => undefined);
    this.set({
      phase: 'synced',
      detail: null,
      hostMessage: null,
      code: null,
      lastSyncAt: this.now(),
      nextRetryAt: null,
      handEdits: report.handEdits,
      skipped: report.skipped,
      head: report.head,
    });
    // Edits made while it synced go at the next push.
    if (pendingOf(engine).length > 0) this.schedulePush();
  }

  /** What the repository changed that no report gave (a sync that failed after its fetch). */
  private async deliver(engine: GitNotebookEngine): Promise<void> {
    const changes = engine.takeGitChanges();
    if (changes.changed.length === 0 && !changes.workspaceChanged && changes.purged.length === 0) {
      return;
    }
    await this.writeBack(engine, changes);
  }

  /** What the repository changed goes into the store, so every window shows it. */
  private async writeBack(engine: GitNotebookEngine, report: GitChanges): Promise<void> {
    const store = await this.options.store();
    const written: string[] = [];
    const ids = [...report.changed, ...(report.workspaceChanged ? [WORKSPACE_RECORD_KEY] : [])];
    for (const id of ids) {
      const doc = id === WORKSPACE_RECORD_KEY ? engine.replica.workspace : engine.replica.note(id);
      if (!doc) continue;
      let wrote: NoteRecord | null = null;
      await store.update(id, (current) => {
        // A window's change stored since the engine last looked is taken in first (synchronous),
        // so the record written holds it too and nothing is skipped.
        if (current && this.adopted.get(id) !== revOf(current)) this.take(engine, current);
        // A window's copy that could not be read stays as it is, never written over (A886).
        if (current && this.unreadable.has(id)) return null;
        wrote = recordFromDoc(id, doc, {
          epoch: null,
          unsynced: current?.unsynced ?? false,
          updatedAt: this.now(),
        });
        return wrote;
      });
      if (wrote) {
        this.adopted.set(id, revOf(wrote));
        written.push(id);
      }
    }
    for (const id of report.purged) {
      await store.delete?.(id);
      this.adopted.delete(id);
      written.push(id);
    }
    await engine.exclusive(async () => {
      // The store holds it all now: not given again.
      engine.confirmGitChanges(report);
      await engine.save();
      await this.storage.setAdopted(this.adopted);
    });
    if (written.length > 0) await this.options.written(written);
  }

  private failed(error: unknown): void {
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.failures++);
    const nextRetryAt = this.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.syncNow('retry');
    }, delay);
    const described = describe(error, this.options.host);
    if (described.log) this.options.log?.('git sync failed', error);
    this.set({ ...described.status, nextRetryAt });
  }

  /**
   * As the window closes or the app quits: the push of what waits (A825, #170 F8), "Pushing…"
   * meanwhile. A push already running is given the time to finish; if it cannot, it is stopped
   * and kept as owed, so the next start pushes it first. Nothing is lost either way.
   */
  async beforeClose(): Promise<void> {
    // Every window asks as the app quits, at once: one close for them all, so none returns
    // while another's push still runs (and the app quits under it).
    this.closingRun ??= this.closeNow().finally(() => {
      this.closingRun = null;
    });
    return this.closingRun;
  }

  private async closeNow(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    // "Pushing…" only while something waits to be pushed.
    if (this.syncing && pendingOf(engine).length > 0) this.set({ closing: true });
    // One closing time for all of it: the push running, what the windows stored, one push more.
    const timeUp = sleep(this.closingMs()).then(() => false);
    const within = (work: () => Promise<unknown>) =>
      Promise.race([
        work().then(
          () => true,
          () => true,
        ),
        timeUp,
      ]);
    let finished = await within(async () => {
      // A push running holds the engine; then every record, not only those announced: the
      // last keystrokes this window stored as it closed may not have been announced yet.
      await this.idle();
      await this.adopting;
      this.named = null;
      await this.adoptStored();
    });
    if (finished && pendingOf(engine).length === 0) {
      this.set({ closing: false });
      return;
    }
    if (pendingOf(engine).length > 0) this.set({ closing: true });
    try {
      if (finished) {
        // What waits still (all of it, or what was edited while that push ran): one push more,
        // after any sync an edit started meanwhile.
        finished = await within(async () => {
          await this.idle();
          if (pendingOf(engine).length > 0) await this.syncNow('closing');
          await this.idle();
        });
      }
      // Out of time: a push with something waiting is stopped and owed. A sync with nothing
      // waiting (a pull) is never stopped: there is nothing to lose (#174 review).
      if (!finished && pendingOf(engine).length > 0) {
        await Promise.resolve(this.options.transport.cancel?.()).catch(() => undefined);
      }
    } finally {
      if (pendingOf(engine).length > 0) {
        await this.options.kv.write([[OWED_KEY, this.now()]]).catch(() => undefined);
      }
      this.set({ closing: false });
    }
  }

  /** Resolves once no sync runs (one asked during another included). */
  async idle(): Promise<void> {
    while (this.syncing) await this.syncing;
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.onlineTimer) clearTimeout(this.onlineTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.watched.clear();
    this.pushTimer = null;
    this.pullTimer = null;
    this.retryTimer = null;
    this.onlineTimer = null;
  }

  /** Test hook: the engine's own copy. */
  get engineForTests(): GitNotebookEngine | null {
    return this.engine;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A record's version as the engine remembers it (records from before `rev` by their time). */
const revOf = (record: NoteRecord) => record.rev ?? `t${record.updatedAt}`;

/** Every record in the store (notes, trashed ones, and the WorkspaceDoc). */
async function allRecordIds(store: LocalNotes): Promise<string[]> {
  const metas = await store.listMeta();
  return [WORKSPACE_RECORD_KEY, ...metas.map((meta) => meta.noteId)];
}

/** What the engine has not pushed yet: its marked notes, and the WorkspaceDoc. */
export function pendingOf(engine: GitNotebookEngine): string[] {
  const state = engine.replica.state;
  return [...Object.keys(state.dirty), ...(state.workspaceDirty ? [WORKSPACE_RECORD_KEY] : [])];
}

/** A failure as Status shows it (A824, A859): offline, or stopped, saying why and what to do. */
export function describe(
  error: unknown,
  host: string,
): { status: Partial<GitSyncStatus>; log: boolean } {
  const kept = 'Changes stay on this device and go once it syncs.';
  if (error instanceof SyncTimeout) {
    return {
      status: {
        phase: 'offline',
        code: 'timeout',
        detail: `${error.message} ${kept}`,
        hostMessage: null,
      },
      log: false,
    };
  }
  if (error instanceof GitRefused) {
    return {
      status: {
        phase: 'stopped',
        code: error.code,
        detail: error.message,
        hostMessage: error.hostMessage ?? null,
      },
      log: false,
    };
  }
  if (error instanceof GitTransportError) {
    const hostMessage = error.hostMessage ?? null;
    switch (error.code) {
      case 'network':
      case 'timeout':
        return {
          status: {
            phase: 'offline',
            code: error.code,
            detail: `Can't reach ${host}. ${kept}`,
            hostMessage,
          },
          log: false,
        };
      case 'auth':
        return {
          status: {
            phase: 'stopped',
            code: 'auth',
            detail: `Can't sign in to ${host}. Check git's credentials for it, or use a personal access token in Settings → Notebooks. ${kept}`,
            hostMessage,
          },
          log: false,
        };
      case 'protected':
      case 'rules':
      case 'refused':
        return {
          status: {
            phase: 'stopped',
            code: error.code,
            detail:
              privateEmailAdvice(
                hostMessage ?? error.message,
                'set it as this notebook’s commit email in Settings → Notebooks, or as git’s user.email',
              ) ?? `${host} refused the push${hostMessage ? `: ${hostMessage}` : '.'} ${kept}`,
            hostMessage,
          },
          log: false,
        };
      default:
        return {
          status: {
            phase: 'stopped',
            code: error.code,
            detail: `${error.message} ${kept}`,
            hostMessage,
          },
          log: error.code === 'git',
        };
    }
  }
  if (error instanceof NotebookError) {
    return {
      status: { phase: 'stopped', code: error.code, detail: error.message, hostMessage: null },
      log: false,
    };
  }
  return {
    status: {
      phase: 'stopped',
      code: 'error',
      detail: `${error instanceof Error ? error.message : String(error)} ${kept}`,
      hostMessage: null,
    },
    log: true,
  };
}

/**
 * `navigator.storage.persist()` (A886): true once the stores are kept under low storage, false
 * when refused, null where it cannot be asked.
 */
export async function persistStorage(): Promise<boolean | null> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage || typeof storage.persist !== 'function') return null;
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return null;
  }
}
