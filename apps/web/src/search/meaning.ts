/**
 * Search by meaning in the Mac app (T77, A1155, A1156): one git notebook's side of the embedding
 * service (T76), which holds the model and the vectors. The main window keeps the service fed:
 * each note's version, then the sections of the notes it asks for, a moment after notes change
 * and again whenever the service starts afresh (a new `generation`). Every window asks it by
 * meaning. The page never embeds anything itself.
 */
import { noteSections, type NoteSection } from '@penmoss/core/search';
import type { NoteRecord } from '@penmoss/sync-client';
import { bodyJson, createYjs14Replica } from '@penmoss/sync-client/yjs14';
import type { DesktopMeaning, DesktopMeaningHit, DesktopMeaningStatus } from '../desktop/bridge';

/** Notes changed: the service hears of it this long after they settle. */
export const MEANING_SYNC_DELAY_MS = 1_000;
/** Sections built between turns given back to the page. */
const SECTIONS_SLICE = 20;

/** Why hybrid matched words only (shown quietly as Words only), and why semantic found nothing. */
export interface MeaningUnavailable {
  readonly wordsOnly: string;
  readonly semantic: string;
}

const AND_WORDS = 'Full-text and Hybrid search match your words.';
/** Where search by meaning cannot run at all (A1156): the web app, Android. */
export const MEANING_ELSEWHERE: MeaningUnavailable = {
  wordsOnly: 'Search by meaning is in the Mac app. Here, results match your words.',
  semantic: `Search by meaning is in the Mac app. ${AND_WORDS}`,
};
/** On a Mac whose model is not ready, or is off. */
export const MEANING_NOT_READY: MeaningUnavailable = {
  wordsOnly:
    'Search by meaning is not ready on this Mac (Settings → Search by Meaning). Results match your words.',
  semantic: `Search by meaning is not ready on this Mac (Settings → Search by Meaning). ${AND_WORDS}`,
};
export const MEANING_DOWNLOADING: MeaningUnavailable = {
  wordsOnly: 'Search by meaning is downloading its model. Until then, results match your words.',
  semantic: `Search by meaning is downloading its model. ${AND_WORDS}`,
};

/** While some notes have no vectors yet (A1156). */
export function coverageNotice(indexed: number, total: number): string {
  return `Meaning covers ${indexed} of ${total} notes so far.`;
}

/** A note's title and heading sections, from its record's Yjs document (A1154). */
export function sectionsOfRecord(record: NoteRecord): NoteSection[] {
  const replica = createYjs14Replica();
  try {
    replica.applyUpdate(record.update);
    return noteSections(bodyJson(replica.doc));
  } finally {
    replica.destroy();
  }
}

/** What the notebook's search gives the service: its live notes, and one note's text. */
export interface MeaningNotes {
  /** Every live note's id and version (its record's update time). */
  versions(): Promise<ReadonlyMap<string, number>>;
  note(
    id: string,
  ): Promise<{ readonly title: string; readonly sections: readonly NoteSection[] } | null>;
}

export interface NotebookMeaningOptions {
  /** This window feeds the service (the main window); others only search. */
  readonly feed?: boolean;
  readonly delayMs?: number;
  readonly yieldToPage?: () => Promise<void>;
}

const answering = (status: DesktopMeaningStatus | null) =>
  status !== null && status.enabled && (status.state === 'ready' || status.state === 'indexing');

export class NotebookMeaning {
  private status: DesktopMeaningStatus | null = null;
  private notes: MeaningNotes | null = null;
  /** The service's generation the notes were last sent to. */
  private sent = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncing: Promise<void> | null = null;
  private again = false;
  /** The notebook was removed: nothing more is sent (A-NEW-1). */
  private closed = false;
  private readonly off: () => void;

  constructor(
    readonly notebookId: string,
    private readonly bridge: DesktopMeaning,
    private readonly options: NotebookMeaningOptions = {},
  ) {
    this.off = bridge.onChange((status) => this.heard(status));
    void bridge
      .status()
      .then((status) => {
        if (status && this.status === null) this.heard(status);
      })
      .catch(() => undefined);
  }

  /** The notebook's notes (its search service), once: the first sync follows. */
  attach(notes: MeaningNotes): void {
    this.notes = notes;
    this.schedule();
  }

  /**
   * Stops listening and sending. `forget`: the notebook was removed from the app (A-NEW-1), so the
   * window that feeds the service has it forget the notebook, which leaves "covers N of M" and the
   * keys compaction keeps; without it (the view only went), the service keeps what it was sent.
   */
  close(forget = true): void {
    if (this.closed) return;
    this.closed = true;
    this.off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.notes = null;
    if (!forget || this.options.feed === false) return;
    this.bridge.close(this.notebookId).catch((error: unknown) => {
      console.warn('[search] could not close search by meaning for a notebook', error);
    });
  }

  /** Meaning can answer now (the model is open, indexing or done). */
  ready(): boolean {
    return answering(this.status);
  }

  /** Why results match words only, while it cannot. */
  unavailable(): MeaningUnavailable {
    return this.status?.state === 'downloading' ? MEANING_DOWNLOADING : MEANING_NOT_READY;
  }

  /** "Meaning covers N of M notes so far", while the service has notes without vectors. */
  coverage(): string | null {
    const status = this.status;
    if (!status || status.total === 0 || status.indexed >= status.total) return null;
    return coverageNotice(status.indexed, status.total);
  }

  /** Notes changed: tell the service a moment after they settle. */
  schedule(delayMs = this.options.delayMs ?? MEANING_SYNC_DELAY_MS): void {
    if (this.options.feed === false || !this.notes || this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, delayMs);
  }

  /** Meaning's hits and floor, or null: then the notebook searches by words alone. */
  async search(
    query: string,
    options: { readonly limit?: number; readonly ids?: readonly string[] },
  ): Promise<{ readonly floor: number; readonly hits: readonly DesktopMeaningHit[] } | null> {
    if (!this.ready()) return null;
    return this.bridge.search(this.notebookId, query, options).catch(() => null);
  }

  /** Sends every note's version, then the sections of those the service asks for. */
  sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = this.doSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const notes = this.notes;
    if (!notes) return;
    do {
      this.again = false;
      const status = this.status;
      if (!status?.enabled || status.state === 'stopped' || status.state === 'restarting') return;
      try {
        const versions = await notes.versions();
        // Removed meanwhile: an update now would bring the notebook back into the service.
        if (this.closed) return;
        const list = [...versions].map(([id, version]) => ({ id, version }));
        const need = new Set(await this.bridge.update(this.notebookId, list));
        if (need.size > 0) {
          const full = [];
          let built = 0;
          for (const item of list) {
            const note = need.has(item.id) ? await notes.note(item.id) : null;
            full.push(note ? { ...item, title: note.title, sections: note.sections } : item);
            if (note && ++built % SECTIONS_SLICE === 0) await this.options.yieldToPage?.();
          }
          if (this.closed) return;
          await this.bridge.update(this.notebookId, full);
        }
        this.sent = status.generation;
      } catch (error) {
        console.warn('[search] could not send notes to search by meaning', error);
        return;
      }
    } while (this.again);
  }

  private heard(status: DesktopMeaningStatus): void {
    const before = this.status;
    this.status = status;
    // A new start of the service, or switched on again: it has none of this notebook's notes.
    const fresh = status.generation !== this.sent || (status.enabled && before?.enabled === false);
    if (fresh && status.enabled && status.state !== 'restarting') this.schedule(0);
  }
}
