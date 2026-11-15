/**
 * A note moved to Trash while open in tabs (PEN-140, A1501): every tab whose page is that note
 * closes, wherever the move came from, and the note's Restore (the toast's Undo or Restore)
 * reopens those tabs where they were.
 */
import { mainTabs } from './controller';
import { currentEntry, noteIdOfPath, type ClosedTab } from './state';

/** The tabs each trashed note closed, until it is restored or more notes are trashed. */
const closedFor = new Map<string, readonly ClosedTab[]>();

/**
 * Closes the tabs showing any of `ids`; false in a window with no tabs (a note window), where the
 * caller goes on as before.
 */
export function closeTabsOfTrashed(ids: readonly string[]): boolean {
  const tabs = mainTabs();
  if (!tabs) return false;
  const gone = new Set(ids);
  const closed = tabs.closeShowing((note) => gone.has(note));
  for (const id of ids) {
    const mine = closed.filter((item) => noteIdOfPath(currentEntry(item.tab).path) === id);
    if (mine.length > 0) closedFor.set(id, mine);
  }
  return true;
}

/** The tabs a trash closed for note `id`, or none (for the toast that says so). */
export const tabsClosedFor = (id: string): readonly ClosedTab[] => closedFor.get(id) ?? [];

/** Reopens the tabs a trash closed for `id`; false when there were none (show it in this tab). */
export function reopenTabsOfRestored(id: string): boolean {
  const tabs = mainTabs();
  const closed = closedFor.get(id);
  closedFor.delete(id);
  if (!tabs || !closed || closed.length === 0) return false;
  tabs.restore(closed);
  return true;
}

/** Remembers the tabs a trash from elsewhere closed (the watcher's), for its Restore. */
export function rememberClosedFor(id: string, closed: readonly ClosedTab[]): void {
  if (closed.length > 0) closedFor.set(id, closed);
}

/** A note moved to Trash elsewhere closed its tabs: the toast that says so, with Restore. */
export interface ClosedNotice {
  readonly id: string;
  readonly title: string;
  /** Restores the note (in its notebook), then its tabs. */
  readonly restore: () => Promise<void>;
}

let notice: ClosedNotice | null = null;
const listeners = new Set<() => void>();

/** The toast's store (the watcher sets it, TabClosedToast shows it). */
export const closedNotice = {
  get: (): ClosedNotice | null => notice,
  set: (next: ClosedNotice | null): void => {
    if (next === notice) return;
    notice = next;
    for (const listener of [...listeners]) listener();
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
