/**
 * Search by meaning's service on the Mac (T76, A1152, A1157, A1158): main forks it as a
 * utilityProcess (`dist/embed-utility.cjs`), which holds the model, the indexing lease and one
 * index per open notebook, off every UI thread. The page reaches it through main's named calls
 * (`penmossDesktop.meaning`), which main relays over the process's port. A crash is restarted,
 * a little later each time; meanwhile the page searches by words alone. Each start has a new
 * `generation`, so the page knows to send its notes again.
 */
import {
  serviceClient,
  type ServiceClient,
  type ServiceNote,
  type ServiceStatus,
} from '@penmoss/embed';
import type { MeaningHit } from '@penmoss/core/search';

/** What main uses of Electron's `UtilityProcess`. */
export interface ServiceProcess {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
  readonly pid?: number | undefined;
}

/** What the page sees: the service's status, and which start of it this is. */
export type DesktopMeaningStatus =
  | (ServiceStatus & { readonly generation: number })
  | {
      readonly state: 'starting' | 'restarting' | 'stopped' | 'off';
      readonly generation: number;
      readonly enabled: boolean;
      readonly indexed: 0;
      readonly total: 0;
      readonly error?: string;
    };

export interface EmbeddingServiceOptions {
  /** Forks the service (Electron's `utilityProcess.fork`). */
  readonly fork: () => ServiceProcess;
  readonly onStatus: (status: DesktopMeaningStatus) => void;
  readonly log: (text: string) => void;
  /** Waits before each restart after a crash (the last one repeats). */
  readonly restartDelaysMs?: readonly number[];
  /** Writes the per-Mac setting (`~/.penmoss/meaning.json`) while no service is running. */
  readonly writeSetting?: (enabled: boolean) => Promise<void>;
}

const RESTART_DELAYS_MS = [1_000, 5_000, 30_000, 120_000];

export class EmbeddingService {
  private child: ServiceProcess | null = null;
  private client: ServiceClient | null = null;
  private generation = 0;
  private crashes = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** The switch, clicked while no service ran: the next one is told as it starts. */
  private pending: boolean | null = null;
  private last: DesktopMeaningStatus = {
    state: 'starting',
    generation: 0,
    enabled: true,
    indexed: 0,
    total: 0,
  };

  constructor(private readonly options: EmbeddingServiceOptions) {}

  start(): void {
    if (this.child || this.stopped) return;
    const generation = ++this.generation;
    const child = this.options.fork();
    this.child = child;
    const client = serviceClient(child, (status) => {
      if (this.child !== child) return;
      // Ready again after a crash: the next crash waits the shortest time.
      if (status.state === 'ready') this.crashes = 0;
      this.publish({ ...status, generation });
    });
    this.client = client;
    if (this.pending !== null) {
      const enabled = this.pending;
      this.pending = null;
      void client
        .setEnabled(enabled)
        .then((status) => this.child === child && this.publish({ ...status, generation }))
        .catch(this.failed(undefined));
    }
    child.on('exit', (code) => {
      client.failAll('The embedding service stopped.');
      if (this.child !== child) return;
      this.child = null;
      this.client = null;
      if (this.stopped) return;
      const delays = this.options.restartDelaysMs ?? RESTART_DELAYS_MS;
      const wait = delays[Math.min(this.crashes, delays.length - 1)] ?? 1_000;
      this.crashes++;
      this.options.log(
        `[meaning] the embedding service exited (${code}); starting it again in ${wait} ms`,
      );
      this.publish({
        state: 'restarting',
        generation,
        enabled: this.last.enabled,
        indexed: 0,
        total: 0,
        error: `The embedding service stopped (exit code ${code}).`,
      });
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, wait);
      this.restartTimer.unref?.();
    });
  }

  /** The app quitting: the service lets go of the model and the lease as it is killed. */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
    this.child = null;
    this.client?.failAll('The app is quitting.');
    this.client = null;
    this.publish({ ...this.last, state: 'stopped', indexed: 0, total: 0 });
  }

  status(): DesktopMeaningStatus {
    return this.last;
  }

  /** The page's notes for one notebook; answers the ids whose sections it should send. */
  async update(notebookId: string, notes: readonly ServiceNote[]): Promise<string[]> {
    return (await this.client?.update(notebookId, notes).catch(this.failed([]))) ?? [];
  }

  async close(notebookId: string): Promise<void> {
    await this.client?.close(notebookId).catch(this.failed(undefined));
  }

  /** Meaning's hits and floor, or null while the service cannot answer (words alone). */
  async search(
    notebookId: string,
    query: string,
    options: { readonly limit?: number; readonly ids?: readonly string[] },
  ): Promise<{ readonly floor: number; readonly hits: MeaningHit[] } | null> {
    return (await this.client?.search(notebookId, query, options).catch(this.failed(null))) ?? null;
  }

  /** Settings → Search by Meaning (A1158). */
  async setEnabled(enabled: boolean): Promise<DesktopMeaningStatus> {
    const client = this.client;
    if (!client) {
      // Not running (just launched, or waiting to restart after a crash): the setting is written
      // now, and the service applies it (Off removes the model and the vectors) once it starts,
      // which a restart does at once. Off also keeps a crashing model from being opened again.
      await this.options.writeSetting?.(enabled);
      this.pending = enabled;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        this.start();
      }
      return this.publish(
        enabled
          ? { ...this.last, enabled }
          : { state: 'off', generation: this.last.generation, enabled, indexed: 0, total: 0 },
      );
    }
    const status = await client.setEnabled(enabled);
    return this.publish({ ...status, generation: this.generation });
  }

  /** For the Electron suite: the service's process id, to kill it. */
  pid(): number | null {
    return this.child?.pid ?? null;
  }

  private failed<T>(value: T): (error: unknown) => T {
    return (error) => {
      this.options.log(`[meaning] ${error instanceof Error ? error.message : String(error)}`);
      return value;
    };
  }

  private publish(status: DesktopMeaningStatus): DesktopMeaningStatus {
    this.last = status;
    this.options.onStatus(status);
    return status;
  }
}

/** At most this many notes in one call, and this much text in one note (the page is trusted, but its input is still checked). */
const MAX_NOTES = 50_000;
const MAX_NOTE_CHARS = 2_000_000;

const isString = (value: unknown): value is string => typeof value === 'string';

/** The page's notes, or null when they are not notes (main refuses the call). */
export function parseServiceNotes(value: unknown): ServiceNote[] | null {
  if (!Array.isArray(value) || value.length > MAX_NOTES) return null;
  const notes: ServiceNote[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const { id, version, title, sections } = item as Record<string, unknown>;
    if (!isString(id) || !(isString(version) || typeof version === 'number')) return null;
    if (sections === undefined) {
      notes.push({ id, version });
      continue;
    }
    if (!isString(title) || !Array.isArray(sections)) return null;
    let chars = title.length;
    const parsed = [];
    for (const section of sections as unknown[]) {
      if (typeof section !== 'object' || section === null) return null;
      const { heading, path, text } = section as Record<string, unknown>;
      if (!(heading === null || isString(heading)) || !isString(text)) return null;
      if (!Array.isArray(path) || !(path as unknown[]).every(isString)) return null;
      chars += text.length;
      if (chars > MAX_NOTE_CHARS) return null;
      parsed.push({ heading, path: path as string[], text });
    }
    notes.push({ id, version, title, sections: parsed });
  }
  return notes;
}

/** The page's search options: a limit and the ids its filters allow. */
export function parseSearchOptions(
  value: unknown,
): { readonly limit?: number; readonly ids?: readonly string[] } | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object') return null;
  const { limit, ids } = value as Record<string, unknown>;
  if (
    limit !== undefined &&
    !(Number.isInteger(limit) && (limit as number) > 0 && (limit as number) <= 200)
  )
    return null;
  if (ids !== undefined && !(Array.isArray(ids) && ids.length <= MAX_NOTES && ids.every(isString)))
    return null;
  return {
    ...(limit !== undefined ? { limit: limit as number } : {}),
    ...(ids !== undefined ? { ids: ids } : {}),
  };
}
