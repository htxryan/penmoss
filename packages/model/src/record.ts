/** What a client keeps per note (A7). DOM-free so non-browser code can share it. */
import type { NoteLink } from '@penmoss/core/links';

/**
 * The Yjs stack a note is written with (D31: Yjs 14). It is fixed per note and stored with its
 * record, so a future engine change can tell old notes apart.
 */
export type EngineName = 'yjs14';

export interface NoteRecord {
  readonly noteId: string;
  readonly engine: EngineName;
  /** The whole document as one merged update (`encodeStateAsUpdate`). */
  readonly update: Uint8Array;
  readonly stateVector: Uint8Array;
  readonly text: string;
  /**
   * The note's title (A16 `title` text), so the note list is right offline.
   * Absent in records written before T6, whose list title is the first line of `text`.
   */
  readonly title?: string;
  /**
   * The note's tags, frontmatter and inline (T18), so the tag pane and filter work
   * offline. Absent in records written before T18 (the v5 upgrade fills it in).
   */
  readonly tags?: readonly string[];
  /**
   * The note's headings, one per line, for the offline search index (T22). Absent in
   * records written before T22 (the v6 upgrade fills it in).
   */
  readonly headings?: string;
  readonly updatedAt: number;
  /**
   * Edited on this device since the git notebook's engine last took the note in: the note list
   * shows it as not yet synced.
   */
  readonly unsynced: boolean;
  /** The note is soft-deleted (A16 `meta.deleted`); absent means false. */
  readonly deleted?: boolean;
  /** Its wikilinks and embeds (T16); absent when it has none, or they were never computed. */
  readonly links?: readonly NoteLink[];
  /** `LINKS_VERSION` when `links` was computed; absent in records written before T16. */
  readonly linksVersion?: number;
  /** When it was deleted (epoch ms) and from which folder (null: top level), if recorded (T21). */
  readonly deletedAt?: number;
  readonly deletedFrom?: string | null;
  /**
   * Changes on every write. A writer that finds a `rev` other than its own last
   * one knows someone else (another window, the engine) wrote the note since,
   * and merges instead of overwriting.
   */
  readonly rev?: string;
}

export interface NoteMeta {
  readonly noteId: string;
  readonly engine: EngineName;
  /** The note's title; empty when untitled. */
  readonly title: string;
  /** The start of the body text, whitespace collapsed (for the note list). */
  readonly excerpt: string;
  /** Frontmatter and inline tags (T18), sorted. */
  readonly tags: readonly string[];
  readonly updatedAt: number;
  readonly unsynced: boolean;
  readonly deleted: boolean;
  /** When a deleted note was deleted and from which folder (T21's Trash), if recorded. */
  readonly deletedAt?: number;
  readonly deletedFrom?: string | null;
  readonly bytes: number;
  /** The note's wikilinks and embeds (T16): the local backlinks and graph index. Absent: none. */
  readonly links?: readonly NoteLink[];
  /** As in the record: absent when its links were never computed. */
  readonly linksVersion?: number;
}

/** A document's changes kept as the page went (A626), merged into its record on the next open. */
export interface UnloadWrite {
  readonly noteId: string;
  readonly engine: EngineName;
  /**
   * Who kept it (A640): one entry per source per page, so two never overwrite each other, as a
   * note's editor and an embed of it in the same page would.
   */
  readonly source: string;
  /** The changes the stored record lacks, or the whole document when `whole` (a Yjs update). */
  readonly update: Uint8Array;
  /** `update` is the whole document: it stands alone when no record is stored. */
  readonly whole: boolean;
  readonly unsynced: boolean;
  readonly updatedAt: number;
}

/** Called inside a read-write transaction; returns the record to store, or null to leave it as it is. */
export type RecordUpdater = (current: NoteRecord | undefined) => NoteRecord | null;

/** The storage the replica keeper needs; NoteStore (IndexedDB) implements it. */
export interface ReplicaStore {
  get(noteId: string): Promise<NoteRecord | undefined>;
  put(record: NoteRecord): Promise<void>;
  /**
   * Read-modify-write of one record in a single transaction, so two writers
   * (windows, the engine) never overwrite each other's changes. `fn` must
   * be synchronous. Resolves with what was stored (null when `fn` declined).
   */
  update?(noteId: string, fn: RecordUpdater): Promise<NoteRecord | null>;
  /**
   * Keeps `write` as the page goes (A626), synchronously, in this call: nothing that waits for
   * a callback lands once `pagehide` has fired (an IndexedDB write is aborted with the page).
   * It is merged into the stored record when the store next opens. False when it cannot (no
   * page storage, it is full, or the change is too large): the caller writes as usual instead.
   */
  putOnUnload?(write: UnloadWrite): boolean;
  /** Drops what `putOnUnload` kept for the note from `source`: a later write stored all of it. */
  forgetUnload?(noteId: string, source: string): void;
  /**
   * How many unsynced changes kept as a page went (`putOnUnload`) to `noteId` could not be
   * merged and were dropped since this was last asked, then forgets them (#116 S2, A676): the
   * folder notice says so once, in whichever window shows it. Counted for the folder tree only
   * (a note's lost edits become conflict copies), so 0 for a note.
   */
  takeUnloadDrops?(noteId: string): Promise<number>;
}

/**
 * How links are computed (T16). Records stored before T16 have no
 * `linksVersion`: their links were never computed, which is not the same as
 * having none. Raise it when link extraction changes, to compute them again.
 */
export const LINKS_VERSION = 1;

/**
 * The record's `links` fields for links just computed (`links` left out when
 * there are none); nothing when they were not computed (`undefined`).
 */
export function linksField(links: readonly NoteLink[] | undefined): {
  links?: readonly NoteLink[];
  linksVersion?: number;
} {
  if (links === undefined) return {};
  return { ...(links.length ? { links } : {}), linksVersion: LINKS_VERSION };
}

/** Whether a stored note's links were computed by an older build, or never. */
export function needsLinks(record: Pick<NoteRecord, 'linksVersion'>): boolean {
  return (record.linksVersion ?? 0) < LINKS_VERSION;
}

/** The record without its links fields, as a build before T16 stored it. */
export function withoutLinks(record: NoteRecord): NoteRecord {
  const copy: { -readonly [K in keyof NoteRecord]: NoteRecord[K] } = { ...record };
  delete copy.links;
  delete copy.linksVersion;
  return copy;
}
