/**
 * Building and merging stored note records (A7) for Yjs 14 notes, without an
 * editor: used by the replica keeper when another writer changed a record
 * (multi-window safety), by the git engine (A860) and for conflict copies (A5).
 */
import { ulid } from '@penmoss/core/ids';
import { extractLinks, type DocJson } from '@penmoss/core/links';
import { parseAttachmentPath } from '@penmoss/core/attachments';
import { noteHeadings } from '@penmoss/core/search';
import * as Y from '@y/y';
import {
  initNote,
  isDeleted,
  isoWithOffset,
  readNoteNotebook,
  readTitle,
  readTrashInfo,
  setDeleted,
  setNoteNotebook,
  type TrashInfo,
} from './note';
import { linksField, withoutLinks, type NoteRecord } from './record';

export { LINKS_VERSION, linksField, needsLinks, withoutLinks } from './record';
import { NOTE_META } from './note';
import { NOTE_ROOT } from './replica';
import { META_TAG_PREFIX, noteTags } from './tags';
import { bodyJson, createYjs14Replica } from './yjs14';

/** Appended to a conflict copy's title (A5). */
export const CONFLICT_SUFFIX = ' (conflict copy)';

/** The record with its links computed from its document (nothing else changes but `rev`). */
export function withLinks(record: NoteRecord): NoteRecord {
  const replica = createYjs14Replica();
  try {
    replica.applyUpdate(record.update);
    return { ...withoutLinks(record), ...linksField(replica.links()), rev: newRev() };
  } finally {
    replica.destroy();
  }
}

/** A new `rev` for a record write. */
export function newRev(): string {
  return crypto.randomUUID();
}

export interface RecordFields {
  readonly epoch: string | null;
  readonly unsynced: boolean;
  /** The copy has had the server's state (`NoteRecord.seeded`). */
  readonly seeded?: boolean | undefined;
  readonly updatedAt?: number;
}

/** The record for a document (title, text and deleted flag read from it). */
export function recordFromDoc(noteId: string, doc: Y.Doc, fields: RecordFields): NoteRecord {
  const replica = createYjs14Replica(doc);
  const deleted = isDeleted(doc);
  const trash = deleted ? readTrashInfo(doc) : {};
  const body = bodyJson(doc);
  return {
    noteId,
    engine: replica.engine,
    update: replica.encodeStateAsUpdate(),
    stateVector: replica.encodeStateVector(),
    text: replica.plainText(),
    title: readTitle(doc),
    ...linksField(extractLinks(body)),
    tags: noteTags(doc),
    headings: noteHeadings(body),
    ...(deleted ? { deleted: true } : {}),
    ...(trash.at !== undefined ? { deletedAt: trash.at } : {}),
    ...(trash.folderId !== undefined ? { deletedFrom: trash.folderId } : {}),
    epoch: fields.epoch,
    updatedAt: fields.updatedAt ?? Date.now(),
    unsynced: fields.unsynced,
    ...(fields.seeded ? { seeded: true } : {}),
    rev: newRev(),
  };
}

function docOf(updates: readonly Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc;
}

/** The record holding every update in `updates`, merged. */
export function recordFromUpdates(
  noteId: string,
  updates: readonly Uint8Array[],
  fields: RecordFields,
): NoteRecord {
  const doc = docOf(updates);
  try {
    return recordFromDoc(noteId, doc, fields);
  } finally {
    doc.destroy();
  }
}

/**
 * Merges a record another writer stored into the one this writer is about to
 * store. Nothing is lost: Yjs merges both, and the result is unsynced if
 * either side was, and has had the server's state if either had.
 */
export function mergeRecords(stored: NoteRecord, mine: NoteRecord): NoteRecord {
  return recordFromUpdates(mine.noteId, [stored.update, mine.update], {
    epoch: mine.epoch ?? stored.epoch,
    unsynced: mine.unsynced || stored.unsynced,
    seeded: mine.seeded === true || stored.seeded === true,
    updatedAt: Math.max(mine.updatedAt, stored.updatedAt),
  });
}

/** Applies a local change to a stored note (one that is not open), e.g. deleting it. */
export function changeRecord(record: NoteRecord, change: (doc: Y.Doc) => void): NoteRecord {
  const doc = docOf([record.update]);
  try {
    change(doc);
    return recordFromDoc(record.noteId, doc, {
      epoch: record.epoch,
      unsynced: true,
      seeded: record.seeded,
    });
  } finally {
    doc.destroy();
  }
}

/** Soft-deletes (or restores) a stored note, recording when and from where (T21). */
export function deleteRecord(record: NoteRecord, deleted = true, info?: TrashInfo): NoteRecord {
  return changeRecord(record, (doc) => setDeleted(doc, deleted, null, info));
}

/** The record with the note's notebook recorded (T43, A766); unchanged when it already says so. */
export function notebookRecord(record: NoteRecord, notebook: string): NoteRecord {
  const doc = docOf([record.update]);
  try {
    if (readNoteNotebook(doc) === notebook) return record;
  } finally {
    doc.destroy();
  }
  return changeRecord(record, (next) => setNoteNotebook(next, notebook));
}

/**
 * A5: a copy of a note's local state as a new note, saved when the server's
 * epoch changed (it was restored) so local changes are kept without merging
 * them into the restored document. The body is copied into fresh Yjs items
 * (this device's client id), so the copy shares no history with the original.
 */
export function conflictCopy(
  state: Uint8Array,
  options: { readonly id?: string; readonly now?: Date } = {},
): NoteRecord {
  const now = options.now ?? new Date();
  const id = options.id ?? ulid(now.getTime());
  const source = docOf([state]);
  const copy = new Y.Doc();
  try {
    const title = (readTitle(source).trim() || 'Untitled') + CONFLICT_SUFFIX;
    copy.transact(() => {
      // In the original's notebook (T43, A766): its record goes with it.
      const notebook = readNoteNotebook(source);
      initNote(
        copy,
        { id, created: isoWithOffset(now), kind: 'note', ...(notebook ? { notebook } : {}) },
        title,
      );
      copy.get(NOTE_ROOT).applyDelta(source.get(NOTE_ROOT).toDeltaDeep());
    });
    return recordFromDoc(id, copy, { epoch: null, unsynced: true, updatedAt: now.getTime() });
  } finally {
    source.destroy();
    copy.destroy();
  }
}

export interface NoteCopyOptions {
  /** The copy's title, as given (Duplicate's "(copy)" name, or the original's for another notebook). */
  readonly title: string;
  readonly id?: string;
  readonly now?: Date;
  /**
   * The copy's notebook record (T43, A766): undefined keeps the original's, null leaves none,
   * as for a note going to another git notebook, whose folders say nothing of the original's.
   */
  readonly notebook?: string | null;
  /** Links to notes copied with it: each original id to its copy's (T68, #230). */
  readonly links?: ReadonlyMap<string, string>;
  /**
   * Whether the frontmatter tags go with it (default true; A1353: Copy to Notebook's
   * Copy Tags). Inline `#tags` are the body's text and always go.
   */
  readonly tags?: boolean;
}

/** The node types that point at another note by `noteId` (wikilinks and embeds). */
const LINK_NODES = new Set(['wikilink', 'embed']);

/** Points each link and embed at the copy of the note it named, where there is one. */
function remapLinks(root: Y.Node, links: ReadonlyMap<string, string>): void {
  const visit = (node: Y.Node) => {
    const ops = (node.toDelta().toJSON() as { children?: { insert?: unknown }[] }).children ?? [];
    let index = 0;
    for (const op of ops) {
      if (typeof op.insert === 'string') {
        index += op.insert.length;
        continue;
      }
      const count = Array.isArray(op.insert) ? op.insert.length : 1;
      for (let i = 0; i < count; i++) {
        const child: unknown = node.get(index + i);
        if (!(child instanceof Y.Node)) continue;
        const name: unknown = (child as { name?: unknown }).name;
        if (typeof name === 'string' && LINK_NODES.has(name)) {
          const target: unknown = child.getAttr('noteId');
          const mapped = typeof target === 'string' ? links.get(target) : undefined;
          if (mapped) child.setAttr('noteId', mapped);
        }
        visit(child);
      }
      index += count;
    }
  };
  visit(root);
}

/**
 * A copy of a note as a new note (T68: Duplicate, #227, and a copy to another notebook, #230):
 * a new id and creation time, the title given, the body in fresh Yjs items (no shared history),
 * and the frontmatter tags unless `tags` is false. Comments stay with the original: they were
 * about that note.
 */
export function copyNote(state: Uint8Array, options: NoteCopyOptions): NoteRecord {
  const now = options.now ?? new Date();
  const id = options.id ?? ulid(now.getTime());
  const source = docOf([state]);
  const copy = new Y.Doc();
  try {
    const notebook = options.notebook === undefined ? readNoteNotebook(source) : options.notebook;
    copy.transact(() => {
      initNote(
        copy,
        { id, created: isoWithOffset(now), kind: 'note', ...(notebook ? { notebook } : {}) },
        options.title,
      );
      const meta = copy.get(NOTE_META);
      if (options.tags !== false) {
        for (const [key, value] of source.get(NOTE_META).attrEntries()) {
          if (String(key).startsWith(META_TAG_PREFIX)) meta.setAttr(String(key), value);
        }
      }
      copy.get(NOTE_ROOT).applyDelta(source.get(NOTE_ROOT).toDeltaDeep());
      if (options.links && options.links.size > 0) remapLinks(copy.get(NOTE_ROOT), options.links);
    });
    return recordFromDoc(id, copy, { epoch: null, unsynced: true, updatedAt: now.getTime() });
  } finally {
    source.destroy();
    copy.destroy();
  }
}

/** The attachments a note's body shows or links (`attachments/<sha256>.<ext>`), each once. */
export function noteAttachmentPaths(state: Uint8Array): string[] {
  const doc = docOf([state]);
  try {
    const found = new Set<string>();
    const visit = (node: DocJson) => {
      for (const value of Object.values(node.attrs ?? {})) {
        if (typeof value === 'string' && parseAttachmentPath(value)) found.add(value);
      }
      for (const child of node.content ?? []) visit(child);
    };
    visit(bodyJson(doc));
    return [...found];
  } finally {
    doc.destroy();
  }
}

/** The tags and headings of a stored note's merged update (records written before T18, T22). */
export function searchFieldsOfUpdate(update: Uint8Array): { tags: string[]; headings: string } {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return { tags: noteTags(doc), headings: noteHeadings(bodyJson(doc)) };
  } catch {
    return { tags: [], headings: '' };
  } finally {
    doc.destroy();
  }
}

/** A Yjs v1 update that carries nothing (no structs, no deletions). */
export function isEmptyUpdate(update: Uint8Array): boolean {
  return update.byteLength <= 2;
}
