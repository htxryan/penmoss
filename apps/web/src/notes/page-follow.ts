/**
 * What the page and the engine tell the notes service (service.ts, A626, PR #167): the page
 * hiding or going, the browser going on or offline, the engine's sync, and another window's
 * last keystrokes kept as it went. `Notes.start` follows them; the function returned stops.
 */
import type { LocalNotes, LocalSyncBackend } from './service-types';

/** What following the page needs from the notes service. */
export interface PageFollower {
  readonly saveAllOnUnload: () => void;
  readonly saveAll: () => Promise<void>;
  readonly syncChanged: () => void;
  readonly backend: LocalSyncBackend;
  readonly localStore: () => Promise<LocalNotes>;
  readonly pullStored: (ids: readonly string[]) => Promise<void>;
}

/** Follows the page and the engine for the notes service; returns what stops it. */
export function followPage(host: PageFollower): () => void {
  // On page hide every change not stored yet is kept in that event, synchronously: a write
  // that waits for a callback is lost with the page (A626).
  const onPageHide = () => host.saveAllOnUnload();
  const onOnlineChange = () => host.syncChanged();
  // Hidden (the app in the background, maybe ended there): stored as on page hide, in case
  // this is the last event, and written to the records too, which other windows read.
  const onVisible = () => {
    if (document.visibilityState === 'hidden') {
      host.saveAllOnUnload();
      void host.saveAll();
    }
  };
  const browser = typeof window === 'undefined' ? null : window;
  browser?.addEventListener('pagehide', onPageHide);
  browser?.addEventListener('online', onOnlineChange);
  browser?.addEventListener('offline', onOnlineChange);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  const offBackend = host.backend.subscribe(() => host.syncChanged());
  // Another window's last keystrokes, kept as it went without storing them (closed at once,
  // or its renderer gone): merged here at once, so this window shows them and the engine's
  // window takes them in and pushes them (PR #167).
  let offKept: (() => void) | null = null;
  let keptStopped = false;
  host.localStore().then(
    (store) => {
      if (keptStopped) return;
      offKept =
        store.watchUnloadWrites?.((ids) => {
          void host.pullStored(ids).catch(() => undefined);
        }) ?? null;
    },
    () => undefined,
  );
  return () => {
    browser?.removeEventListener('pagehide', onPageHide);
    browser?.removeEventListener('online', onOnlineChange);
    browser?.removeEventListener('offline', onOnlineChange);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible);
    }
    offBackend();
    keptStopped = true;
    offKept?.();
  };
}

/** Whether the browser thinks it is online (`navigator.onLine`). */
export const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Asks the browser not to evict local storage (`navigator.storage.persist`). */
export function browserPersist(): Promise<boolean> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  return storage?.persist ? storage.persist() : Promise.resolve(false);
}
