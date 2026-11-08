/**
 * Local changes to a git notebook (T50 G1/G2): what the CLI, the local MCP and the tests do to the
 * docs. Each change lands in the replica at once (and is saved by the caller); the next sync
 * carries it. The rules are the apps': the same WorkspaceDoc and note helpers, ids from
 * `@penmoss/core`, and the notebook's own settings (A827: the `notebook/` keys).
 */
import { parseMarkdown, ulid } from '@penmoss/core';
import { isSha256 } from '@penmoss/core/attachments';
import {
  DEFAULT_DAILY_TEMPLATE,
  DEFAULT_TIME_ZONE,
  DEFAULT_WEEKLY_TEMPLATE,
  isoWeek,
  isTimeZone,
  journalFolderId,
  parsePlainDate,
  todayIn,
  type PeriodKind,
} from '@penmoss/core/periodic';
import { keyBetween } from '@penmoss/core/workspace';
import { periodicNote } from '@penmoss/editor/periodic';
import { initNote, isDeleted, setDeleted, type NoteKind } from '@penmoss/sync-client/note';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import {
  createFolder,
  deleteFolder,
  moveFolder,
  moveNote,
  readSettings,
  readWorkspace,
  registerNote,
  renameFolder,
  restoreFolder,
  setSetting,
} from '@penmoss/sync-client/workspace';
import { docToDelta } from '@y/prosemirror';
import * as Y from '@y/y';
import type { GitNotebookEngine } from './engine';
import { notebookSalt } from './layout';
import { isPurged, markPurged } from './purge';

/** A git notebook's own settings live under this user id in the WorkspaceDoc (A827). */
export const NOTEBOOK_SETTINGS = 'notebook';
/** Attachments in the repository are refused over this (A828; A213's cap, no R2 here). */
export const NOTEBOOK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export class NotebookOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = 'NotebookOpError';
  }
}

/** ISO 8601 with the offset of `timeZone` at `at` (frontmatter `created`, A209). */
export function isoInZone(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  const local = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
  const asUtc = Date.parse(`${local}Z`);
  const offset = Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export class NotebookOps {
  constructor(
    readonly engine: GitNotebookEngine,
    private readonly clock: () => number = Date.now,
    private readonly newId: () => string = ulid,
  ) {}

  get workspace(): Y.Doc {
    return this.engine.replica.workspace;
  }

  /**
   * The salt of its derived ids (A820): the notebook's id, or `notebook.json`'s own (`''` for the
   * notebook imported from the personal workspace, A1021).
   */
  get salt(): string {
    const info = this.engine.info;
    if (!info)
      throw new NotebookOpError('no_notebook', 'The notebook has not been opened yet', 409);
    return notebookSalt(info);
  }

  /** The notebook's settings (A827): `timeZone`, `template.daily`, `template.weekly`, `sort`… */
  settings(): Record<string, unknown> {
    return readSettings(this.workspace, NOTEBOOK_SETTINGS);
  }

  timeZone(): string {
    const zone = this.settings()['timeZone'];
    return typeof zone === 'string' && isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
  }

  setSetting(key: string, value: unknown): void {
    setSetting(this.workspace, NOTEBOOK_SETTINGS, key, value);
  }

  note(id: string): Y.Doc | undefined {
    return this.engine.replica.note(id);
  }

  /** A note that exists, is registered, and is not purged. */
  requireNote(id: string): Y.Doc {
    const doc = this.note(id);
    if (!doc || !readWorkspace(this.workspace).notes.some((note) => note.id === id)) {
      throw new NotebookOpError('not_found', 'No such note', 404);
    }
    return doc;
  }

  requireFolder(id: string | null): void {
    if (id === null) return;
    if (!readWorkspace(this.workspace).folders.some((folder) => folder.id === id)) {
      throw new NotebookOpError('folder_not_found', 'No such folder', 422);
    }
  }

  /** A new note with a title and a body (a core-schema document, or markdown). */
  createNote(input: {
    readonly id?: string;
    readonly title: string;
    readonly folderId?: string | null;
    readonly body?: Parameters<typeof docToDelta>[0] | null;
    readonly markdown?: string;
    readonly kind?: NoteKind;
  }): string {
    const id = input.id ?? this.newId();
    const folderId = input.folderId ?? null;
    this.requireFolder(folderId);
    if (this.note(id)) throw new NotebookOpError('conflict', 'A note with this id exists', 409);
    if (isPurged(this.workspace, id)) {
      throw new NotebookOpError('gone', 'That note was deleted for good', 409);
    }
    const doc = this.engine.replica.ensureNote(id);
    doc.transact(() => {
      initNote(
        doc,
        { id, created: isoInZone(this.clock(), this.timeZone()), kind: input.kind ?? 'note' },
        input.title,
      );
      // No body given: none written, as the server's create of an empty note.
      const body =
        input.body ?? (input.markdown === undefined ? null : parseMarkdown(input.markdown).doc);
      if (body) doc.get(NOTE_ROOT).applyDelta(docToDelta(body));
    });
    registerNote(this.workspace, { id, folderId });
    return id;
  }

  /**
   * The daily or weekly note of `date` (today in the notebook's time zone without one), made from
   * the notebook's template when no device has made it yet (A4, A76, A827): its id and its Yjs
   * client ids are salted with the notebook's id (A820), so two devices that make it offline make
   * one note, never the personal workspace's. Filed under `Journal/<year>/<month>` (or `/Weekly`).
   */
  daily(input: {
    readonly kind?: PeriodKind;
    readonly date?: string | null;
    readonly create: boolean;
  }) {
    const kind = input.kind ?? 'daily';
    const timeZone = this.timeZone();
    const day = input.date ? parsePlainDate(input.date) : todayIn(timeZone, new Date(this.clock()));
    if (!day) {
      throw new NotebookOpError(
        'invalid_request',
        `date must be a calendar date like 2026-10-22 (got ${input.date})`,
        400,
      );
    }
    const period = kind === 'daily' ? day.toString() : isoWeek(day).toString();
    const settings = this.settings();
    const configured = settings[`template.${kind}`];
    const template =
      typeof configured === 'string'
        ? configured
        : kind === 'daily'
          ? DEFAULT_DAILY_TEMPLATE
          : DEFAULT_WEEKLY_TEMPLATE;
    // A day whose note was deleted for good gets a new one, under the next salt (`<id>#2`, …):
    // every device skips the same purged ids, so they still agree on it.
    let note = periodicNote({ parseMarkdown }, kind, period, template, this.salt);
    for (let round = 2; isPurged(this.workspace, note.id); round++) {
      note = periodicNote({ parseMarkdown }, kind, period, template, `${this.salt}#${round}`);
    }
    const registered = readWorkspace(this.workspace).notes.some((entry) => entry.id === note.id);
    let created = false;
    let restoredFromTrash = false;
    const existing = this.note(note.id);
    if (!input.create && (!existing || !registered)) {
      return {
        id: note.id,
        kind,
        period,
        date: day.toString(),
        timeZone,
        created,
        restoredFromTrash,
        exists: false,
      };
    }
    if (!existing) {
      Y.applyUpdate(this.engine.replica.ensureNote(note.id), note.update);
      created = true;
    } else if (isDeleted(existing)) {
      setDeleted(existing, false);
      restoredFromTrash = true;
    }
    if (!registered) {
      const year = period.slice(0, 4);
      const levels = ['Journal', year, kind === 'daily' ? period.slice(5, 7) : 'Weekly'];
      let parentId: string | null = null;
      for (let depth = 1; depth <= levels.length; depth++) {
        const folderId = journalFolderId(levels.slice(0, depth).join('/'), this.salt);
        if (!readWorkspace(this.workspace).folders.some((folder) => folder.id === folderId)) {
          createFolder(this.workspace, { id: folderId, name: levels[depth - 1]!, parentId });
        }
        parentId = folderId;
      }
      registerNote(this.workspace, { id: note.id, folderId: parentId });
    }
    return {
      id: note.id,
      kind,
      period,
      date: day.toString(),
      timeZone,
      created,
      restoredFromTrash,
      exists: true,
    };
  }

  trash(id: string): { alreadyInTrash: boolean; folderId: string | null; deletedAt: number } {
    const doc = this.requireNote(id);
    const entry = readWorkspace(this.workspace).notes.find((note) => note.id === id)!;
    if (isDeleted(doc)) {
      const at: unknown = doc.get('meta').getAttr('deletedAt');
      return {
        alreadyInTrash: true,
        folderId: entry.folderId,
        deletedAt: typeof at === 'number' ? at : this.clock(),
      };
    }
    const at = this.clock();
    setDeleted(doc, true, null, { at, folderId: entry.folderId });
    return { alreadyInTrash: false, folderId: entry.folderId, deletedAt: at };
  }

  restore(id: string): { restored: boolean; folderId: string | null } {
    const doc = this.requireNote(id);
    const entry = readWorkspace(this.workspace).notes.find((note) => note.id === id)!;
    if (!isDeleted(doc)) return { restored: false, folderId: entry.folderId };
    setDeleted(doc, false);
    // Back where it was; the top level when that folder is gone.
    const folders = new Set(readWorkspace(this.workspace).folders.map((folder) => folder.id));
    if (entry.folderId !== null && !folders.has(entry.folderId)) {
      moveNote(this.workspace, id, null, keyBetween(null, null));
      return { restored: true, folderId: null };
    }
    return { restored: true, folderId: entry.folderId };
  }

  move(id: string, folderId: string | null): void {
    this.requireNote(id);
    this.requireFolder(folderId);
    const siblings = readWorkspace(this.workspace)
      .notes.filter((note) => note.folderId === folderId && note.id !== id)
      .map((note) => note.position)
      .sort();
    moveNote(this.workspace, id, folderId, keyBetween(siblings.at(-1) ?? null, null));
  }

  createFolder(input: {
    readonly id?: string;
    readonly name: string;
    readonly parentId: string | null;
  }): string {
    const id = input.id ?? this.newId();
    this.requireFolder(input.parentId);
    createFolder(this.workspace, { id, name: input.name, parentId: input.parentId });
    return id;
  }

  renameFolder(id: string, name: string): void {
    renameFolder(this.workspace, id, name);
  }

  moveFolder(id: string, parentId: string | null, position?: string): void {
    moveFolder(this.workspace, id, parentId, position ?? keyBetween(null, null));
  }

  deleteFolder(id: string) {
    return deleteFolder(this.workspace, id, null, { now: this.clock() });
  }

  /** A note deleted for good (A828) is never filed again: kept out, and said (`keptOut`). */
  restoreFolder(id: string) {
    return restoreFolder(this.workspace, id, null, {
      keepOut: (noteId) => isPurged(this.workspace, noteId),
    });
  }

  /** Delete for good (A828): the id into `purged`, out of the tree, and the local copy gone. */
  purge(id: string): void {
    markPurged(this.workspace, id, this.clock());
    this.engine.replica.dropNote(id);
  }

  /**
   * Keeps an attachment's bytes for the next sync, which commits it under `attachments/` (A828),
   * and returns its path as notes write it. Refused over 10 MB.
   */
  async keepAttachment(bytes: Uint8Array, ext: string): Promise<{ sha256: string; path: string }> {
    if (bytes.byteLength > NOTEBOOK_ATTACHMENT_MAX_BYTES) {
      throw new NotebookOpError(
        'file_too_large',
        `Files in a git notebook are at most ${NOTEBOOK_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`,
        413,
      );
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
    if (!isSha256(sha256) || !/^[a-z0-9]{1,10}$/.test(ext)) {
      throw new NotebookOpError('invalid_request', 'Not an attachment', 400);
    }
    await this.engine.storage.writeAttachment(`${sha256}.${ext}`, bytes);
    return { sha256, path: `attachments/${sha256}.${ext}` };
  }
}
