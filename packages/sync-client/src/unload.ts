/**
 * Changes kept as a page went (A626): how an entry is stored, and what merging it into the
 * stored record makes. DOM-free; `NoteStore` keeps the entries and merges them when it opens.
 */
import * as Y from '@y/y';
import { fromBase64, toBase64 } from 'lib0/buffer';
import type { NoteRecord, UnloadWrite } from './record';
import { conflictCopy, recordFromDoc, recordFromUpdates } from './records';
import { WORKSPACE_RECORD_KEY } from './workspace';

/**
 * The largest entry kept (characters of JSON; about 0.75 MB of Yjs update). Local storage holds
 * about 5M characters per origin, the session token among them (A640): a larger change is
 * written the ordinary way instead.
 */
export const UNLOAD_MAX_CHARS = 1_000_000;

export function encodeUnloadWrite(write: UnloadWrite): string {
  return JSON.stringify({ ...write, update: toBase64(write.update) });
}

export function decodeUnloadWrite(raw: string): UnloadWrite | null {
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof UnloadWrite, unknown>>;
    if (typeof value.noteId !== 'string' || typeof value.update !== 'string') return null;
    if (value.engine !== 'yjs14') return null;
    return {
      noteId: value.noteId,
      engine: value.engine,
      source: typeof value.source === 'string' ? value.source : '',
      epoch: typeof value.epoch === 'string' ? value.epoch : null,
      update: fromBase64(value.update),
      whole: value.whole === true,
      unsynced: value.unsynced !== false,
      ...(value.seeded === true ? { seeded: true } : {}),
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The id of the conflict copy an entry makes, from its key and its content (PR #167): every
 * window of the origin hears the same entry and may merge it at once, and each then makes the
 * same note, never a copy each. A ULID, timed when the change was kept.
 */
export async function unloadCopyId(key: string, raw: string, keptAt: number): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${key}\n${raw}`)),
  );
  let time = '';
  const at = Number.isInteger(keptAt) && keptAt >= 0 && keptAt < 2 ** 48 ? keptAt : 0;
  for (let rest = at, i = 0; i < 10; i++) {
    time = ULID_ALPHABET[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  let rest = '';
  for (let i = 0; i < 16; i++) rest += ULID_ALPHABET[digest[i]! & 31];
  return time + rest;
}

/** What merging one entry did. */
export type UnloadOutcome =
  /** Its changes joined the record (or made it, for a note not stored yet). */
  | 'merged'
  /** The record held all of it already: nothing written. */
  | 'unchanged'
  /**
   * The record held all of it, but its text, tags or links were of an older state (A695): the
   * page went after a write that reused them and before their refresh. Written again, described.
   */
  | 'described'
  /** It could not join the record (another epoch, its base gone): its edits became a new note. */
  | 'copied'
  /** It could not join the record, and held nothing the server lacks, or only changes alone. */
  | 'dropped';

function docOf(updates: readonly Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc;
}

/**
 * Whether a stored record's description is the one its document gives (A695): text, tags,
 * links, and whether it is deleted, when and from where. A write that reused them could leave
 * any of these behind, a deletion or restore within the text interval too.
 */
function sameDescription(stored: NoteRecord, fresh: NoteRecord): boolean {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return (
    stored.text === fresh.text &&
    same(stored.tags, fresh.tags) &&
    same(stored.links, fresh.links) &&
    (stored.deleted ?? false) === (fresh.deleted ?? false) &&
    stored.deletedAt === fresh.deletedAt &&
    stored.deletedFrom === fresh.deletedFrom
  );
}

/** Structs or deletions the document holds back because what they build on is missing. */
function pendingIn(doc: Y.Doc): boolean {
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

/**
 * The records to store for `write`, kept as a page went, given the stored record (A626, A640).
 * A union with the record when they are the same document at the same epoch (A7). Otherwise
 * never merged: another epoch (A5), or a base the record no longer holds (it was purged and made
 * again, or replaced by a recovery, A581), would add another document's structs. A note's whole
 * document with edits the server lacks then becomes a conflict copy, as catch-up does (A269);
 * anything else is dropped. A note the server said is gone keeps its record as it is (its gone
 * copy holds what it had): changes since become a conflict copy of their own.
 */
export function withUnloadWrite(
  stored: NoteRecord | undefined,
  write: UnloadWrite,
  /**
   * The conflict copy's id, if it makes one: the same for every window that merges this entry
   * (`unloadCopyId`), so they make one note, not one each.
   */
  copyId?: string,
): { readonly records: NoteRecord[]; readonly outcome: UnloadOutcome } {
  const copyOf = (state: Uint8Array) =>
    conflictCopy(state, copyId ? { id: copyId, now: new Date(write.updatedAt) } : {});
  const copyOrDrop = () =>
    write.whole && write.unsynced && write.noteId !== WORKSPACE_RECORD_KEY
      ? { records: [copyOf(write.update)], outcome: 'copied' as const }
      : { records: [], outcome: 'dropped' as const };
  if (stored && (stored.engine as string) !== write.engine) return copyOrDrop();
  if (!stored) {
    if (!write.whole) return { records: [], outcome: 'dropped' };
    const record = recordFromUpdates(write.noteId, [write.update], {
      epoch: write.epoch,
      unsynced: write.unsynced,
      seeded: write.seeded,
      updatedAt: write.updatedAt,
    });
    return { records: [record], outcome: 'merged' };
  }
  if (stored.epoch && write.epoch && stored.epoch !== write.epoch) return copyOrDrop();

  const before = docOf([stored.update]);
  const merged = docOf([stored.update, write.update]);
  try {
    if (pendingIn(merged) && !pendingIn(before)) return copyOrDrop();
    if (Y.equalSnapshots(Y.snapshot(before), Y.snapshot(merged))) {
      // An entry with nothing new still says the page went with the description's refresh due.
      if (!stored.gone && write.noteId !== WORKSPACE_RECORD_KEY) {
        const described = recordFromDoc(write.noteId, before, {
          epoch: stored.epoch ?? write.epoch,
          unsynced: stored.unsynced,
          seeded: write.seeded || stored.seeded,
          // Later than the stored record's, if only by 1 ms: what keeps a copy of the record by
          // its `updatedAt` (the saved offline search index) takes the new description.
          updatedAt: Math.max(write.updatedAt, stored.updatedAt + 1),
        });
        if (!sameDescription(stored, described)) {
          return { records: [described], outcome: 'described' };
        }
      }
      return { records: [], outcome: 'unchanged' };
    }
    const update = Y.encodeStateAsUpdate(merged);
    if (stored.gone) {
      // Its record stays as the server left it: merged, the next upload would be refused as gone
      // and copied again, beside the copy made when it went (A269, A5).
      return write.unsynced && write.noteId !== WORKSPACE_RECORD_KEY
        ? { records: [copyOf(update)], outcome: 'copied' }
        : { records: [], outcome: 'dropped' };
    }
    const record = recordFromUpdates(write.noteId, [update], {
      epoch: stored.epoch ?? write.epoch,
      unsynced: write.unsynced || stored.unsynced,
      seeded: write.seeded || stored.seeded,
      updatedAt: Math.max(write.updatedAt, stored.updatedAt),
    });
    return { records: [record], outcome: 'merged' };
  } finally {
    before.destroy();
    merged.destroy();
  }
}
