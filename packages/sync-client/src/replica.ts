import type { NoteLink } from '@penmoss/core/links';
import type { EngineName } from './protocol';

/**
 * Name of the shared root type that holds a note's ProseMirror document.
 * The @y/prosemirror binding is configured to use it.
 */
export const NOTE_ROOT = 'prosemirror';

/** A run of visible text written by one actor (null when its client id is unmapped). */
export interface AttributedRun {
  readonly actor: string | null;
  readonly text: string;
}

/** What an update changed, beyond its bytes. */
export interface UpdateInfo {
  /**
   * It changed the note's comments and nothing else (T48, A770): not an edit, so it bumps no
   * `updated` time and no place in Recent.
   */
  readonly commentsOnly: boolean;
}

export type UpdateListener = (update: Uint8Array, origin: unknown, info?: UpdateInfo) => void;

/** The clocks `[from, to)` of one Yjs client. */
export interface ClockRange {
  readonly from: number;
  readonly to: number;
}

/** Clock ranges per Yjs client id; each list is sorted and merged. */
export type ClientRanges = ReadonlyMap<number, readonly ClockRange[]>;

/** What Yjs holds back until the content it depends on arrives. */
export interface PendingIds {
  /** Structs whose origins or parents are still missing. */
  readonly inserts: ClientRanges;
  /** Deletions of structs the replica does not have yet. */
  readonly deletes: ClientRanges;
}

/**
 * One replica of a note's Yjs document. The replica keeper, the IndexedDB store
 * and the git engine only speak this interface, which keeps them
 * independent of the Yjs version behind it (ADR 0003).
 */
export interface Replica {
  readonly engine: EngineName;
  readonly clientId: number;
  applyUpdate(update: Uint8Array, origin?: unknown): void;
  encodeStateAsUpdate(stateVector?: Uint8Array): Uint8Array;
  encodeStateVector(): Uint8Array;
  /** client id → next expected clock, i.e. how much of each client this replica holds. */
  stateVectorClocks(): Map<number, number>;
  /** The structs and deletions this replica holds back as pending. */
  pending(): PendingIds;
  /**
   * The clock ranges an update inserts, per client id. Deletions are left
   * out: a delete set names the deleted content's client, not the deleter's.
   * Throws on a malformed update.
   */
  insertRanges(update: Uint8Array): ClientRanges;
  /** Whether this replica already holds every struct in `ranges` of `clientId`, integrated or pending. */
  holds(clientId: number, ranges: readonly ClockRange[]): boolean;
  /** Fires after every transaction that changed the document, local or remote. */
  onUpdate(listener: UpdateListener): () => void;
  /** Visible text, one line per text block (for search, previews and IndexedDB). */
  plainText(): string;
  /** The note's wikilinks and embeds (T16), for the local backlinks and graph index. */
  links?(): NoteLink[];
  /** Visible text split into runs by the actor that inserted it. */
  attribute(actorOf: (clientId: number) => string | undefined): AttributedRun[];
  destroy(): void;
}

/** Appends a run, merging it into the previous one when the actor is the same. */
export function pushRun(runs: AttributedRun[], actor: string | null, text: string): void {
  if (text.length === 0) return;
  const last = runs.at(-1);
  if (last && last.actor === actor) {
    runs[runs.length - 1] = { actor, text: last.text + text };
  } else {
    runs.push({ actor, text });
  }
}

/** Whether two range maps hold exactly the same ids. */
export function sameRanges(a: ClientRanges, b: ClientRanges): boolean {
  if (a.size !== b.size) return false;
  for (const [client, ranges] of a) {
    const other = b.get(client);
    if (!other || other.length !== ranges.length) return false;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges[i]!.from !== other[i]!.from || ranges[i]!.to !== other[i]!.to) return false;
    }
  }
  return true;
}
