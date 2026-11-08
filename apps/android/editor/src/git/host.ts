/**
 * A git notebook's engine on Android (T50 G7, G8; A822, A825, A859, A872): the TypeScript engine
 * every client runs, in a WebView with no screen of its own, beside the editor's. The app's
 * Kotlin moves bytes (JGit, the Keystore) and keeps Room; this page merges, renders and answers
 * the notes server (`server.ts`) that Room syncs with. Kotlin never reads Yjs (A11).
 *
 * As the Mac's `GitEngineHost`: a push once edits settle (N seconds, at most five delays after the
 * first), a pull on resume and every M minutes while the app is in front, Sync now, and one short
 * sync as the app leaves the screen; every sync bounded (90 s, then it is stopped for good and
 * counts as offline), failures retried from 30 s doubling to 10 min. The phone's background runs
 * (WorkManager, G8) call `sync` with their own limit.
 */
import {
  GitNotebookEngine,
  GitTransportError,
  isLoopbackHost,
  privateEmailAdvice,
  NotebookError,
  NotebookOps,
  type CopyToWithhold,
  type SyncReport,
  type WriterSecrets,
} from '@penmoss/git-notebook';
import { LocalNotebook } from '@penmoss/git-notebook/local';
import { EngineStorage, type EngineKv } from '../../../../web/src/sources/engine-store';
import { GitRefused, type BridgeTransport } from './bridge-transport';
import {
  emptyState,
  LocalServer,
  SERVER_STATE_KEY,
  type LocalReply,
  type LocalRequest,
  type RecoverAnswer,
  type ServerHooks,
  type ServerState,
} from './server';

/** What the app shows of a notebook's sync (Settings → Git notebooks, the status line). */
export interface GitSyncStatus {
  readonly phase: 'starting' | 'syncing' | 'synced' | 'offline' | 'stopped';
  readonly detail: string | null;
  readonly hostMessage: string | null;
  readonly code: string | null;
  /** When this sync began (epoch ms), while syncing: the app says "Waiting for …" after a while. */
  readonly since: number | null;
  readonly lastSyncAt: number | null;
  readonly nextRetryAt: number | null;
  /** Notes (and `workspace`) with changes not in a pushed commit yet. */
  readonly pending: readonly string[];
  readonly handEdits: readonly string[];
  readonly skipped: Readonly<Record<string, string>>;
  readonly head: string | null;
}

export const STARTING: GitSyncStatus = {
  phase: 'starting',
  detail: null,
  hostMessage: null,
  code: null,
  since: null,
  lastSyncAt: null,
  nextRetryAt: null,
  pending: [],
  handEdits: [],
  skipped: {},
  head: null,
};

/** The longest one sync may take in front before it is stopped and counted as offline (A859). */
export const SYNC_LIMIT_MS = 90_000;
/**
 * As the app leaves the screen (A825): what waits is pushed, a push already running is given
 * the time to finish; as on the Mac (#170 F8, #174 review), 10 s, after which it is stopped and
 * the app's background run pushes it soon.
 */
export const CLOSING_SYNC_MS = 10_000;
/** How long the network must stay up before a sync chases it (#174 review, as the Mac's). */
export const ONLINE_SETTLE_MS = 2000;
export const RETRY_MIN_MS = 30_000;
export const RETRY_MAX_MS = 10 * 60_000;
/**
 * The sync cadence (A1013): push 12 s after edits settle, pull every minute while the app is
 * visible (and on focus and open), as on the Mac. The app sends each notebook's own.
 */
export const PUSH_DELAY_S = 12;
export const PULL_EVERY_MIN = 1;
/** Coming to the front pulls at most this often. */
export const FRONT_PULL_GAP_MS = 30_000;
const MAX_DELAYS = 5;

export interface HostOptions {
  readonly notebookId: string;
  readonly name: string;
  /** This phone makes the notebook: the target held none when it was added. */
  readonly create: boolean;
  /** `github.com`, or `this phone` for a repository on the phone. */
  readonly host: string;
  /** The writer's label (`Penmoss for Android (Pixel 10 Pro)`). */
  readonly label: string;
  readonly pushDelayS: number;
  readonly pullEveryMin: number;
  /** The app is on screen: the pull timer runs (G8: in the background, WorkManager pulls). */
  readonly front: boolean;
  readonly transport: BridgeTransport;
  readonly secrets: WriterSecrets;
  readonly kv: EngineKv;
  /** The app's owner checks (A855, A877): Kotlin's own words, Kotlin's prompt. */
  readonly confirmPurge: (noteId: string) => Promise<void>;
  readonly confirmRestore: (noteId: string, version: number, revert: boolean) => Promise<void>;
  /** Told whenever the status changes, and when a sync brought changes the phone should pull. */
  readonly onStatus: (status: GitSyncStatus) => void;
  readonly onChanged: () => void;
  /**
   * The epochs Room holds notes of (A886): when any is not this store's, Room's exchanges of
   * those notes wait until the app has brought back what git lacks of them.
   */
  readonly roomEpochs?: readonly string[];
  /**
   * Copies withheld from the push (A886), handed to the app before they leave the notebook: Room
   * keeps them aside, with what is typed on them after, for the person to save, delete or keep
   * and sync. A throw fails the sync with nothing changed.
   */
  readonly withhold?: (copies: readonly CopyToWithhold[]) => Promise<void>;
  readonly now?: () => number;
  readonly syncLimitMs?: number;
  /** Tests shorten how long the network must stay up before a sync chases it. */
  readonly onlineSettleMs?: number;
  /** Tests shorten CLOSING_SYNC_MS. */
  readonly closingSyncMs?: number;
  readonly log?: (message: string) => void;
}

class SyncTimeout extends Error {
  constructor(ms: number) {
    super(`The git host did not answer within ${Math.round(ms / 1000)} s.`);
    this.name = 'SyncTimeout';
  }
}

export class AndroidGitHost {
  private engine: GitNotebookEngine | null = null;
  private server: LocalServer | null = null;
  private current: GitSyncStatus = STARTING;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private firstChangeAt: number | null = null;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private lastPullAt = -Infinity;
  private syncing: Promise<void> | null = null;
  private again = false;
  /** Sync now (or a background run) was asked during the running sync: the next one is too. */
  private againAsked = false;
  private stopped = false;
  private front: boolean;
  private pushDelayS: number;
  private pullEveryMin: number;
  private generation = 0;
  /** A sync landed since this page opened: git's notes and Delete for good marks are known (A886). */
  private fetched = false;
  private readonly now: () => number;
  private closingRun: Promise<void> | null = null;
  /** Whether the close running now is a real leave, which may stop a push at the limit. */
  private closingLeaves = false;
  private onlineTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly offs: Array<() => void> = [];
  /** The repository is on the phone (or the loopback): the network says nothing about it. */
  private readonly local: boolean;

  constructor(private readonly options: HostOptions) {
    this.now = options.now ?? Date.now;
    this.local = options.host === 'this phone' || isLoopbackHost(options.host);
    this.front = options.front;
    this.pushDelayS = options.pushDelayS;
    this.pullEveryMin = options.pullEveryMin;
  }

  get status(): GitSyncStatus {
    return this.current;
  }

  get engineForTests(): GitNotebookEngine | null {
    return this.engine;
  }

  get serverForTests(): LocalServer | null {
    return this.server;
  }

  private set(patch: Partial<GitSyncStatus>): void {
    const pending = this.engine ? pendingOf(this.engine) : this.current.pending;
    this.current = { ...this.current, pending, ...patch };
    this.options.onStatus(this.current);
  }

  /** Opens the engine and its server, and starts syncing. Resolves once the server answers. */
  async start(): Promise<{ epoch: string; fresh: boolean; persisted: boolean | null }> {
    // Ask that the store be kept under low storage (A886); a WebView may not grant it, and the
    // app keeps what it asked and got.
    const persisted = await persistStorage();
    const storage = new EngineStorage(this.options.kv);
    const engine = await GitNotebookEngine.open({
      transport: this.options.transport,
      storage,
      secrets: this.options.secrets,
      writer: { kind: 'device', label: this.options.label },
      ...(this.options.create
        ? { create: { id: this.options.notebookId, name: this.options.name } }
        : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
      ...(this.options.withhold ? { withhold: this.options.withhold } : {}),
    });
    this.engine = engine;
    const ops = new NotebookOps(engine, this.now);
    const notebook = new LocalNotebook(ops, this.now, () => this.syncNow('now'));
    const saved = (await this.options.kv.get(SERVER_STATE_KEY)) as ServerState | undefined;
    // A store without the server's bookkeeping is a new one: a new epoch, so the phone's copies
    // are replaced from git, never merged into nothing (A5).
    const fresh = !(saved && typeof saved.epoch === 'string');
    const state = saved && typeof saved.epoch === 'string' ? saved : emptyState();
    if (!saved) await this.options.kv.write([[SERVER_STATE_KEY, state]]);
    const hooks: ServerHooks = {
      changed: async () => {
        await engine.save();
        // No network: Offline at once (#170 F9, #174 review), not after the next push fails.
        this.set(this.offlineNow() && !this.syncing ? this.offlineStatus() : {});
        this.schedulePush();
      },
      confirmPurge: this.options.confirmPurge,
      confirmRestore: this.options.confirmRestore,
      label: this.options.label,
      now: this.now,
      synced: () => this.fetched,
    };
    this.server = new LocalServer(engine, ops, notebook, hooks, state, (next) =>
      this.options.kv.write([[SERVER_STATE_KEY, next]]),
    );
    // Before anything is answered, so Room's old copies are never replaced first (A886).
    this.server.holdOldCopies(this.options.roomEpochs ?? []);
    this.set({});
    if (typeof window !== 'undefined') {
      // The network went or came back (#170 F9 on Android too, #174 review).
      const target = window;
      const onOffline = () => this.wentOffline();
      const onOnline = () => this.cameOnline();
      target.addEventListener('offline', onOffline);
      target.addEventListener('online', onOnline);
      this.offs.push(() => {
        target.removeEventListener('offline', onOffline);
        target.removeEventListener('online', onOnline);
      });
    }
    this.startPulling();
    void this.syncNow('start');
    return { epoch: state.epoch, fresh, persisted };
  }

  /** One request to the notes server (the app's interceptor). */
  async request(request: LocalRequest): Promise<LocalReply> {
    const server = this.server;
    if (!server) {
      return {
        status: 503,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(
          JSON.stringify({ error: { code: 'starting', message: 'The notebook is opening' } }),
        ),
      };
    }
    return server.handle(request);
  }

  /**
   * A note Room held before this store was made afresh (A886): back as a copy if git lacks any
   * of it. Only once a sync has landed since the page opened: before, git's notes and its Delete
   * for good marks are not known here, so nothing is compared and Room keeps its copy (`later`).
   */
  async recover(input: {
    readonly noteId: string;
    readonly updates: readonly Uint8Array[];
    readonly folderId: string | null;
  }): Promise<RecoverAnswer> {
    const server = this.server;
    if (!server) throw new Error('The notebook is opening');
    if (!this.fetched) return { status: 'later' };
    return server.recover(input);
  }

  /** The app kept an old copy it could not bring back (A886): Room's exchange of it goes ahead. */
  releaseOldCopy(noteId: string): void {
    this.server?.releaseOldCopy(noteId);
  }

  /** No old copy waits any more (A886). */
  endOldCopies(): void {
    this.server?.endOldCopies();
  }

  /** What of an old copy can be read, for the person to save (A886). */
  oldCopyText(noteId: string, updates: readonly Uint8Array[]) {
    const server = this.server;
    if (!server) throw new Error('The notebook is opening');
    return server.oldCopyText(noteId, updates);
  }

  /** Keep and sync of a withheld copy (A886): the app asked the person first. */
  async keepCopy(input: {
    readonly noteId: string;
    readonly origin: string;
    readonly folderId: string | null;
    readonly updates: readonly Uint8Array[];
  }) {
    const server = this.server;
    if (!server) throw new Error('The notebook is opening');
    return server.keepCopy(input);
  }

  /** A withheld copy deleted for good on this phone (A886). */
  async forgetCopy(noteId: string): Promise<void> {
    const server = this.server;
    if (!server) throw new Error('The notebook is opening');
    await server.forgetCopy(noteId);
  }

  /** Keep note, or its Undo (A855): the app checked that the purge has not landed. */
  async keep(noteId: string, keep: boolean): Promise<void> {
    const server = this.server;
    if (!server) throw new Error('The notebook is opening');
    await server.keep(noteId, keep);
  }

  setCadence(pushDelayS: number, pullEveryMin: number): void {
    const pullChanged = pullEveryMin !== this.pullEveryMin;
    this.pushDelayS = pushDelayS;
    this.pullEveryMin = pullEveryMin;
    if (this.stopped || !this.engine) return;
    if (pullChanged) this.startPulling();
    if (this.pushTimer) {
      this.firstChangeAt = null;
      this.schedulePush();
    }
  }

  /** The app came to the front (a pull, at most every 30 s) or left it (the pull timer stops). */
  setFront(front: boolean): void {
    this.front = front;
    if (!this.engine || this.stopped) return;
    this.startPulling();
    if (front && this.now() - this.lastPullAt >= FRONT_PULL_GAP_MS) void this.syncNow('pull');
  }

  private startPulling(): void {
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.pullTimer = null;
    if (!this.front) return;
    const every = Math.max(1, this.pullEveryMin) * 60_000;
    this.pullTimer = setInterval(() => void this.syncNow('pull'), every);
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
   * Syncs now. One at a time; asked during one, another runs after it. Never rejects: a failure
   * is in `status`, with when it tries again. `limitMs` bounds it (a background run's own).
   */
  syncNow(
    reason: 'start' | 'push' | 'pull' | 'now' | 'retry' | 'closing' | 'background' = 'now',
    limitMs?: number,
  ): Promise<void> {
    if (this.stopped && reason !== 'closing') return Promise.resolve();
    // Sync now and a background run always try: the WebView's word on the network may be wrong.
    const asked = reason === 'now' || reason === 'background';
    if (this.syncing) {
      // Asked during one, it runs after it as asked (#174 delta review): never gated by the
      // network, so it never ends on an Offline the WebView guessed.
      this.again = true;
      if (asked) this.againAsked = true;
      return this.syncing.then(() => this.syncing ?? undefined);
    }
    const limit =
      limitMs ??
      (reason === 'closing' ? this.closingMs() : (this.options.syncLimitMs ?? SYNC_LIMIT_MS));
    this.syncing = this.runSync(limit, asked).finally(() => {
      this.syncing = null;
      if (this.again && !this.stopped) {
        const again = this.againAsked;
        this.again = false;
        this.againAsked = false;
        void this.syncNow(again ? 'now' : 'push');
      }
    });
    return this.syncing;
  }

  /** Waits for the sync running now and any asked for during it (a background run's end). */
  async settled(): Promise<void> {
    while (this.syncing) await this.syncing;
  }

  private async runSync(limitMs: number, asked = false): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    if (!asked && this.offlineNow()) {
      // No network: nothing to try; the online event tries again at once.
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
    this.set({ phase: 'syncing', since: this.now() });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sync: Promise<SyncReport> | null = null;
    const stop = new AbortController();
    try {
      sync = engine.sync({ signal: stop.signal });
      const report = await Promise.race([
        sync,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Stopped for good: the engine refuses every git call after this one, and the one
            // running is cancelled in the app before this counts as offline (A859).
            stop.abort();
            void this.options.transport
              .cancel()
              .catch(() => undefined)
              .then(() => reject(new SyncTimeout(limitMs)));
          }, limitMs);
        }),
      ]);
      clearTimeout(timer);
      this.delivered(report);
      this.landed(report);
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof SyncTimeout && sync) {
        // The stopped sync ends on its own; a push that landed after all shows as synced.
        void sync.then(
          (report) => {
            this.delivered(report);
            if (this.generation === generation && !this.syncing) this.landed(report);
          },
          () => this.delivered(engine.takeGitChanges()),
        );
      } else {
        // A fetch applied before a push failed: the phone pulls what it brought.
        this.delivered(engine.takeGitChanges());
      }
      this.failed(error);
    }
  }

  /**
   * What the repository changed reaches the phone at its next pass: each note's clock is its
   * replica rev (saved with the replica), so telling the app is all there is to do.
   */
  private delivered(changes: {
    readonly changed: readonly string[];
    readonly workspaceChanged: boolean;
    readonly purged: readonly string[];
  }): void {
    if (changes.changed.length > 0 || changes.workspaceChanged || changes.purged.length > 0) {
      this.options.onChanged();
    }
  }

  private landed(report: SyncReport): void {
    const engine = this.engine;
    if (!engine) return;
    this.failures = 0;
    this.fetched = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.set({
      phase: 'synced',
      detail: null,
      hostMessage: null,
      code: null,
      since: null,
      lastSyncAt: this.now(),
      nextRetryAt: null,
      handEdits: report.handEdits,
      skipped: report.skipped,
      head: report.head,
    });
    if (pendingOf(engine).length > 0) this.schedulePush();
  }

  private failed(error: unknown): void {
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.failures++);
    const nextRetryAt = this.now() + delay;
    if (!this.stopped) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.syncNow('retry');
      }, delay);
    }
    const described = describe(error, this.options.host);
    if (described.log) this.options.log?.(`git sync failed: ${String(error)}`);
    this.set({ ...described.status, since: null, nextRetryAt });
  }

  /**
   * As the app leaves the screen (A825, #170 F8 as on the Mac): what waits is pushed, after the
   * push already running, all within CLOSING_SYNC_MS. Asked twice at once, both wait for the one
   * close. Out of time, a push with something waiting is stopped only when the app really leaves
   * (`leaving`: Home, Recents, the activity finishing; the app's background run pushes it soon);
   * a plain pause, as the file picker or the share sheet makes, never stops it (#174 delta
   * review). Nothing waiting, nothing is stopped.
   */
  beforeClose(leaving = false): Promise<void> {
    this.closingLeaves ||= leaving;
    this.closingRun ??= this.closeNow().finally(() => {
      this.closingRun = null;
      this.closingLeaves = false;
    });
    return this.closingRun;
  }

  private closingMs(): number {
    return this.options.closingSyncMs ?? CLOSING_SYNC_MS;
  }

  private async closeNow(): Promise<void> {
    const engine = this.engine;
    if (!engine || pendingOf(engine).length === 0) return;
    const finished = await Promise.race([
      (async () => {
        await this.settled();
        if (pendingOf(engine).length > 0) await this.syncNow('closing');
        await this.settled();
      })().then(
        () => true,
        () => true,
      ),
      sleep(this.closingMs()).then(() => false),
    ]);
    if (!finished && this.closingLeaves && pendingOf(engine).length > 0) {
      await this.options.transport.cancel().catch(() => undefined);
    }
  }

  /** Whether the WebView says the phone has no network (never for a repository on it). */
  private offlineNow(): boolean {
    if (this.local) return false;
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  private offlineStatus(): Partial<GitSyncStatus> {
    return {
      phase: 'offline',
      code: 'network',
      detail: 'This phone is offline. Changes stay on this phone and go once it is back online.',
      hostMessage: null,
      since: null,
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
    // Once it has stayed up a moment: a flapping network neither resets the backoff nor
    // starts a sync on every event.
    this.onlineTimer = setTimeout(() => {
      this.onlineTimer = null;
      const engine = this.engine;
      if (this.stopped || !engine || this.offlineNow()) return;
      if (this.current.phase !== 'offline' && pendingOf(engine).length === 0) return;
      this.failures = 0;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      void this.syncNow('retry');
    }, this.options.onlineSettleMs ?? ONLINE_SETTLE_MS);
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.onlineTimer) clearTimeout(this.onlineTimer);
    this.pushTimer = null;
    this.pullTimer = null;
    this.retryTimer = null;
    this.onlineTimer = null;
  }

  /** What is not pushed yet: notes with changes, and the folder tree as one. */
  pending(): readonly string[] {
    return this.engine ? pendingOf(this.engine) : [];
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function pendingOf(engine: GitNotebookEngine): string[] {
  const state = engine.replica.state;
  return [...Object.keys(state.dirty), ...(state.workspaceDirty ? ['workspace'] : [])];
}

/** A failure as the status says it (A824, A859): offline, or stopped, saying why and what to do. */
export function describe(
  error: unknown,
  host: string,
): { status: Partial<GitSyncStatus>; log: boolean } {
  const kept = 'Changes stay on this phone and go once it syncs.';
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
            detail: `Can't sign in to ${host}. Check the personal access token in Settings → Git notebooks. ${kept}`,
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
                'set it as this notebook’s commit email in Settings → Git notebooks',
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
 * `navigator.storage.persist()` (A886): true once the store is kept under low storage, false when
 * refused, null where the page cannot ask (no StorageManager: Node in the tests, an old WebView).
 */
export async function persistStorage(): Promise<boolean | null> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  if (!storage || typeof storage.persist !== 'function') return null;
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return null;
  }
}
