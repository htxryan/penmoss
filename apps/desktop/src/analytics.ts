/**
 * Usage analytics in the Mac app's main process (PEN-137): the answer, the stamper, sending, and
 * what Settings → Privacy asks. Events are always recorded on this Mac; the answer in
 * `~/.penmoss/analytics.json` (shared with the CLI and the MCP server) only decides whether they
 * leave it (O3):
 *
 * - no answer yet: `pending`, sent only if the first answer is Yes (the first run included);
 * - No, or DO_NOT_TRACK / PENMOSS_ANALYTICS=off in the app's environment: `local`, never sent;
 * - Yes: `waiting`, then `sent` or `refused`.
 *
 * Main stamps each event from the page and its own (the native menus, the menu bar icon, the
 * capture hotkey, launch and quit): one session per launch, `seq` in arrival order, the client
 * fields and the state, and checks it against the catalogue before the record's worker thread
 * stores it (`analytics-store.ts`); SQLite never runs here. It sends every 60 s, at 25 waiting
 * events and at quit, only with consent: up to 200 waiting events, oldest first, 10 s timeout;
 * offline, a 5xx or a timeout keeps them and backs off up to an hour; a 4xx refuses the batch.
 * Turning sharing off aborts a batch in flight.
 *
 * No Electron here: `services.ts` wires it to the app, and the tests run it as it is.
 */
import { unwatchFile, watchFile, type Stats } from 'node:fs';
import {
  answer as answered,
  changedLimits,
  DEFAULT_LIMITS,
  envOptsOut,
  eventProblem,
  isLimitKey,
  limitAllowed,
  limitsOf,
  majorMinor,
  MAX_BATCH_EVENTS,
  newSessionId,
  readLimits,
  resetId as withNewId,
  SEND_AT_WAITING,
  SEND_EVERY_MS,
  stateFor,
  STATES,
  type AnalyticsEvent,
  type AnalyticsOs,
  type Channel,
  type ClientFields,
  type ConsentAnswer,
  type ConsentFile,
  type EventKind,
  type ForgetResult,
  type LimitKey,
  type Limits,
  type Page,
  type PageQuery,
  type Props,
  type StateName,
  type StoredEvent,
} from '@penmoss/core/analytics';
import {
  Backoff,
  forgetShared,
  readConsentFile,
  sendNext,
  updateConsentFile,
  type SendOutcome,
} from '@penmoss/core/analytics/node';
import type { StoreApi } from './analytics-store';
import { NO_COUNTS } from './analytics-store';

/** Settings → Privacy's view of it (the page's `DesktopAnalyticsStatus`). */
export interface AnalyticsStatus {
  readonly consent: ConsentAnswer | null;
  readonly ask: boolean;
  readonly install: string;
  readonly sharingSince: number | null;
  readonly counts: Readonly<Record<StateName, number>>;
  readonly limits: Limits;
  readonly logBytes: number;
  readonly lastBatch: string | null;
  readonly optedOut: boolean;
}

export interface LimitsPreview {
  readonly events: number;
  readonly logBytes: number;
}

/** The log file, as analytics uses it (`log-file.ts`). */
export interface AnalyticsLogs {
  bytes(): Promise<number>;
  preview(limits: Limits): Promise<number>;
  apply(limits: Limits): Promise<void>;
}

export interface AnalyticsOptions {
  /** `~/.penmoss/analytics.json` (PENMOSS_HOME's). */
  readonly consentPath: string;
  readonly store: StoreApi;
  /** The app's environment: DO_NOT_TRACK or PENMOSS_ANALYTICS=off keep its events local. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The endpoint's base (`analyticsBase`). */
  readonly base: string;
  /** The client fields every event carries (`client: 'mac'`, the version, channel and OS). */
  readonly fields: Omit<ClientFields, 'sizeClass'>;
  /** Whether this install has a notebook: then the one-time question is asked. */
  readonly hasNotebook: () => Promise<boolean>;
  readonly logs: AnalyticsLogs;
  /** Settings → Privacy shows a change (to every window). */
  readonly onChange?: (status: AnalyticsStatus) => void;
  readonly log?: (message: string) => void;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly session?: string;
  /** How long a send may take (ms). */
  readonly timeoutMs?: number;
}

/** An event from the page, before main stamps it (the page's `PageEvent`). */
export interface PageEventInput {
  readonly kind: EventKind;
  readonly name: string;
  readonly props?: Props;
  readonly at: number;
  readonly sizeClass?: AnalyticsEvent['sizeClass'];
}

/** At most this many events in one message from a page. */
export const MAX_PAGE_EVENTS = 200;
/** A page's `at` further off than this from main's clock is replaced by main's. */
const AT_SLACK_MS = 24 * 3_600_000;
/** A batch after a full one follows soon. */
const AGAIN_MS = 2_000;

/** The page's events (they come over IPC), each with its fields checked; the rest dropped. */
export function parsePageEvents(value: unknown): PageEventInput[] {
  if (!Array.isArray(value)) return [];
  const events: PageEventInput[] = [];
  for (const item of value.slice(0, MAX_PAGE_EVENTS) as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const { kind, name, props, at, sizeClass } = item as Record<string, unknown>;
    if (typeof kind !== 'string' || typeof name !== 'string') continue;
    if (props !== undefined && (!props || typeof props !== 'object' || Array.isArray(props))) {
      continue;
    }
    events.push({
      kind: kind as EventKind,
      name,
      ...(props ? { props: props as Props } : {}),
      at: typeof at === 'number' ? at : Number.NaN,
      ...(typeof sizeClass === 'string'
        ? { sizeClass: sizeClass as AnalyticsEvent['sizeClass'] }
        : {}),
    });
  }
  return events;
}

/** A viewer page's query from the page, checked: anything unknown is left out. */
export function parsePageQuery(value: unknown): PageQuery {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const cursor = (item: unknown) => {
    if (!item || typeof item !== 'object') return undefined;
    const { at, id } = item as Record<string, unknown>;
    return typeof at === 'number' && Number.isFinite(at) && typeof id === 'number'
      ? { at, id }
      : undefined;
  };
  const states = ['all', 'pending', 'local', 'waiting', 'sent', 'refused'];
  const clients = ['all', 'app', 'cli', 'mcp'];
  const before = cursor(raw.before);
  const after = cursor(raw.after);
  const limit =
    typeof raw.limit === 'number' && Number.isInteger(raw.limit) && raw.limit > 0
      ? Math.min(raw.limit, 1000)
      : undefined;
  return {
    ...(states.includes(raw.state as string) ? { state: raw.state as PageQuery['state'] } : {}),
    ...(clients.includes(raw.client as string)
      ? { client: raw.client as PageQuery['client'] }
      : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(limit ? { limit } : {}),
  };
}

/** Limit changes from the page: known keys with allowed values only. */
export function parseLimitChanges(value: unknown): Partial<Record<LimitKey, number>> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key, item]) => isLimitKey(key) && limitAllowed(key, item),
    ),
  );
}

/** A version the catalogue's check takes ("0.2.2", "0.2.2-alpha.1185"), else "0.0.0". */
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,20})?$/;

/**
 * The fields every event from the Mac app carries: a development build is `dev`, an Alpha build
 * (its version says so) `alpha`, else `stable`; the OS version as major.minor only.
 */
export function macFields(options: {
  readonly version: string;
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly systemVersion: string;
}): Omit<ClientFields, 'sizeClass'> {
  const version = VERSION.test(options.version) ? options.version : '0.0.0';
  const channel: Channel = !options.packaged
    ? 'dev'
    : /-alpha\b/.test(version)
      ? 'alpha'
      : 'stable';
  const os: AnalyticsOs =
    options.platform === 'darwin'
      ? 'macos'
      : options.platform === 'linux'
        ? 'linux'
        : options.platform === 'win32'
          ? 'windows'
          : 'other';
  return {
    client: 'mac',
    actor: 'person',
    version,
    channel,
    os,
    osVersion: majorMinor(options.systemVersion),
  };
}

/**
 * Watches the consent file for another process's change (the CLI's `penmoss analytics …`), by
 * polling its stat: the file is replaced by a rename, and a folder watch can run out of the
 * system's watchers on a busy Mac. `onChange` once the changes pause.
 */
export function watchConsent(
  path: string,
  onChange: () => void,
  debounceMs = 200,
  intervalMs = 1000,
): { close(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listener = (current: Stats, previous: Stats) => {
    if (
      current.mtimeMs === previous.mtimeMs &&
      current.ino === previous.ino &&
      current.size === previous.size
    ) {
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };
  watchFile(path, { persistent: false, interval: intervalMs }, listener);
  return {
    close: () => {
      if (timer) clearTimeout(timer);
      unwatchFile(path, listener);
    },
  };
}

export class Analytics {
  readonly session: string;
  private file: ConsentFile;
  private readonly optedOut: boolean;
  private readonly now: () => number;
  private readonly backoff = new Backoff();
  private seq = 0;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private sending: Promise<SendOutcome | null> | null = null;
  /** Waiting events recorded since the last send started. */
  private waitingSinceSend = 0;
  private started = false;
  private stopped = false;
  private quitRecorded = false;
  private lastDelay = 0;

  constructor(private readonly options: AnalyticsOptions) {
    this.session = options.session ?? newSessionId();
    this.now = options.now ?? Date.now;
    this.optedOut = envOptsOut(options.env);
    this.file = readConsentFile(options.consentPath);
  }

  /** The answer and limits as main holds them. */
  get consent(): ConsentFile {
    return this.file;
  }

  get limits(): Limits {
    return limitsOf(this.file);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** Starts the send timer and hands the worker the limits; idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.store.setLimits(this.limits);
    void this.options.logs.apply(this.limits).catch(() => undefined);
    this.schedule(SEND_EVERY_MS);
  }

  /** The state an event recorded now takes. */
  private state() {
    return stateFor(this.file.consent, this.optedOut);
  }

  private canSend(): boolean {
    return this.file.consent === 'yes' && !this.optedOut;
  }

  /** Stamps, checks and stores one event; false when it was dropped. */
  private keep(input: {
    kind: EventKind;
    name: string;
    props?: Props | undefined;
    at?: number | undefined;
    sizeClass?: AnalyticsEvent['sizeClass'];
  }): boolean {
    try {
      const now = this.now();
      const at =
        typeof input.at === 'number' &&
        Number.isFinite(input.at) &&
        Math.abs(input.at - now) <= AT_SLACK_MS
          ? Math.round(input.at)
          : now;
      const props = Object.fromEntries(
        Object.entries(input.props ?? {}).filter(([, value]) => value !== undefined),
      ) as Props;
      const event: AnalyticsEvent = {
        session: this.session,
        seq: this.seq,
        at,
        ...this.options.fields,
        ...(input.sizeClass ? { sizeClass: input.sizeClass } : {}),
        kind: input.kind,
        name: input.name,
        props,
      };
      if (eventProblem(event) !== null) return false;
      this.seq += 1;
      const state = this.state();
      this.options.store.insert([{ event, state }]);
      if (state === STATES.waiting) this.counted(1);
      return true;
    } catch {
      return false;
    }
  }

  private counted(waiting: number): void {
    this.waitingSinceSend += waiting;
    if (
      this.started &&
      this.waitingSinceSend >= SEND_AT_WAITING &&
      !this.sending &&
      !this.backoff.failing
    ) {
      this.schedule(0);
    }
  }

  /** Main's own event (the native menus, the menu bar icon, the hotkey, launch and quit). */
  record(kind: EventKind, name: string, props: Props = {}): boolean {
    return this.keep({ kind, name, props });
  }

  /** The page's events: stamped, checked and stored in the order they came; how many kept. */
  recordPage(value: unknown): number {
    const events = parsePageEvents(value);
    if (events.length === 0) return 0;
    const state = this.state();
    const kept: Array<{ event: AnalyticsEvent; state: typeof state }> = [];
    const now = this.now();
    for (const input of events) {
      const at =
        Number.isFinite(input.at) && Math.abs(input.at - now) <= AT_SLACK_MS
          ? Math.round(input.at)
          : now;
      const event: AnalyticsEvent = {
        session: this.session,
        seq: this.seq,
        at,
        ...this.options.fields,
        ...(input.sizeClass ? { sizeClass: input.sizeClass } : {}),
        kind: input.kind,
        name: input.name,
        props: input.props ?? {},
      };
      if (eventProblem(event) !== null) continue;
      this.seq += 1;
      kept.push({ event, state });
    }
    this.options.store.insert(kept);
    if (state === STATES.waiting) this.counted(kept.length);
    return kept.length;
  }

  // --- the answer ---

  private write(change: (file: ConsentFile) => ConsentFile): void {
    try {
      this.file = updateConsentFile(change, this.options.consentPath);
    } catch (error) {
      // A home that cannot be written: the answer holds for this run.
      this.log(`could not save the analytics answer: ${String(error)}`);
      this.file = change(this.file);
    }
  }

  /** Stops a batch in flight: what it carried stays as it is now. */
  private abortSend(): void {
    this.inFlight?.abort();
  }

  /** The one-time question's answer (the first run's last step, or the dialog). */
  async answer(consent: ConsentAnswer): Promise<AnalyticsStatus> {
    const before = this.file.consent;
    this.write((file) => answered(file, consent, this.now(), this.options.fields.version));
    // What was recorded before the answer: sent with Yes (the first run included), kept with No.
    await this.options.store.applyAnswer(consent);
    if (consent === 'no' && before === 'yes') {
      this.abortSend();
      await this.options.store.sharingOff();
    }
    if (consent === 'yes') this.schedule(0);
    return this.changed();
  }

  /**
   * Settings → Privacy's switch. On: what is recorded from now on is sent (only a first answer
   * sends what waited for it). Off: waiting events become Not Shared at once, and a batch in
   * flight stops.
   */
  async setSharing(on: boolean): Promise<AnalyticsStatus> {
    const before = this.file.consent;
    if (on) {
      if (before !== 'yes') {
        this.write((file) => answered(file, 'yes', this.now(), this.options.fields.version));
        if (before === null) await this.options.store.applyAnswer('yes');
        this.schedule(0);
      }
    } else if (before !== 'no') {
      this.abortSend();
      this.write((file) => answered(file, 'no', this.now(), this.options.fields.version));
      if (before === null) await this.options.store.applyAnswer('no');
      await this.options.store.sharingOff();
    }
    return this.changed();
  }

  /** Reset My Analytics ID: a new ID, and what was not sent stays here, Not Shared. */
  async resetId(): Promise<AnalyticsStatus> {
    this.abortSend();
    this.write(withNewId);
    await this.options.store.unsentToLocal();
    return this.changed();
  }

  /**
   * Delete My Shared Data, after its confirmation: the server deletes everything sent under the
   * ID, then this Mac takes a new one. Offline or refused, nothing changes.
   */
  async forget(): Promise<ForgetResult> {
    const install = this.file.install;
    this.abortSend();
    const outcome = await forgetShared(install, {
      base: this.options.base,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    });
    this.log(`analytics forget: ${outcome}`);
    if (outcome === 'ok' && this.file.install === install) {
      this.write(withNewId);
      await this.options.store.unsentToLocal();
      await this.changed();
    }
    return { outcome };
  }

  // --- the record and the limits ---

  page(query: PageQuery): Promise<Page> {
    return this.options.store.page(query);
  }

  private merged(changes: Partial<Record<LimitKey, number>>): Limits {
    return readLimits({ ...this.limits, ...parseLimitChanges(changes) });
  }

  /** What `changes` would delete now; nothing is changed. */
  async preview(changes: Partial<Record<LimitKey, number>> | null): Promise<LimitsPreview> {
    const limits = changes === null ? DEFAULT_LIMITS : this.merged(changes);
    const [events, logBytes] = await Promise.all([
      this.options.store.outside(limits, this.now()),
      this.options.logs.preview(limits).catch(() => 0),
    ]);
    return { events, logBytes };
  }

  /** Saves `changes` (null: Reset to Defaults), then prunes the record and the logs at once. */
  async setLimits(changes: Partial<Record<LimitKey, number>> | null): Promise<AnalyticsStatus> {
    const limits = changes === null ? DEFAULT_LIMITS : this.merged(changes);
    this.write((file) => ({ ...file, limits: changedLimits(limits) }));
    await this.applyLimits(limits);
    return this.changed();
  }

  private async applyLimits(limits: Limits): Promise<void> {
    this.options.store.setLimits(limits);
    await Promise.all([
      this.options.store.prune(limits, this.now()),
      this.options.logs.apply(limits).catch(() => undefined),
    ]);
  }

  /**
   * The file changed (the CLI's `penmoss analytics on|off|reset|limits`, or the app's own write):
   * the record follows it as if the change had been made here.
   */
  async reload(): Promise<void> {
    const before = this.file;
    let next: ConsentFile;
    try {
      next = readConsentFile(this.options.consentPath);
    } catch {
      return;
    }
    this.file = next;
    const limitsChanged =
      JSON.stringify(changedLimits(limitsOf(before))) !==
      JSON.stringify(changedLimits(limitsOf(next)));
    if (
      before.consent === next.consent &&
      before.install === next.install &&
      before.sharingSince === next.sharingSince &&
      !limitsChanged
    ) {
      return;
    }
    if (before.consent === null && next.consent !== null) {
      await this.options.store.applyAnswer(next.consent);
    }
    if (before.consent === 'yes' && next.consent !== 'yes') {
      this.abortSend();
      await this.options.store.sharingOff();
    }
    if (before.install !== next.install) {
      this.abortSend();
      await this.options.store.unsentToLocal();
    }
    if (limitsChanged) await this.applyLimits(limitsOf(next));
    if (next.consent === 'yes' && before.consent !== 'yes') this.schedule(0);
    await this.changed();
  }

  /** Settings → Privacy's view; `ask` says whether to ask the one-time question now. */
  async status(): Promise<AnalyticsStatus> {
    const [counts, lastBatch, logBytes, hasNotebook] = await Promise.all([
      this.options.store.counts().catch(() => ({ ...NO_COUNTS })),
      this.options.store.meta('lastBatch').catch(() => null),
      this.options.logs.bytes().catch(() => 0),
      this.file.consent === null
        ? this.options.hasNotebook().catch(() => false)
        : Promise.resolve(false),
    ]);
    return {
      consent: this.file.consent,
      ask: this.file.consent === null && hasNotebook,
      install: this.file.install,
      sharingSince: this.file.sharingSince,
      counts,
      limits: this.limits,
      logBytes,
      lastBatch,
      optedOut: this.optedOut,
    };
  }

  /** Tells the windows (and answers the caller with) the status now. */
  async changed(): Promise<AnalyticsStatus> {
    const status = await this.status();
    try {
      this.options.onChange?.(status);
    } catch {
      // A window going away.
    }
    return status;
  }

  // --- sending ---

  /** When the next send is due, in ms from when it was set (the tests read it). */
  get nextSendIn(): number | null {
    return this.sendTimer ? this.lastDelay : null;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.lastDelay = delay;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      void this.sendNow();
    }, delay);
    this.sendTimer.unref?.();
  }

  /**
   * Sends the next batch of waiting events, if sharing is on; then sets the next try (a minute,
   * or the back-off). Never throws.
   */
  sendNow(): Promise<SendOutcome | null> {
    if (this.sending) return this.sending;
    if (this.stopped || !this.canSend()) {
      this.schedule(SEND_EVERY_MS);
      return Promise.resolve(null);
    }
    this.waitingSinceSend = 0;
    const controller = new AbortController();
    this.inFlight = controller;
    const run = async (): Promise<SendOutcome | null> => {
      const events = await this.options.store.nextBatch(MAX_BATCH_EVENTS);
      if (controller.signal.aborted || !this.canSend()) return null;
      if (events.length === 0) return { kind: 'empty' };
      const store = this.options.store;
      const prefetched: StoredEvent[] = events;
      const outcome = await sendNext(
        {
          nextBatch: () => prefetched,
          markSent: (ids, at) => store.markSent(ids, at),
          markRefused: (ids) => store.markRefused(ids),
          setMeta: (key, value) => store.setMeta(key, value),
        },
        this.file.install,
        {
          base: this.options.base,
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          now: this.now,
          signal: controller.signal,
          ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
        },
      );
      if (outcome.kind === 'sent') {
        this.log(`analytics sent ${outcome.sent}, refused ${outcome.refused}`);
      } else if (outcome.kind === 'refused') {
        this.log(`analytics refused (${outcome.status}): ${outcome.refused} events`);
      } else if (outcome.kind === 'retry' && !controller.signal.aborted) {
        this.log(`analytics send failed (${outcome.status ?? 'offline'}), trying later`);
      }
      return controller.signal.aborted ? null : outcome;
    };
    const sending = run()
      .catch(() => null)
      .then((outcome) => {
        this.sending = null;
        if (this.inFlight === controller) this.inFlight = null;
        let delay = SEND_EVERY_MS;
        if (outcome) {
          delay = this.backoff.next(outcome);
          if (outcome.kind === 'sent' && outcome.sent + outcome.refused >= MAX_BATCH_EVENTS) {
            delay = AGAIN_MS;
          }
        }
        this.schedule(delay);
        if (outcome && (outcome.kind === 'sent' || outcome.kind === 'refused')) {
          void this.changed();
        }
        return outcome;
      });
    this.sending = sending;
    return sending;
  }

  /** The app is in the background: what waits goes now. */
  background(): void {
    if (this.canSend() && !this.backoff.failing) this.schedule(0);
  }

  /**
   * The app starts to quit (its windows store and close): `quit` is recorded, and what waits is
   * sent, not waited for. What a quit cuts off stays waiting for the next launch; the endpoint
   * keeps an event once, however often it comes.
   */
  quitting(): void {
    if (this.stopped || this.quitRecorded) return;
    this.quitRecorded = true;
    this.record('app', 'quit');
    if (this.canSend() && !this.sending) void this.sendNow();
  }

  /** The app quits: no more sends, and the worker inserts what waits and closes, within `waitMs`. */
  async close(waitMs = 1500): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.options.store.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }
}
