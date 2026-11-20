/**
 * What `LocalNotebook` and its parts share: the notebook's notes as the notes API sees them
 * (title, text, tags, links, when each changed), cached by revision; the bases edits are checked
 * against (A121); how a link resolves; and the refusal every part throws.
 */
import { type LinkResolver } from '@penmoss/core';
import { extractLinks, type DocJson, type NoteLink } from '@penmoss/core/links';
import { noteSections, type NoteSection } from '@penmoss/core/search';
import { type FolderRecord } from '@penmoss/core/workspace';
import { type EditFailure } from '@penmoss/model/edit-engine';
import { readNoteState, renderNote } from '@penmoss/model/markdown';
import { isDeleted, readIdentity } from '@penmoss/model/note';
import { readWorkspace } from '@penmoss/model/workspace';
import * as Y from '@y/y';
import type { GitNotebookEngine } from '../engine';
import { NotebookOpError, type NotebookOps } from '../ops';
import { isPurged } from '../purge';
import { changedAtOf } from '../render';

/**
 * A refusal, as the notes API answers one: a status and `{ error: { code, message, details } }`
 * (A843's REST routes, the MCP tools and the CLI all read it).
 */
export class LocalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LocalError';
  }
}

/** Throws an edit engine's refusal as a `LocalError`. */
export const fail = (failure: EditFailure): never => {
  throw new LocalError(failure.status, failure.code, failure.message, failure.details);
};

/** What one note looks like to listings, search and links. */
export interface NoteInfo {
  readonly id: string;
  readonly rev: number;
  readonly title: string;
  readonly kind: string;
  readonly period: string | null;
  readonly folderId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly tags: string[];
  /** Its description: the frontmatter `description`, by hand or AI Descriptions (A1656). */
  readonly description: string | null;
  readonly text: string;
  readonly headings: string;
  /** The body's heading sections: what meaning embeds (A1154). */
  readonly sections: readonly NoteSection[];
  readonly deleted: boolean;
  readonly links: NoteLink[];
}

/** A note id as the notes API takes one. */
const NOTE_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** How many earlier states of a note a process keeps as bases for edits (A121). */
const MAX_BASES = 8;

export class NoteCatalog {
  private readonly cache = new Map<string, NoteInfo>();
  /** Earlier states of notes this process read: the bases edits are checked against (A121). */
  private readonly bases = new Map<string, Map<number, Uint8Array>>();

  constructor(readonly ops: NotebookOps) {}

  get engine(): GitNotebookEngine {
    return this.ops.engine;
  }

  get workspace(): Y.Doc {
    return this.ops.workspace;
  }

  /** A note as listings see it, cached by revision and folder. */
  info(id: string, folderId: string | null): NoteInfo | null {
    const doc = this.ops.note(id);
    if (!doc) return null;
    const rev = this.engine.replica.rev(id);
    const cached = this.cache.get(id);
    if (cached && cached.rev === rev && cached.folderId === folderId) return cached;
    const state = readNoteState(doc);
    const rendered = renderNote(state, id, 0);
    const identity = readIdentity(doc);
    const created = identity.created ? Date.parse(identity.created) : 0;
    const dirtyAt = this.engine.replica.state.dirty[id] ?? 0;
    const info: NoteInfo = {
      id,
      rev,
      title: state.title,
      kind: identity.kind ?? 'note',
      period: identity.period ?? null,
      folderId,
      createdAt: Number.isFinite(created) ? created : 0,
      updatedAt: Math.max(changedAtOf(doc), dirtyAt, Number.isFinite(created) ? created : 0),
      tags: rendered.tags,
      description: state.description ?? null,
      text: rendered.text,
      headings: rendered.headings,
      sections: noteSections(state.body.toJSON() as DocJson),
      deleted: isDeleted(doc),
      links: extractLinks(state.body.toJSON() as DocJson),
    };
    this.cache.set(id, info);
    return info;
  }

  /** The note as last described, without reading it again (search reads it after a refresh). */
  cached(id: string): NoteInfo | undefined {
    return this.cache.get(id);
  }

  /** Every note of the notebook (registered and not purged), in Trash or not. */
  all(): NoteInfo[] {
    const out: NoteInfo[] = [];
    for (const entry of readWorkspace(this.workspace).notes) {
      if (isPurged(this.workspace, entry.id)) continue;
      const info = this.info(entry.id, entry.folderId);
      if (info) out.push(info);
    }
    return out;
  }

  /** Every note not in Trash. */
  live(): NoteInfo[] {
    return this.all().filter((note) => !note.deleted);
  }

  /** The ids of the notes this notebook holds (in Trash or not), which short references name. */
  heldIds(): string[] {
    return readWorkspace(this.workspace)
      .notes.map((note) => note.id)
      .filter((id) => !isPurged(this.workspace, id));
  }

  /** A note this notebook holds, or `invalid_request` / `not_found`. */
  require(id: string): { doc: Y.Doc; info: NoteInfo } {
    if (!NOTE_ID.test(id)) throw new LocalError(400, 'invalid_request', 'Invalid note id');
    const entry = readWorkspace(this.workspace).notes.find((note) => note.id === id);
    const info = entry && !isPurged(this.workspace, id) ? this.info(id, entry.folderId) : null;
    if (!info) throw new LocalError(404, 'not_found', 'No such note');
    return { doc: this.ops.note(id)!, info };
  }

  /** A note that may be edited: held here and not in Trash (`in_trash`). */
  writable(id: string): { doc: Y.Doc; info: NoteInfo } {
    const found = this.require(id);
    if (found.info.deleted) {
      throw new LocalError(409, 'in_trash', 'The note is in Trash; restore it before editing');
    }
    return found;
  }

  folders(): FolderRecord[] {
    return readWorkspace(this.workspace).folders;
  }

  folder(id: string): FolderRecord | undefined {
    return this.folders().find((folder) => folder.id === id);
  }

  /**
   * Links resolved within this notebook, as an agent's are (A10): a target names a note the
   * body already links by that title, else the most recently edited live note with that title
   * (ignoring case), else a note id.
   */
  resolver(body: Y.Doc | null): LinkResolver {
    const notes = this.all().sort((a, b) => b.updatedAt - a.updatedAt);
    const byId = new Map(notes.map((note) => [note.id, note]));
    const linked = new Map<string, string>();
    if (body) {
      for (const link of extractLinks(readNoteState(body).body.toJSON() as DocJson)) {
        const key = link.target.trim().toLowerCase();
        if (link.noteId && key && !linked.has(key)) linked.set(key, link.noteId);
        const title = link.noteId ? byId.get(link.noteId)?.title.trim().toLowerCase() : '';
        if (link.noteId && title && !linked.has(title)) linked.set(title, link.noteId);
      }
    }
    const byTitle = new Map<string, string>();
    for (const note of notes) {
      const key = note.title.trim().toLowerCase();
      if (key && !note.deleted && !byTitle.has(key)) byTitle.set(key, note.id);
    }
    const title = (id: string) => byId.get(id)?.title || null;
    return {
      resolve: (target) => {
        const key = target.trim().toLowerCase();
        if (!key) return null;
        return (
          linked.get(key) ?? byTitle.get(key) ?? (byId.has(target.trim()) ? target.trim() : null)
        );
      },
      linkText: title,
      title,
    };
  }

  /** Keeps the note's state as a base a later edit may name (A121). */
  remember(id: string, doc: Y.Doc): number {
    const rev = this.engine.replica.rev(id);
    let kept = this.bases.get(id);
    if (!kept) this.bases.set(id, (kept = new Map<number, Uint8Array>()));
    if (!kept.has(rev)) {
      kept.set(rev, Y.encodeStateAsUpdate(doc));
      while (kept.size > MAX_BASES) kept.delete(kept.keys().next().value!);
    }
    return rev;
  }

  /** The note's state at `rev`, if this process kept it as a base. */
  base(id: string, rev: number): Uint8Array | undefined {
    return this.bases.get(id)?.get(rev);
  }

  /** Who this clone's writer is: the author of its comments and of what history has not committed. */
  self() {
    const writer = this.engine.writer;
    const who = this.engine.who;
    return { id: writer?.id ?? 'this-device', kind: who.kind, label: who.label };
  }

  /** Runs a NotebookOps change, its refusals as `LocalError`s. */
  op<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof NotebookOpError)
        throw new LocalError(error.status, error.code, error.message);
      throw error;
    }
  }
}
