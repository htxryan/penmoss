/**
 * Windows of the Mac app refresh each other at once, offline too (T45, A711; extends A228). A
 * window that stores a change says which records it wrote; the main process tells every other
 * window (`storeChanged`, as the capture window's save does), and they read those records from
 * the shared IndexedDB instead of waiting for a write of their own.
 *
 * Writes come several a second while typing: they are gathered for a moment, and a window
 * reads at most one batch at a time (`StorePuller`).
 */
import type { PenmossDesktop } from '../desktop/bridge';

/** How long announcements gather before they go: one message for a burst of writes. */
export const ANNOUNCE_DELAY_MS = 30;

/** At most this many record ids in one message; more say "everything" instead. */
export const MAX_ANNOUNCED_IDS = 100;

/** The records another window wrote, or null for "read everything" (too many, or not said). */
export type ChangedRecords = readonly string[] | null;

export interface StoreSync {
  /** This window stored these records. */
  announce(ids: readonly string[]): void;
  /** Sends what is gathered now: the window is closing or the page is going. */
  flush(): void;
  /** Another window stored records; returns the unsubscribe. */
  onChanged(listener: (ids: ChangedRecords) => void): () => void;
  close(): void;
}

/** The window's StoreSync, through the Mac app's main process (none without the bridge). */
export function storeSync(bridge: PenmossDesktop | null): StoreSync {
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = bridge ? bridge.stored.bind(bridge) : null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const ids = [...pending];
    pending = new Set();
    if (ids.length > 0) send?.(ids.length > MAX_ANNOUNCED_IDS ? null : ids);
  };

  return {
    announce(ids) {
      if (!send) return;
      for (const id of ids) pending.add(id);
      timer ??= setTimeout(flush, ANNOUNCE_DELAY_MS);
    },
    flush,
    onChanged(listener) {
      // A save that names nothing (the capture window's, T30): read everything.
      return bridge ? bridge.onStoreChanged((ids) => listener(ids ?? null)) : () => undefined;
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Reads what other windows stored, one batch at a time: changes that arrive while a read
 * runs are gathered and read once it ends (null, "everything", wins over a list).
 */
export class StorePuller {
  private running: Promise<void> | null = null;
  private queued: Set<string> | 'all' | null = null;

  constructor(private readonly read: (ids: ChangedRecords) => Promise<void>) {}

  changed(ids: ChangedRecords): void {
    if (ids === null || this.queued === 'all') this.queued = 'all';
    else {
      this.queued ??= new Set();
      for (const id of ids) this.queued.add(id);
    }
    this.running ??= this.drain();
  }

  /** Resolves once nothing is left to read (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queued !== null) {
        const next = this.queued;
        this.queued = null;
        try {
          await this.read(next === 'all' ? null : [...next]);
        } catch (error) {
          console.warn('[windows] could not read what another window stored', error);
        }
      }
    } finally {
      this.running = null;
    }
  }
}
