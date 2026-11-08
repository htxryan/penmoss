/**
 * Windows on one device refresh each other offline (T45, A711; extends A228). Every window
 * has its own sockets, so online each one hears the server. Offline, a window that stores a
 * change says which records it wrote, and the others read them from the shared IndexedDB at
 * once instead of waiting for a write of their own:
 *
 * - **Mac app:** the page tells the main process, which tells every other window
 *   (`storeChanged`, as the capture window's save does).
 * - **Web:** a `BroadcastChannel` reaches this browser profile's other windows and tabs.
 *
 * Writes come several a second while typing: they are gathered for a moment, and a window
 * reads at most one batch at a time (`StorePuller`).
 */
import type { PenmossDesktop } from '../desktop/bridge';

export const STORE_CHANNEL = 'penmoss:store';

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

/** What a `BroadcastChannel` needs (injectable for tests). */
export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

/** The ids of a message from another window, or undefined when it is not one. */
export function parseChanged(value: unknown): ChangedRecords | undefined {
  if (value === null) return null;
  const ids = (value as { readonly ids?: unknown } | undefined)?.ids;
  if (ids === null) return null;
  if (!Array.isArray(ids) || ids.length > MAX_ANNOUNCED_IDS) return undefined;
  if (!ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    return undefined;
  }
  return ids as string[];
}

/**
 * The window's StoreSync: the Mac app's bridge when there is one, else a BroadcastChannel,
 * else nothing (a browser without it; each window then hears only the server).
 */
export function storeSync(options: {
  readonly bridge: PenmossDesktop | null;
  readonly channel?: (() => ChannelLike) | null;
}): StoreSync {
  const { bridge } = options;
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let send: ((ids: ChangedRecords) => void) | null = null;
  let subscribe: ((listener: (ids: ChangedRecords) => void) => () => void) | null = null;
  let closeChannel: () => void = () => undefined;

  if (bridge?.stored) {
    const stored = bridge.stored.bind(bridge);
    send = (ids) => stored(ids);
    subscribe = (listener) => bridge.onStoreChanged((ids) => listener(ids ?? null));
  } else if (bridge) {
    // A Mac app from before T45: other windows only hear the capture window's saves.
    subscribe = (listener) => bridge.onStoreChanged(() => listener(null));
  } else if (options.channel) {
    const channel = options.channel();
    send = (ids) => channel.postMessage({ ids });
    subscribe = (listener) => {
      const onMessage = (event: MessageEvent) => {
        const ids = parseChanged(event.data);
        if (ids !== undefined) listener(ids);
      };
      channel.addEventListener('message', onMessage);
      return () => channel.removeEventListener('message', onMessage);
    };
    closeChannel = () => channel.close();
  }

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
      return subscribe?.(listener) ?? (() => undefined);
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      closeChannel();
    },
  };
}

/** The browser's BroadcastChannel for the store, where there is one. */
export function browserChannel(): (() => ChannelLike) | null {
  return typeof BroadcastChannel === 'undefined' ? null : () => new BroadcastChannel(STORE_CHANNEL);
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
