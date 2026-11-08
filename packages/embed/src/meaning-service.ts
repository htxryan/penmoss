/**
 * The Mac app's embedding service (T76, A1152, A1157, A1158): what runs in its utility process.
 * It downloads the model in the background unless Search by Meaning is off, opens it, takes the
 * indexing lease, keeps one `MeaningIndex` per open notebook from the notes the page sends, and
 * answers the page's queries. As the lease holder that sees every open notebook, it is the one
 * process that compacts the shared cache. Off stops it all and removes the model and vectors.
 */
import { MeaningIndex, type MeaningHit, type MeaningNote } from '@penmoss/core/search';
import type { NoteSection } from '@penmoss/core/search';
import { ModelError } from './model-store';
import type { MeaningLease, NodeMeaning, OpenedMeaning } from './node-meaning';

/** What the service needs of `NodeMeaning` (tests give it a fake embedder). */
export type MeaningSource = Pick<
  NodeMeaning,
  'status' | 'fetch' | 'remove' | 'open' | 'setEnabled'
>;

export type ServiceState =
  'off' | 'absent' | 'downloading' | 'opening' | 'indexing' | 'ready' | 'failed';

/** What Settings → Search by Meaning shows (A1158). */
export interface ServiceStatus {
  readonly state: ServiceState;
  readonly enabled: boolean;
  /** The model's id, its bytes on disk and its full size, and its licence (A1151). */
  readonly model: string;
  readonly modelBytes: number;
  readonly totalBytes: number;
  readonly license: { readonly name: string; readonly url: string };
  /** While downloading. */
  readonly received?: number;
  /** Notes with vectors, of the open notebooks' notes. */
  readonly indexed: number;
  readonly total: number;
  /** Another process (`penmoss mcp`) holds the lease: it indexes, this one only searches. */
  readonly leaseElsewhere?: boolean;
  readonly error?: string;
}

/** A note as the page sends it: its sections only when this service does not have them yet. */
export interface ServiceNote {
  readonly id: string;
  readonly version: string | number;
  readonly title?: string;
  readonly sections?: readonly NoteSection[];
}

export interface MeaningServiceOptions {
  /** Download the model at start when it is not here (default true; A1158's "on by default"). */
  readonly download?: boolean;
  /** One indexing slice (ms) and chunks per run, so a query waits little (A1160). */
  readonly sliceMs?: number;
  readonly batch?: number;
  /** How often to try for the lease while another process holds it (ms). */
  readonly leaseRetryMs?: number;
  /** Compact at most this often (ms), once indexing has caught up. */
  readonly compactEveryMs?: number;
  readonly log?: (text: string) => void;
}

interface Notebook {
  /** The notes as last sent, with their sections; kept while the model is not open yet. */
  notes: Map<string, MeaningNote>;
  /** Made once the model opens. */
  index: MeaningIndex | null;
  /** The notes the page has, sections or not. */
  total: number;
}

export class MeaningService {
  private state: ServiceState = 'absent';
  private enabled = true;
  private received: number | undefined;
  private error: string | undefined;
  private opened: OpenedMeaning | null = null;
  private lease: MeaningLease | undefined;
  private readonly notebooks = new Map<string, Notebook>();
  private starting: Promise<void> | null = null;
  private indexing = false;
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  /** The indexing run under way, which Off waits for. */
  private slice: Promise<void> | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  /** The first compaction waits a while too, so every open notebook has been sent. */
  private lastCompaction = Date.now();
  private download: AbortController | null = null;
  private stopped = false;

  constructor(
    private readonly node: MeaningSource,
    private readonly emit: (status: ServiceStatus) => void,
    private readonly options: MeaningServiceOptions = {},
  ) {}

  /** Starts (or restarts after On): download if needed, open, take the lease. */
  start(): Promise<void> {
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async status(): Promise<ServiceStatus> {
    // As things are now: the disk is read after.
    let indexed = 0;
    let total = 0;
    for (const notebook of this.notebooks.values()) {
      indexed += notebook.index?.coverage().indexed ?? 0;
      total += notebook.total;
    }
    const now = {
      state: this.state,
      enabled: this.enabled,
      ...(this.received !== undefined ? { received: this.received } : {}),
      indexed,
      total,
      ...(this.opened && !this.lease ? { leaseElsewhere: true } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
    const disk = await this.node.status();
    return {
      ...now,
      model: disk.model,
      modelBytes: disk.bytes,
      totalBytes: disk.totalBytes,
      license: disk.license,
    };
  }

  /**
   * The page's notes for one notebook, every live note with its version. Answers the ids it
   * needs the sections of (new to it, or changed), which the page sends next.
   */
  async update(notebookId: string, notes: readonly ServiceNote[]): Promise<string[]> {
    if (!this.enabled) return [];
    const notebook = this.notebook(notebookId);
    const next = new Map<string, MeaningNote>();
    const need: string[] = [];
    for (const note of notes) {
      const known = notebook.notes.get(note.id);
      if (note.sections && note.title !== undefined) {
        next.set(note.id, {
          id: note.id,
          version: note.version,
          title: note.title,
          sections: note.sections,
        });
      } else {
        // A changed note keeps its last text, and its vectors, until the new one comes.
        if (known) next.set(note.id, known);
        if (known?.version !== note.version) need.push(note.id);
      }
    }
    notebook.notes = next;
    notebook.total = notes.length;
    this.indexSoon(0);
    await this.emitStatus();
    return need;
  }

  /** Forgets a notebook the page closed. */
  close(notebookId: string): void {
    this.notebooks.delete(notebookId);
  }

  /**
   * Meaning's hits for a query in one notebook (A1155's other list), or null while the model is
   * not open (the page then searches by words alone). `ids`: only these notes (the page's filters).
   */
  async search(
    notebookId: string,
    query: string,
    options: { readonly limit?: number; readonly ids?: readonly string[] } = {},
  ): Promise<MeaningHit[] | null> {
    const notebook = this.notebooks.get(notebookId);
    if (!this.opened || !notebook) return null;
    const index = this.indexOf(notebook);
    const allowed = options.ids ? new Set(options.ids) : null;
    // Take what other processes indexed meanwhile, embedding nothing (A1157).
    await index.update(notebook.notes.values(), { embed: false });
    return index.search(query, {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(allowed ? { filter: (id: string) => allowed.has(id) } : {}),
    });
  }

  /** Search by meaning's floor for the page's fusion (A1155), once the model is open. */
  floor(): number | null {
    return this.opened?.embedder.floor ?? null;
  }

  /** Settings → Search by Meaning (A1158): Off stops everything and removes the model and vectors. */
  async setEnabled(enabled: boolean): Promise<ServiceStatus> {
    await this.node.setEnabled(enabled);
    if (!enabled) {
      this.enabled = false;
      this.download?.abort();
      await this.starting?.catch(() => undefined);
      await this.shut();
      await this.node.remove();
      this.notebooks.clear();
      this.state = 'off';
      this.error = undefined;
    } else {
      this.enabled = true;
      void this.start();
    }
    return this.emitStatus();
  }

  /** Lets go of the model and the lease (the app quitting). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.download?.abort();
    await this.starting?.catch(() => undefined);
    await this.shut();
  }

  private notebook(id: string): Notebook {
    let notebook = this.notebooks.get(id);
    if (!notebook) {
      notebook = { notes: new Map(), index: null, total: 0 };
      this.notebooks.set(id, notebook);
    }
    return notebook;
  }

  /** The notebook's index on the open model. */
  private indexOf(notebook: Notebook): MeaningIndex {
    const opened = this.opened!;
    if (notebook.index?.embedder !== opened.embedder) {
      notebook.index = new MeaningIndex(opened.embedder, opened.cache);
    }
    return notebook.index;
  }

  private async doStart(): Promise<void> {
    const disk = await this.node.status();
    this.enabled = disk.enabled;
    if (!disk.enabled) {
      this.state = 'off';
      await this.emitStatus();
      return;
    }
    try {
      if (disk.state !== 'ready') {
        if (this.options.download === false) {
          this.state = 'absent';
          await this.emitStatus();
          return;
        }
        // Off can cancel the download from here on.
        this.download = new AbortController();
        this.state = 'downloading';
        this.received = disk.bytes;
        await this.emitStatus();
        let shown = 0;
        await this.node.fetch((received, total) => {
          this.received = received;
          // Progress at most every 1%, so the page is not flooded.
          if (received - shown >= total / 100 || received === total) {
            shown = received;
            void this.emitStatus();
          }
        }, this.download.signal);
        this.download = null;
        this.received = undefined;
      }
      if (this.stopped || !this.enabled) return;
      this.state = 'opening';
      await this.emitStatus();
      this.opened = await this.node.open('app');
      if (!this.opened) {
        this.state = 'absent';
        await this.emitStatus();
        return;
      }
      await this.takeLease();
      this.state = 'indexing';
      this.error = undefined;
      await this.emitStatus();
      this.indexSoon(0);
    } catch (error) {
      this.download = null;
      if (!this.enabled || this.stopped) return;
      this.state = 'failed';
      this.error =
        error instanceof ModelError || error instanceof Error ? error.message : String(error);
      this.options.log?.(`[meaning] ${this.error}`);
      await this.emitStatus();
    }
  }

  private async takeLease(): Promise<void> {
    if (!this.opened || this.lease) return;
    this.lease = await this.opened.lease();
    if (this.lease) {
      if (this.leaseTimer) clearInterval(this.leaseTimer);
      this.leaseTimer = null;
      return;
    }
    // Another process indexes for now; try again later.
    this.leaseTimer ??= setInterval(() => {
      void this.takeLease().then(() => {
        if (this.lease) this.indexSoon(0);
      });
    }, this.options.leaseRetryMs ?? 30_000);
    this.leaseTimer.unref?.();
  }

  private indexSoon(ms: number): void {
    if (!this.opened || !this.lease || this.stopped) return;
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => {
      this.slice = this.indexSlice();
    }, ms);
    this.indexTimer.unref?.();
  }

  /** One slice: each notebook's missing chunks for a few seconds, then again until caught up. */
  private async indexSlice(): Promise<void> {
    if (this.indexing || !this.opened || !this.lease) return;
    this.indexing = true;
    try {
      if (!(await this.lease.held())) {
        this.lease = undefined;
        await this.takeLease();
        return;
      }
      let waiting = 0;
      for (const notebook of this.notebooks.values()) {
        if (!this.opened) return;
        const index = this.indexOf(notebook);
        await index.update(notebook.notes.values(), {
          budgetMs: this.options.sliceMs ?? 5_000,
          batch: this.options.batch ?? 2,
        });
        waiting += index.waiting;
      }
      this.state = waiting > 0 ? 'indexing' : 'ready';
      await this.emitStatus();
      if (waiting > 0) {
        this.indexSoon(0);
      } else if (Date.now() - this.lastCompaction >= (this.options.compactEveryMs ?? 60 * 60_000)) {
        const keep = new Set<string>();
        for (const notebook of this.notebooks.values()) {
          for (const key of notebook.index?.index.keys() ?? []) keep.add(key);
        }
        if (keep.size > 0) {
          this.lastCompaction = Date.now();
          const dropped = await this.opened.cache.compact(keep);
          if (dropped > 0)
            this.options.log?.(`[meaning] collected ${dropped} vectors no note uses`);
        }
      }
    } catch (error) {
      this.options.log?.(
        `[meaning] indexing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.indexSoon(30_000);
    } finally {
      this.indexing = false;
    }
  }

  private async shut(): Promise<void> {
    const opened = this.opened;
    this.opened = null;
    this.lease = undefined;
    if (this.indexTimer) clearTimeout(this.indexTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.indexTimer = null;
    this.leaseTimer = null;
    // An indexing run under way finishes its writes first, so Off's removal is the last word.
    await this.slice?.catch(() => undefined);
    this.slice = null;
    for (const notebook of this.notebooks.values()) notebook.index = null;
    await opened?.close();
  }

  private async emitStatus(): Promise<ServiceStatus> {
    const status = await this.status();
    this.emit(status);
    return status;
  }
}
