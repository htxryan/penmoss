/**
 * The notes embeds show (T13), followed live: each note is opened as the editor opens one, shared
 * by every embed showing it, and closed a moment after the last one goes. The notes service
 * (service.ts) keeps one; `Notes.watchNote` is its way in.
 */
import type { OpenNote } from './open-note';

/** A note open for the embeds showing it (T13). */
export interface EmbeddedNote {
  readonly note: OpenNote;
  readonly listeners: Set<() => void>;
  off: (() => void) | null;
  closing: ReturnType<typeof setTimeout> | null;
}

/** How long a note stays open after its last embed goes (T13). */
const EMBED_CLOSE_DELAY_MS = 2000;
/**
 * Notes open at once for embeds. Embeds follow notes only while on screen; past this many, the
 * rest wait for a turn and show this device's stored copy meanwhile.
 */
export const MAX_LIVE_EMBEDS = 8;

/** One embed's watch on a note: live once it has `off`, waiting for a turn before. */
interface EmbedWatch {
  readonly listener: () => void;
  off: (() => void) | null;
}

export class EmbedWatcher {
  /** Watches waiting for a turn (`MAX_LIVE_EMBEDS`), by note id, oldest first. */
  private readonly embedWaiting = new Map<string, Set<EmbedWatch>>();

  /**
   * `openNote` opens a note as the editor does (`Notes.openNote`); `embedded` holds the notes
   * shown in embeds, opened live while any embed shows them (the notes service keeps it).
   */
  constructor(
    private readonly openNote: (id: string) => OpenNote,
    private readonly embedded: Map<string, EmbeddedNote>,
  ) {}

  /**
   * Follows a note's changes for embeds (T13): the note is opened as the editor opens one, shared
   * by every embed showing it, and closed a moment after the last one goes (an editor
   * re-rendering its embeds keeps it open). At most `MAX_LIVE_EMBEDS` notes are open: a watch
   * past that waits for a turn. `listener` runs on every change and once the note is loaded.
   * Nothing here writes to the note.
   */
  watchNote(id: string, listener: () => void): () => void {
    const watch: EmbedWatch = { listener, off: null };
    this.startWatch(id, watch);
    return () => {
      if (watch.off) {
        watch.off();
        watch.off = null;
        return;
      }
      const waiting = this.embedWaiting.get(id);
      waiting?.delete(watch);
      if (waiting?.size === 0) this.embedWaiting.delete(id);
    };
  }

  /** Follows `id` for `watch`: opens it if a turn is free, else queues the watch. */
  private startWatch(id: string, watch: EmbedWatch): void {
    let entry = this.embedded.get(id);
    if (!entry) {
      if (this.embedded.size >= MAX_LIVE_EMBEDS) {
        const waiting = this.embedWaiting.get(id) ?? new Set<EmbedWatch>();
        this.embedWaiting.set(id, waiting);
        waiting.add(watch);
        return;
      }
      entry = this.openEmbedded(id);
    }
    const current = entry;
    if (current.closing !== null) clearTimeout(current.closing);
    current.closing = null;
    current.listeners.add(watch.listener);
    watch.off = () => {
      current.listeners.delete(watch.listener);
      if (current.listeners.size > 0 || current.closing !== null) return;
      current.closing = setTimeout(() => {
        current.closing = null;
        if (current.listeners.size > 0 || this.embedded.get(id) !== current) return;
        this.embedded.delete(id);
        current.off?.();
        current.note.close();
        this.nextEmbedTurn();
      }, EMBED_CLOSE_DELAY_MS);
    };
  }

  private openEmbedded(id: string): EmbeddedNote {
    const note = this.openNote(id);
    const created: EmbeddedNote = {
      note,
      listeners: new Set(),
      off: null,
      closing: null,
    };
    void note.ready.then(() => {
      if (this.embedded.get(id) !== created) return;
      created.off = note.replica.onUpdate(() => {
        for (const each of created.listeners) each();
      });
      // Loaded: the body may differ from what the embed first read.
      for (const each of created.listeners) each();
    });
    this.embedded.set(id, created);
    return created;
  }

  /** Opens notes waiting for a turn, oldest first, while turns are free. */
  private nextEmbedTurn(): void {
    for (const [id, waiting] of this.embedWaiting) {
      if (this.embedded.size >= MAX_LIVE_EMBEDS) return;
      this.embedWaiting.delete(id);
      for (const watch of waiting) this.startWatch(id, watch);
    }
  }
}
