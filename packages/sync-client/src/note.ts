/**
 * The shape of a note's Yjs document (A16), shared by clients and the NoteDoc:
 *
 * - `prosemirror` (NOTE_ROOT): the body, bound to the editor.
 * - `title`: the title as plain text, so concurrent title edits merge by character.
 * - `meta`: attributes `id`, `created` (ISO 8601), `kind`, for periodic
 *   notes `period`, and `deleted` (soft delete, restorable). Later tasks add
 *   tags and aliases here. `notebook` (T43, A766) is the notebook the note
 *   belongs to as the client that made or last moved it saw it: a notebook's
 *   folder id, or `default`. The git mirror writes a note only where the folder
 *   tree and this record agree.
 *
 * `updated` is not stored in the document (it would change on every
 * keystroke); the NoteDoc stamps it when it indexes the note.
 */
import * as Y from '@y/y';

export const NOTE_TITLE = 'title';
export const NOTE_META = 'meta';
/** The meta attribute holding the note's notebook (T43, A766). */
export const NOTE_NOTEBOOK = 'notebook';

export type NoteKind = 'note' | 'daily' | 'weekly';

export interface NoteIdentity {
  readonly id: string;
  /** ISO 8601 with offset. */
  readonly created: string;
  readonly kind: NoteKind;
  readonly period?: string | undefined;
  /** The note's notebook (T43, A766): its folder id, or `default`. */
  readonly notebook?: string | undefined;
}

/** The note's own record of its notebook (T43, A766), or null for a note made before it. */
export function readNoteNotebook(doc: Y.Doc): string | null {
  const value: unknown = doc.get(NOTE_META).getAttr(NOTE_NOTEBOOK);
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Records the note's notebook (T43, A766): set by the client that makes a note, and by whoever
 * moves it to another notebook, from what that client sees. No change when it already says so.
 */
export function setNoteNotebook(doc: Y.Doc, notebook: string, origin: unknown = null): void {
  if (readNoteNotebook(doc) === notebook) return;
  doc.transact(() => doc.get(NOTE_META).setAttr(NOTE_NOTEBOOK, notebook), origin);
}

/** The title as plain text (no line breaks). */
export function readTitle(doc: Y.Doc): string {
  return doc.get(NOTE_TITLE).toString();
}

/**
 * Makes the title equal `next` with the smallest edit (common prefix and
 * suffix kept), so a concurrent edit elsewhere in the title survives.
 */
export function setTitle(doc: Y.Doc, next: string, origin: unknown = null): void {
  const clean = next.replace(/[\r\n]+/g, ' ');
  const type = doc.get(NOTE_TITLE);
  const current = type.toString();
  if (current === clean) return;
  let start = 0;
  const max = Math.min(current.length, clean.length);
  while (start < max && current[start] === clean[start]) start++;
  let end = 0;
  while (end < max - start && current[current.length - 1 - end] === clean[clean.length - 1 - end]) {
    end++;
  }
  doc.transact(() => {
    const removed = current.length - start - end;
    if (removed > 0) type.delete(start, removed);
    const inserted = clean.slice(start, clean.length - end);
    if (inserted) type.insert(start, inserted);
  }, origin);
}

export function readIdentity(doc: Y.Doc): Partial<NoteIdentity> {
  const meta = doc.get(NOTE_META);
  const id: unknown = meta.getAttr('id');
  const created: unknown = meta.getAttr('created');
  const kind: unknown = meta.getAttr('kind');
  const period: unknown = meta.getAttr('period');
  return {
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof created === 'string' ? { created } : {}),
    ...(kind === 'note' || kind === 'daily' || kind === 'weekly' ? { kind } : {}),
    ...(typeof period === 'string' ? { period } : {}),
  };
}

/** Sets up a new note's identity (and title) in one transaction. */
export function initNote(
  doc: Y.Doc,
  identity: NoteIdentity,
  title = '',
  origin: unknown = null,
): void {
  doc.transact(() => {
    const meta = doc.get(NOTE_META);
    meta.setAttr('id', identity.id);
    meta.setAttr('created', identity.created);
    meta.setAttr('kind', identity.kind);
    if (identity.period) meta.setAttr('period', identity.period);
    if (identity.notebook) meta.setAttr(NOTE_NOTEBOOK, identity.notebook);
    if (title) setTitle(doc, title);
  }, origin);
}

/** ISO 8601 with the local UTC offset, e.g. `2026-10-22T09:15:00-05:00` (frontmatter `created`). */
export function isoWithOffset(date: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/** Where a note was when it went to Trash (T21), so restoring puts it back. */
export interface TrashInfo {
  /** When it was deleted (epoch ms, the deleting device's clock). */
  readonly at: number;
  /** Its folder then; null at the top level. */
  readonly folderId: string | null;
}

/**
 * Soft-deletes (or restores) a note; the change syncs like any edit, and the
 * indexer hides it. A deletion can record when and from which folder (T21's
 * Trash); restoring clears both.
 */
export function setDeleted(
  doc: Y.Doc,
  deleted: boolean,
  origin: unknown = null,
  info?: TrashInfo,
): void {
  doc.transact(() => {
    const meta = doc.get(NOTE_META);
    if (deleted) {
      meta.setAttr('deleted', true);
      if (info) {
        meta.setAttr('deletedAt', info.at);
        meta.setAttr('deletedFrom', info.folderId ?? '');
      }
    } else {
      meta.deleteAttr('deleted');
      if (meta.hasAttr('deletedAt')) meta.deleteAttr('deletedAt');
      if (meta.hasAttr('deletedFrom')) meta.deleteAttr('deletedFrom');
    }
  }, origin);
}

/** When and from where the note was deleted, if recorded (T21). */
export function readTrashInfo(doc: Y.Doc): Partial<TrashInfo> {
  const meta = doc.get(NOTE_META);
  const at: unknown = meta.getAttr('deletedAt');
  const from: unknown = meta.getAttr('deletedFrom');
  return {
    ...(typeof at === 'number' && Number.isFinite(at) ? { at } : {}),
    ...(typeof from === 'string' ? { folderId: from === '' ? null : from } : {}),
  };
}

export function isDeleted(doc: Y.Doc): boolean {
  return doc.get(NOTE_META).getAttr('deleted') === true;
}
