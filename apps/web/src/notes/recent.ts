/**
 * Recently used notes for the ⌘E switcher (T20): when this device last
 * opened each note (kept in localStorage, per device), combined with when the
 * note was last edited anywhere (the note list's synced `updatedAt`). A note
 * is as recent as the later of the two, so a note just edited on the phone
 * comes up on the laptop too.
 */
import type { NoteListEntry } from './list';

export const RECENT_STORAGE_KEY = 'penmoss.recent';
/** How many opened notes this device remembers. */
const MAX_REMEMBERED = 50;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Note id → when this device last opened it (ms). */
export type OpenedAt = ReadonlyMap<string, number>;

export function readOpened(storage: KeyValueStorage | null): Map<string, number> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENT_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return new Map();
    const out = new Map<string, number>();
    for (const entry of parsed as unknown[]) {
      if (!Array.isArray(entry)) continue;
      const [id, at] = entry as unknown[];
      if (typeof id === 'string' && typeof at === 'number') out.set(id, at);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Records that this device opened `id` at `at`, keeping the newest MAX_REMEMBERED. */
export function rememberOpened(storage: KeyValueStorage | null, id: string, at: number): void {
  if (!storage) return;
  const opened = readOpened(storage);
  opened.set(id, at);
  const newest = [...opened].sort((a, b) => b[1] - a[1]).slice(0, MAX_REMEMBERED);
  try {
    storage.setItem(RECENT_STORAGE_KEY, JSON.stringify(newest));
  } catch {
    // Storage full or blocked: the switcher falls back to edit recency.
  }
}

/**
 * Notes most recently used first: the later of "opened here" and "edited
 * anywhere". The open note, if any, comes first (the switcher starts on the
 * one after it, like an app switcher).
 */
export function recentNotes(
  list: readonly NoteListEntry[],
  opened: OpenedAt,
  current: string | null,
  limit = 9,
): NoteListEntry[] {
  const recency = (entry: NoteListEntry) => Math.max(opened.get(entry.id) ?? 0, entry.updatedAt);
  const sorted = [...list].sort(
    (a, b) =>
      Number(b.id === current) - Number(a.id === current) ||
      recency(b) - recency(a) ||
      (a.id < b.id ? 1 : -1),
  );
  return sorted.slice(0, limit);
}

/**
 * The note this device opened last that is still in the list (not trashed or
 * gone), or null: where the Mac app goes back to on launch and from Settings.
 */
export function lastOpenedNote(list: readonly NoteListEntry[], opened: OpenedAt): string | null {
  const listed = new Set(list.map((entry) => entry.id));
  let last: string | null = null;
  let lastAt = -Infinity;
  for (const [id, at] of opened) {
    if (listed.has(id) && at > lastAt) [last, lastAt] = [id, at];
  }
  return last;
}

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
