/**
 * The note list: a source's local records (IndexedDB), with the live changes of open notes.
 */
import type { NoteLink } from '@penmoss/core/links';
import type { NoteMeta } from '@penmoss/sync-client';
import { WORKSPACE_RECORD_KEY } from '@penmoss/sync-client/workspace';

export interface NoteListEntry {
  readonly id: string;
  /** Empty when the note has no title (shown as "Untitled"). */
  readonly title: string;
  readonly excerpt: string;
  readonly updatedAt: number;
  /** The record's `unsynced` flag: edited on this device. */
  readonly unsynced: boolean;
  /** Frontmatter and inline tags (T18), sorted. */
  readonly tags: readonly string[];
}

/** Live changes from an open note, newer than either list. */
export interface LiveNote {
  readonly title: string;
  readonly updatedAt: number;
  /** Read a moment after typing pauses (a document walk); absent until then. */
  readonly tags?: readonly string[];
  /**
   * The note's links, read with its tags: the stored record's are refreshed at most once a
   * text interval, so the open note's Local Graph would miss a link just made (T51, A936).
   */
  readonly links?: readonly NoteLink[];
}

export const displayTitle = (title: string) => title.trim() || 'Untitled';

/** Milliseconds from a number (ms) or an ISO 8601 string; 0 when unknown. */
export function toMillis(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** One entry per note, newest first. Live changes from open notes override the records. */
export function mergeNotes(
  local: Iterable<NoteMeta>,
  live: ReadonlyMap<string, LiveNote> = new Map(),
): NoteListEntry[] {
  const byId = new Map<string, NoteListEntry>();
  /** Deleted: hidden. */
  const deleted = new Set<string>();
  for (const meta of local) {
    // The workspace document shares the store under a reserved key (T7); it is not a note.
    if (meta.noteId === WORKSPACE_RECORD_KEY) continue;
    if (meta.deleted) {
      deleted.add(meta.noteId);
      continue;
    }
    byId.set(meta.noteId, {
      id: meta.noteId,
      title: meta.title,
      excerpt: meta.excerpt,
      updatedAt: meta.updatedAt,
      unsynced: meta.unsynced,
      tags: meta.tags ?? [],
    });
  }
  for (const [id, change] of live) {
    if (deleted.has(id)) continue;
    const entry = byId.get(id);
    byId.set(id, {
      id,
      excerpt: entry?.excerpt ?? '',
      unsynced: entry?.unsynced ?? false,
      title: change.title,
      updatedAt: Math.max(change.updatedAt, entry?.updatedAt ?? 0),
      tags: change.tags ?? entry?.tags ?? [],
    });
  }
  return [...byId.values()].sort(newestFirst);
}

const newestFirst = (a: NoteListEntry, b: NoteListEntry) =>
  b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1);

/**
 * `entries` (a merged list) with one live change applied, as `mergeNotes`
 * would give it, in linear time: open notes change on every keystroke, and
 * a full re-merge sorts the whole list each time. Null when the note is not
 * listed (merge instead).
 */
export function applyLive(
  entries: readonly NoteListEntry[],
  id: string,
  change: LiveNote,
): NoteListEntry[] | null {
  const index = entries.findIndex((entry) => entry.id === id);
  const entry = entries[index];
  if (!entry) return null;
  const updated: NoteListEntry = {
    ...entry,
    title: change.title,
    updatedAt: Math.max(change.updatedAt, entry.updatedAt),
    tags: change.tags ?? entry.tags,
  };
  const rest = entries.filter((_, i) => i !== index);
  let at = rest.findIndex((other) => newestFirst(updated, other) < 0);
  if (at === -1) at = rest.length;
  rest.splice(at, 0, updated);
  return rest;
}
