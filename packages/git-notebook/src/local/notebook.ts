/**
 * A git notebook's notes API, on this device (T50 G2, #150; A830): what the CLI's `--notebook`
 * and the local MCP server run. It answers as the server's REST API and MCP tools do (the same
 * shapes, codes and statuses), so the CLI's commands and an agent's tool calls work unchanged,
 * but every answer comes from the local engine: the shared edit engine (`@penmoss/editor`), the
 * offline search index (`@penmoss/sync-client/local-index`), core's links for backlinks, and the
 * notebook's own settings and salted periodic notes. Nothing here reaches the network; the next
 * sync carries every change.
 *
 * Differences from the server, all because there is no server: search is by words unless the
 * caller gives meaning (an embedder, a cache and an index, A1156); `baseVersion` is the note's local change counter, and a base this process never read is
 * `base_unknown`; agent limits, folder scopes and T43 notebooks do not exist here.
 */
import { isUlid, type LinkResolver } from '@penmoss/core';
import { attachmentPath, filePath, isImageType, sniffFileType } from '@penmoss/core/attachments';
import { findSection } from '@penmoss/core/diff-apply';
import { summarise } from '@penmoss/core/diff';
import { extractLinks, type DocJson, type NoteLink } from '@penmoss/core/links';
import { isTimeZone, type PeriodKind } from '@penmoss/core/periodic';
import {
  HYBRID_DEPTH,
  MATCH_END,
  MATCH_START,
  fuseHybrid,
  noteSections,
  parseQuery,
  type MeaningCoverage,
  type MeaningHit,
  type MeaningIndex,
  type MeaningNote,
  type NoteSection,
} from '@penmoss/core/search';
import { describeTags, normaliseTag, tagMatches, type DescribedTag } from '@penmoss/core/tags';
import {
  folderPath,
  folderSubtree,
  keyBetween,
  type FolderRecord,
  type SortMode,
} from '@penmoss/core/workspace';
import {
  applyPlan,
  baseConflict,
  bodyText,
  headingRefs,
  incomingMarkdown,
  NOTE_PROPERTIES,
  planCreate,
  planEdit,
  unknownProperties,
  type EditFailure,
  type EditOp,
} from '@penmoss/editor/edit-engine';
import { bodyDelta, readNoteState, renderNote, versionMarkdown } from '@penmoss/editor/markdown';
import {
  readThread,
  readThreads,
  setThreadDelivery,
  type CommentAuthor,
  type ThreadData,
} from '@penmoss/sync-client/comments';
import {
  planCommentChange,
  repliedDelivery,
  seenDelivery,
  threadUpdated,
  viewThread,
  viewThreads,
  type CommentChange,
  type StatusFilter,
} from '@penmoss/sync-client/comment-delivery';
import { LocalSearchIndex, type LocalSearchDocument } from '@penmoss/sync-client/local-index';
import { isDeleted, readIdentity } from '@penmoss/sync-client/note';
import { restoreContent, setBody } from '@penmoss/sync-client/history';
import { revertChange } from '@penmoss/editor/revert';
import { setFrontmatterTag } from '@penmoss/sync-client/tags';
import { readTagDescriptions, readWorkspace, setSortMode } from '@penmoss/sync-client/workspace';
import * as Y from '@y/y';
import { AgentActivity, type ActivityEntry } from '../agent-activity';
import type { GitNotebookEngine } from '../engine';
import { NotebookHistory, type GitHistory, type GitVersion } from '../history';
import { NOTEBOOK_ATTACHMENT_MAX_BYTES, NotebookOpError, type NotebookOps } from '../ops';
import { isPurged } from '../purge';
import { changedAtOf } from '../render';

/** A refusal, as the REST API answers one: a status and `{ error: { code, message, details } }`. */
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

const fail = (failure: EditFailure): never => {
  throw new LocalError(failure.status, failure.code, failure.message, failure.details);
};

/** Every edit's reply (A123): no server versions here, so `version` is null. */
export interface LocalEditReply {
  readonly id: string;
  readonly changed: boolean;
  readonly baseVersion: number;
  readonly summary?: string;
  readonly version: null;
}

/** A note as `GET /api/notes/:id/content` gives it (A121). */
export interface LocalNoteContent {
  readonly id: string;
  readonly title: string;
  readonly tags: string[];
  readonly markdown: string;
  readonly body: string;
  readonly headings: string[];
  readonly baseVersion: number;
  readonly deleted: boolean;
}

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
  readonly text: string;
  readonly headings: string;
  /** The body's heading sections: what meaning embeds (A1154). */
  readonly sections: readonly NoteSection[];
  readonly deleted: boolean;
  readonly links: NoteLink[];
}

/** Search by meaning for this notebook (A1156): its own index, over a shared cache. */
export interface LocalMeaning {
  readonly index: MeaningIndex;
  /**
   * How long one search may embed chunks the cache lacks (ms). 0 reads the cache only: the
   * lease holder indexes, everyone else embeds just the query and this budget (A1157).
   */
  readonly budgetMs?: number;
  /** Records the keys this notebook uses, so a compaction elsewhere keeps them (PEN-134). */
  readonly claim?: (keys: ReadonlySet<string>) => Promise<void>;
}

/** One search result, as the REST API's `GET /api/search` gives it. */
export interface LocalSearchResult {
  readonly id: string;
  readonly title: string;
  readonly titleHighlighted: string;
  readonly snippet: string;
  /** The heading of the note's best chunk (meaning only); a hit opens the note there. */
  readonly heading: string | null;
  readonly tags: string[];
  readonly kind: string;
  readonly updatedAt: number;
  /** How the note was found: by its words, by meaning, or both. */
  readonly sources: Array<'full-text' | 'semantic'>;
}

export interface LocalSearchAnswer {
  readonly mode: 'full-text' | 'hybrid' | 'semantic';
  readonly results: LocalSearchResult[];
  /** With meaning: how many of the notes have vectors (A1156). */
  readonly coverage?: MeaningCoverage;
  readonly notice?: string;
}

/** What hybrid says without meaning (A843), and what meaning says while it is indexing. */
export const WORDS_ONLY_NOTICE = 'A git notebook searches words only: these are keyword results.';
export const coverageNotice = ({ indexed, total }: MeaningCoverage) =>
  `Meaning covers ${indexed} of ${total} notes so far.`;

/** A note id as the REST API takes one (the server's NOTE_ID). */
const NOTE_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** What one read gives an agent at once (A150), as the server's READ_PART_BYTES. */
export const READ_PART_BYTES = 60_000;
/** Markdown in one edit (the server's MAX_MARKDOWN_BYTES). */
export const MAX_MARKDOWN_BYTES = 256 * 1024;
/** A create replayed with the same derived key within this returns its note (as the server). */
export const CREATE_RETRY_WINDOW_MS = 10 * 60_000;
const EXCERPT_LENGTH = 200;
/** The most threads one list across the notebook returns (the server's MAX_LISTED_THREADS). */
export const MAX_LISTED_THREADS = 200;
const MAX_LISTED = 200;
/** How many earlier states of a note a process keeps as bases for edits (A121). */
const MAX_BASES = 8;

/** The settings a git notebook keeps (A827): its time zone and templates. */
export const NOTEBOOK_SETTING_KEYS = ['timeZone', 'template.daily', 'template.weekly'] as const;
const TEMPLATE_MAX_CHARS = 10_000;

const encoder = new TextEncoder();
const utf8 = (text: string) => encoder.encode(text).byteLength;

/** At most `maxBytes` of `text` from `offset`, ending at a line break when one is near (A150). */
export function readPart(
  text: string,
  offset: number,
  maxBytes = READ_PART_BYTES,
): { text: string; nextOffset: number | null } {
  const window = text.slice(offset, offset + maxBytes);
  const { read } = encoder.encodeInto(window, new Uint8Array(maxBytes));
  if (offset + read >= text.length) return { text: window.slice(0, read), nextOffset: null };
  const lineEnd = window.lastIndexOf('\n', read - 1);
  const end = lineEnd >= read / 2 ? lineEnd + 1 : read;
  return { text: window.slice(0, end), nextOffset: offset + end };
}

/** Exact title match, ignoring the case of A–Z only (SQLite NOCASE, A175). */
const nocase = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

export class LocalNotebook {
  private readonly cache = new Map<string, NoteInfo>();
  private readonly index = new LocalSearchIndex();
  private readonly indexed = new Map<string, number>();
  /** Earlier states of notes this process read: the bases edits are checked against (A121). */
  private readonly bases = new Map<string, Map<number, Uint8Array>>();
  /** Idempotency keys of creates this process made (A135): key → note id, when. */
  private readonly creates = new Map<string, { id: string; at: number; ttl: number | null }>();

  private historyReader: NotebookHistory | null = null;
  private meaning: LocalMeaning | null = null;
  private activityReader: AgentActivity | null = null;

  constructor(
    readonly ops: NotebookOps,
    private readonly clock: () => number = Date.now,
    /**
     * Commits what this writer has now (G6's `save_version`): a sync, through the caller's checks
     * (the repository must be private, A841). Absent: a version is saved by the next sync.
     */
    private readonly commitNow?: () => Promise<void>,
    /**
     * Who this notebook is served to (#174 review): the apps (the person, by default), or the
     * CLI and `penmoss mcp`, which are agents' sides whatever the clone's writer is. Agent
     * activity is a person's: the CLI and MCP never read or undo it.
     */
    private readonly served: { readonly side?: 'app' | 'cli' | 'mcp' } = {},
  ) {}

  get engine(): GitNotebookEngine {
    return this.ops.engine;
  }

  private get workspace(): Y.Doc {
    return this.ops.workspace;
  }

  // --- what the notes are ---

  private info(id: string, folderId: string | null): NoteInfo | null {
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
      text: rendered.text,
      headings: rendered.headings,
      sections: noteSections(state.body.toJSON() as DocJson),
      deleted: isDeleted(doc),
      links: extractLinks(state.body.toJSON() as DocJson),
    };
    this.cache.set(id, info);
    return info;
  }

  /**
   * What the notes API knows of one note held here, registered or not (an app's own copy, made
   * before it is filed): its title, text, tags, links and when it changed. Null for a note this
   * device does not hold, or one deleted for good. The Android app's local notes server reads
   * its index rows from this (A874).
   */
  describe(
    id: string,
    /** Where the registry files it, when the caller read the registry already. */
    folderId?: string | null,
  ): Readonly<NoteInfo> | null {
    if (isPurged(this.workspace, id)) return null;
    const filed =
      folderId !== undefined
        ? folderId
        : (readWorkspace(this.workspace).notes.find((note) => note.id === id)?.folderId ?? null);
    return this.info(id, filed);
  }

  /** Every note of the notebook (registered and not purged), in Trash or not. */
  private all(): NoteInfo[] {
    const out: NoteInfo[] = [];
    for (const entry of readWorkspace(this.workspace).notes) {
      if (isPurged(this.workspace, entry.id)) continue;
      const info = this.info(entry.id, entry.folderId);
      if (info) out.push(info);
    }
    return out;
  }

  private live(): NoteInfo[] {
    return this.all().filter((note) => !note.deleted);
  }

  private require(id: string): { doc: Y.Doc; info: NoteInfo } {
    if (!NOTE_ID.test(id)) throw new LocalError(400, 'invalid_request', 'Invalid note id');
    const entry = readWorkspace(this.workspace).notes.find((note) => note.id === id);
    const info = entry && !isPurged(this.workspace, id) ? this.info(id, entry.folderId) : null;
    if (!info) throw new LocalError(404, 'not_found', 'No such note');
    return { doc: this.ops.note(id)!, info };
  }

  private writable(id: string): { doc: Y.Doc; info: NoteInfo } {
    const found = this.require(id);
    if (found.info.deleted) {
      throw new LocalError(409, 'in_trash', 'The note is in Trash; restore it before editing');
    }
    return found;
  }

  /**
   * Links resolved within this notebook, as the server resolves an agent's (A10): a target names
   * a note the body already links by that title, else the most recently edited live note with
   * that title (ignoring case), else a note id.
   */
  private resolver(body: Y.Doc | null): LinkResolver {
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
  private remember(id: string, doc: Y.Doc): number {
    const rev = this.engine.replica.rev(id);
    let kept = this.bases.get(id);
    if (!kept) this.bases.set(id, (kept = new Map<number, Uint8Array>()));
    if (!kept.has(rev)) {
      kept.set(rev, Y.encodeStateAsUpdate(doc));
      while (kept.size > MAX_BASES) kept.delete(kept.keys().next().value!);
    }
    return rev;
  }

  // --- notes ---

  /** `GET /api/notes`: the most recently edited, or the notes with exactly a title. */
  listNotes(input: { readonly title?: string; readonly limit?: number }) {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 5_000);
    let notes = this.live();
    if (input.title !== undefined) {
      const wanted = nocase(input.title.trim());
      notes = notes.filter((note) => nocase(note.title) === wanted);
    }
    notes.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
    return {
      notes: notes.slice(0, limit).map((note) => ({
        id: note.id,
        title: note.title,
        kind: note.kind,
        period: note.period,
        excerpt: note.text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_LENGTH),
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        seq: note.rev,
        tags: note.tags,
      })),
    };
  }

  /** `GET /api/notes/:id/content` (A121). */
  content(id: string): LocalNoteContent {
    const { doc, info } = this.require(id);
    const state = readNoteState(doc);
    const links = this.resolver(doc);
    return {
      id,
      title: state.title,
      tags: info.tags,
      // `updated` as the note's file and the server write it (A1024): its last change, not the
      // list's time, which is never before `created` (a day's note made ahead of its day).
      markdown: renderNote(
        state,
        id,
        Math.max(changedAtOf(doc), this.engine.replica.state.dirty[id] ?? 0),
        { links },
      ).markdown,
      body: bodyText(state.body, links),
      headings: headingRefs(state.body),
      baseVersion: this.remember(id, doc),
      deleted: info.deleted,
    };
  }

  /** read_note's view (A150): the body or one section, at most `maxBytes` from `offset`. */
  view(
    id: string,
    options: { readonly heading?: string; readonly offset?: number; readonly maxBytes?: number },
  ) {
    const { doc, info } = this.require(id);
    const state = readNoteState(doc);
    const links = this.resolver(doc);
    let text = bodyText(state.body, links);
    let heading: string | undefined;
    if (options.heading !== undefined) {
      const lookup = findSection(state.body, options.heading);
      if (!lookup.ok) {
        const headings =
          lookup.reason === 'ambiguous'
            ? lookup.matches.map((m) => `${'#'.repeat(m.level)} ${m.text}`)
            : headingRefs(state.body);
        throw new LocalError(
          422,
          lookup.reason === 'ambiguous' ? 'heading_ambiguous' : 'heading_not_found',
          lookup.reason === 'ambiguous'
            ? `More than one heading reads “${options.heading}”; add its level`
            : `No heading reads “${options.heading}”`,
          { headings },
        );
      }
      const { section } = lookup;
      const blocks = [];
      for (let i = section.heading; i < section.end; i++) blocks.push(state.body.child(i));
      text = bodyText(state.body.type.create(state.body.attrs, blocks), links);
      heading = `${'#'.repeat(section.level)} ${section.text}`;
    }
    const offset = options.offset ?? 0;
    if (offset > text.length) {
      throw new LocalError(
        422,
        'offset_past_end',
        `offset ${offset} is past the end of the text (${text.length} characters)`,
        { length: text.length },
      );
    }
    const part = readPart(text, offset, options.maxBytes ?? READ_PART_BYTES);
    return {
      id,
      title: state.title,
      tags: info.tags,
      headings: headingRefs(state.body),
      baseVersion: this.remember(id, doc),
      deleted: info.deleted,
      ...(heading === undefined ? {} : { heading }),
      text: part.text,
      offset,
      length: text.length,
      nextOffset: part.nextOffset,
    };
  }

  /**
   * `POST /api/notes` (T24): title, markdown (with optional frontmatter), tags and a folder.
   * The same key within its window answers the note it made (A135): status 200, changed false.
   */
  create(
    input: {
      readonly title?: string | undefined;
      readonly markdown?: string | undefined;
      readonly tags?: readonly string[] | undefined;
      readonly folderId?: string | null | undefined;
    },
    key: string | null = null,
    ttlMs: number | null = null,
  ): { status: 200 | 201; reply: LocalEditReply } {
    const now = this.clock();
    if (key) {
      const earlier = this.creates.get(key);
      if (earlier && (earlier.ttl === null || now - earlier.at <= earlier.ttl)) {
        const doc = this.ops.note(earlier.id);
        if (doc) {
          return {
            status: 200,
            reply: {
              id: earlier.id,
              changed: false,
              baseVersion: this.remember(earlier.id, doc),
              version: null,
            },
          };
        }
      }
    }
    const markdown = input.markdown ?? '';
    if (utf8(markdown) > MAX_MARKDOWN_BYTES) {
      throw new LocalError(413, 'too_large', 'markdown is over 256 KB');
    }
    const folderId = input.folderId ?? null;
    if (folderId !== null && !this.folder(folderId)) {
      throw new LocalError(422, 'folder_not_found', 'No such folder');
    }
    const plan = planCreate(
      { title: input.title, markdown, tags: input.tags ?? [] },
      this.resolver(null),
    );
    if (!plan.ok) return fail(plan);
    const id = this.op(() => this.ops.createNote({ title: plan.title, folderId }));
    const doc = this.ops.note(id)!;
    doc.transact(() => {
      if (plan.body) setBody(doc, bodyDelta(plan.body));
      for (const tag of plan.tags) setFrontmatterTag(doc, tag, true);
    });
    if (key) this.creates.set(key, { id, at: now, ttl: ttlMs });
    return {
      status: 201,
      reply: {
        id,
        changed: true,
        baseVersion: this.remember(id, doc),
        summary: `Created · ${summarise('', versionMarkdown(doc))}`,
        version: null,
      },
    };
  }

  /**
   * An edit (T24, A121): checked against `baseVersion` when one is given (the part it changes
   * must be as it was then), planned on the note as it is now, and applied in one change.
   */
  edit(id: string, op: EditOp, baseVersion: number | null): LocalEditReply {
    const markdown = incomingMarkdown(op);
    if (utf8(markdown) > MAX_MARKDOWN_BYTES) {
      throw new LocalError(413, 'too_large', 'markdown is over 256 KB');
    }
    const inTrashOk = op.op === 'rename-tag';
    const { doc } = inTrashOk ? this.require(id) : this.writable(id);
    const links = this.resolver(doc);
    if (baseVersion !== null) {
      const current = this.engine.replica.rev(id);
      if (baseVersion !== current) {
        const kept = this.bases.get(id)?.get(baseVersion);
        if (!kept) {
          throw new LocalError(
            409,
            'base_unknown',
            `Version ${baseVersion} is not in this note's history; read the note again`,
          );
        }
        const base = new Y.Doc();
        try {
          Y.applyUpdate(base, kept);
          const conflict = baseConflict(base, doc, op, links);
          if (conflict) fail(conflict);
        } finally {
          base.destroy();
        }
      }
    }
    const plan = planEdit(doc, op, links);
    if (!plan.ok) return fail(plan);
    const before = versionMarkdown(doc);
    const rev = this.engine.replica.rev(id);
    doc.transact(() => applyPlan(doc, plan));
    const changed = this.engine.replica.rev(id) !== rev;
    return {
      id,
      changed,
      baseVersion: this.remember(id, doc),
      ...(changed ? { summary: `${plan.label} · ${summarise(before, versionMarkdown(doc))}` } : {}),
      version: null,
    };
  }

  /** `POST /api/notes/:id/move`. */
  move(id: string, folderId: string | null): { id: string; folderId: string | null } {
    this.require(id);
    if (folderId !== null && !this.folder(folderId)) {
      throw new LocalError(422, 'folder_not_found', 'No such folder');
    }
    const entry = readWorkspace(this.workspace).notes.find((note) => note.id === id)!;
    if (entry.folderId !== folderId) this.op(() => this.ops.move(id, folderId));
    return { id, folderId };
  }

  /** `POST /api/notes/:id/trash` (T42, A566). */
  trash(id: string) {
    this.require(id);
    const result = this.op(() => this.ops.trash(id));
    return {
      id,
      inTrash: true as const,
      alreadyInTrash: result.alreadyInTrash,
      deletedAt: new Date(result.deletedAt).toISOString(),
      folderId: result.folderId,
    };
  }

  /** `POST /api/notes/:id/restore`. */
  restore(id: string) {
    this.require(id);
    const result = this.op(() => this.ops.restore(id));
    return { id, restored: result.restored, folderId: result.folderId };
  }

  /** `POST /api/daily` (A76, A820, A827): the notebook's own daily or weekly note. */
  daily(input: {
    readonly period?: PeriodKind;
    readonly date?: string;
    readonly create?: boolean;
  }) {
    const kind = input.period ?? 'daily';
    if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      throw new LocalError(400, 'invalid_request', 'date must be YYYY-MM-DD');
    }
    const day = this.op(() =>
      this.ops.daily({ kind, date: input.date ?? null, create: input.create ?? true }),
    );
    if (!day.exists)
      throw new LocalError(404, 'not_found', `No ${kind} note for ${day.period} yet`);
    return {
      ...this.content(day.id),
      kind,
      ...(kind === 'daily' ? { date: day.period } : { week: day.period }),
      timeZone: day.timeZone,
      created: day.created,
      ...(day.restoredFromTrash ? { restoredFromTrash: true } : {}),
    };
  }

  // --- search, tags and links ---

  private refreshIndex(): void {
    const live = new Map(this.live().map((note) => [note.id, note]));
    for (const id of [...this.indexed.keys()]) {
      if (!live.has(id)) {
        this.index.remove(id);
        this.indexed.delete(id);
      }
    }
    for (const note of live.values()) {
      if (this.indexed.get(note.id) === note.rev) continue;
      if (this.indexed.has(note.id)) this.index.remove(note.id);
      const doc: LocalSearchDocument = {
        id: note.id,
        title: note.title,
        body: note.text,
        tags: note.tags,
        headings: note.headings,
        updatedAt: note.updatedAt,
      };
      this.index.add(doc);
      this.indexed.set(note.id, note.rev);
    }
  }

  /** Gives search meaning (A1156), or takes it away (null: words only, as before). */
  useMeaning(meaning: LocalMeaning | null): void {
    this.meaning = meaning;
  }

  /** The live notes as meaning reads them (A1154): title and body sections, by revision. */
  meaningNotes(): MeaningNote[] {
    return this.live().map((note) => ({
      id: note.id,
      version: note.rev,
      title: note.title,
      sections: note.sections,
    }));
  }

  /**
   * `GET /api/search` (A101, A1156). Without meaning: words only; hybrid, the default, falls back
   * to them and says so, and semantic is refused. With meaning: semantic answers by meaning, and
   * hybrid fuses the words' top 50 with meaning's (A1155), each saying how far indexing has got.
   */
  async search(input: {
    readonly q: string;
    readonly mode?: string;
    readonly limit?: number;
    readonly tag?: string | null;
    readonly folderId?: string | null;
    readonly after?: number | null;
    readonly before?: number | null;
  }): Promise<LocalSearchAnswer> {
    const mode = input.mode ?? 'hybrid';
    const meaning = this.meaning;
    if (mode === 'semantic' && !meaning) {
      throw new LocalError(
        422,
        'semantic_unavailable',
        'Search by meaning is not set up here (on a Mac: Settings → Search by Meaning in the app, or penmoss models fetch): search with mode full-text or hybrid',
      );
    }
    if (mode !== 'hybrid' && mode !== 'full-text' && mode !== 'semantic') {
      throw new LocalError(400, 'invalid_request', 'mode must be hybrid, full-text or semantic');
    }
    const query = input.q.trim();
    if (!query) throw new LocalError(400, 'invalid_request', 'q must not be empty');
    this.refreshIndex();
    let inFolder: Set<string> | null = null;
    if (input.folderId) {
      if (!this.folder(input.folderId))
        throw new LocalError(422, 'folder_not_found', 'No such folder');
      const folders = folderSubtree(this.folders(), input.folderId);
      inFolder = new Set(
        this.live()
          .filter((note) => note.folderId !== null && folders.has(note.folderId))
          .map((note) => note.id),
      );
    }
    const tag = input.tag ?? null;
    const accepts = (id: string, tags: readonly string[], updatedAt: number) =>
      (!inFolder || inFolder.has(id)) &&
      (!tag || tags.some((each) => tagMatches(each, tag))) &&
      (input.after == null || updatedAt > input.after) &&
      (input.before == null || updatedAt < input.before);
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const words = (depth: number) =>
      mode === 'semantic'
        ? []
        : this.index.search(parseQuery(query), {
            limit: depth,
            filter: (doc) => accepts(doc.id, doc.tags, doc.updatedAt),
          });
    const wordResult = (hit: ReturnType<typeof words>[number]): LocalSearchResult => ({
      id: hit.id,
      title: hit.title,
      titleHighlighted: hit.titleHighlighted,
      snippet: hit.snippet,
      heading: null,
      tags: [...hit.tags],
      kind: this.cache.get(hit.id)?.kind ?? 'note',
      updatedAt: hit.updatedAt,
      sources: ['full-text'],
    });
    if (mode === 'full-text' || !meaning) {
      return {
        mode: 'full-text',
        results: words(limit).map(wordResult),
        ...(mode === 'hybrid' ? { notice: WORDS_ONLY_NOTICE } : {}),
      };
    }

    const budgetMs = meaning.budgetMs ?? 0;
    const coverage = await meaning.index.update(this.meaningNotes(), {
      budgetMs,
      embed: budgetMs > 0,
    });
    // A claim that fails costs a re-embedding later, never this search.
    await meaning.claim?.(meaning.index.usedKeys()).catch(() => undefined);
    const found = await meaning.index.search(query, {
      limit: HYBRID_DEPTH,
      filter: (id) => {
        const note = this.cache.get(id);
        return note !== undefined && accepts(id, note.tags, note.updatedAt);
      },
    });
    const meaningResult = (hit: MeaningHit): LocalSearchResult | null => {
      const note = this.cache.get(hit.id);
      if (!note) return null;
      return {
        id: note.id,
        title: note.title,
        titleHighlighted: note.title,
        snippet: hit.preview,
        heading: hit.heading,
        tags: [...note.tags],
        kind: note.kind,
        updatedAt: note.updatedAt,
        sources: ['semantic'],
      };
    };
    const results: LocalSearchResult[] = [];
    if (mode === 'semantic') {
      for (const hit of found) {
        const result = meaningResult(hit);
        if (result) results.push(result);
        if (results.length === limit) break;
      }
    } else {
      for (const fused of fuseHybrid(words(HYBRID_DEPTH), found, meaning.index.embedder.floor)) {
        const result = fused.text
          ? {
              ...wordResult(fused.text),
              heading: fused.meaning?.heading ?? null,
              sources: fused.meaning
                ? (['full-text', 'semantic'] as const)
                : (['full-text'] as const),
            }
          : meaningResult(fused.meaning!);
        if (result) results.push({ ...result, sources: [...result.sources] });
        if (results.length === limit) break;
      }
    }
    return {
      mode,
      results,
      coverage,
      ...(coverage.indexed < coverage.total ? { notice: coverageNotice(coverage) } : {}),
    };
  }

  /**
   * `GET /api/tags`: every tag with its note count (nested tags counted under their own), and
   * its description when it has one (PEN-68).
   */
  tags(): { tags: Array<{ name: string; notes: number; description?: string }> } {
    const counts = new Map<string, number>();
    for (const note of this.live())
      for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const descriptions = readTagDescriptions(this.workspace);
    return {
      tags: [...counts]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, notes]) => {
          const description = descriptions[name]?.trim();
          return { name, notes, ...(description ? { description } : {}) };
        }),
    };
  }

  /**
   * `describe_tags` (PEN-68): each tag with what it means, its note count (with nested tags) and
   * its parents' descriptions; every tag, or `wanted` and the tags nested under each.
   */
  describeTags(wanted?: readonly string[]): { tags: DescribedTag[] } {
    let names: string[] | undefined;
    if (wanted !== undefined) {
      names = [];
      for (const raw of wanted) {
        const name = normaliseTag(raw);
        if (!name) throw new LocalError(400, 'invalid_request', `Not a valid tag: ${raw}`);
        names.push(name);
      }
    }
    return {
      tags: describeTags(
        this.live().map((note) => note.tags),
        readTagDescriptions(this.workspace),
        names,
      ),
    };
  }

  /** `GET /api/tags?tag=`: the notes with a tag or one nested under it, newest first. */
  tagged(tag: string, limit = MAX_LISTED) {
    const name = normaliseTag(tag);
    if (!name) throw new LocalError(400, 'invalid_request', 'Not a valid tag');
    const notes = this.live()
      .filter((note) => note.tags.some((each) => tagMatches(each, name)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      tag: name,
      notes: notes
        .slice(0, limit)
        .map((note) => ({ id: note.id, title: note.title, updatedAt: note.updatedAt })),
      ...(notes.length > limit ? { truncated: true } : {}),
    };
  }

  /** `POST /api/tags/rename` (A125): at once here, in every note that has it (Trash too). */
  renameTag(input: { readonly from: string; readonly to: string; readonly merge?: boolean }) {
    const from = normaliseTag(input.from);
    const to = normaliseTag(input.to);
    if (!from || !to) throw new LocalError(400, 'invalid_request', 'Not a valid tag');
    if (from === to) throw new LocalError(400, 'invalid_request', 'The tag already has that name');
    const all = this.all();
    const has = (name: string) =>
      all.some((note) => note.tags.some((tag) => tagMatches(tag, name)));
    if (has(to) && !input.merge) {
      throw new LocalError(409, 'tag_exists', `#${to} exists already; pass merge to merge the two`);
    }
    const notes = all
      .filter((note) => note.tags.some((tag) => tagMatches(tag, from)))
      .map((n) => n.id);
    for (const id of notes) this.edit(id, { op: 'rename-tag', from, to }, null);
    return { from, to, notes };
  }

  /** `get_backlinks`: the notes linking to a note, and those naming its title without a link. */
  backlinks(id: string) {
    const { info: target } = this.require(id);
    const linked = new Map<
      string,
      {
        id: string;
        title: string;
        updatedAt: number;
        heading: string | null;
        embed: boolean;
        count: number;
      }
    >();
    for (const note of this.live()) {
      if (note.id === id) continue;
      for (const link of note.links) {
        if (link.noteId !== id) continue;
        const key = `${note.id}\u0000${link.heading ?? ''}\u0000${link.embed}`;
        const row = linked.get(key);
        if (row) row.count++;
        else
          linked.set(key, {
            id: note.id,
            title: note.title,
            updatedAt: note.updatedAt,
            heading: link.heading,
            embed: link.embed,
            count: 1,
          });
      }
    }
    const linkers = new Set([...linked.values()].map((row) => row.id));
    let unlinked: Array<{ id: string; title: string; updatedAt: number; snippet: string }> = [];
    const words = target.title.replace(/["*]/g, ' ').trim();
    if (words) {
      this.refreshIndex();
      unlinked = this.index
        .search(parseQuery(`"${words}"`), {
          limit: 20,
          filter: (doc) => doc.id !== id && !linkers.has(doc.id),
        })
        .map((hit) => ({
          id: hit.id,
          title: hit.title,
          updatedAt: hit.updatedAt,
          snippet: hit.snippet,
        }));
    }
    return {
      title: target.title,
      linked: [...linked.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      unlinked,
    };
  }

  // --- folders ---

  private folders(): FolderRecord[] {
    return readWorkspace(this.workspace).folders;
  }

  private folder(id: string): FolderRecord | undefined {
    return this.folders().find((folder) => folder.id === id);
  }

  private folderReply(folder: FolderRecord) {
    return {
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      sortMode: folder.sortMode,
    };
  }

  /** `GET /api/folders`: a folder's subfolders and notes in app order (by id or path). */
  listFolder(input: { readonly folderId?: string; readonly path?: string }, limit = MAX_LISTED) {
    const folders = this.folders();
    let folder: FolderRecord | null = null;
    if (input.folderId !== undefined) {
      folder = this.folder(input.folderId) ?? null;
      if (!folder) throw new LocalError(404, 'folder_not_found', 'No such folder');
    } else if (input.path !== undefined && input.path.trim() && input.path.trim() !== '/') {
      const wanted = input.path
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .toLowerCase();
      folder =
        folders.find((each) => (folderPath(folders, each.id) ?? '').toLowerCase() === wanted) ??
        null;
      if (!folder)
        throw new LocalError(404, 'folder_not_found', `No folder “${input.path.trim()}”`);
    }
    const parentId = folder?.id ?? null;
    const sortMode: SortMode = folder
      ? folder.sortMode
      : readWorkspace(this.workspace).rootSortMode;
    const children = folders.filter((each) => each.parentId === parentId);
    const notes = this.live().filter((note) => note.folderId === parentId);
    const positions = new Map(
      readWorkspace(this.workspace).notes.map((note) => [note.id, note.position]),
    );
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    children.sort(
      sortMode === 'alpha'
        ? byName
        : (a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0),
    );
    notes.sort(
      sortMode === 'alpha'
        ? (a, b) => a.title.localeCompare(b.title)
        : sortMode === 'modified'
          ? (a, b) => b.updatedAt - a.updatedAt
          : (a, b) => ((positions.get(a.id) ?? '') < (positions.get(b.id) ?? '') ? -1 : 1),
    );
    const shown = limit > 0 ? notes.slice(0, limit) : [];
    return {
      folder: folder
        ? { id: folder.id, name: folder.name, path: folderPath(folders, folder.id) ?? folder.name }
        : null,
      folders: children.map((each) => ({
        id: each.id,
        name: each.name,
        path: folderPath(folders, each.id) ?? each.name,
      })),
      notes: shown.map((note) => ({ id: note.id, title: note.title, updatedAt: note.updatedAt })),
      ...(notes.length > shown.length && limit > 0 ? { truncated: true } : {}),
    };
  }

  /** `POST /api/folders`: idempotent by id, and with `reuseName` by name under the parent. */
  createFolder(input: {
    readonly id: string;
    readonly name: string;
    readonly parentId: string | null;
    readonly reuseName?: boolean;
  }): { status: 200 | 201; folder: ReturnType<LocalNotebook['folderReply']> } {
    const name = input.name.trim();
    if (!name) throw new LocalError(400, 'invalid_request', 'name must not be blank');
    if (name.includes('/')) {
      throw new LocalError(
        400,
        'invalid_request',
        'A folder name cannot contain /: name one folder',
      );
    }
    if (!isUlid(input.id)) throw new LocalError(400, 'invalid_request', 'Invalid folder id');
    const existing = this.folder(input.id);
    if (existing) return { status: 200, folder: this.folderReply(existing) };
    if (input.parentId !== null && !this.folder(input.parentId)) {
      throw new LocalError(422, 'folder_not_found', 'No such folder');
    }
    if (input.reuseName) {
      const same = this.folders().find(
        (each) =>
          each.parentId === input.parentId && each.name.toLowerCase() === name.toLowerCase(),
      );
      if (same) return { status: 200, folder: this.folderReply(same) };
    }
    this.op(() => this.ops.createFolder({ id: input.id, name, parentId: input.parentId }));
    return { status: 201, folder: this.folderReply(this.folder(input.id)!) };
  }

  /** `PATCH /api/folders/:id`: rename, move, sort or reorder, with `expected…` preconditions. */
  patchFolder(
    id: string,
    patch: {
      readonly name?: string;
      readonly expectedName?: string;
      readonly parentId?: string | null;
      readonly changeParent?: boolean;
      readonly expectedParentId?: string | null;
      readonly expectParent?: boolean;
      readonly sortMode?: SortMode;
      readonly place?: { readonly before?: string; readonly after?: string };
    },
  ) {
    const folder = this.folder(id);
    if (!folder) throw new LocalError(404, 'folder_not_found', 'No such folder');
    if (patch.expectedName !== undefined && patch.expectedName !== folder.name) {
      throw new LocalError(409, 'folder_changed', `The folder is now named “${folder.name}”`, {
        name: folder.name,
      });
    }
    if (patch.expectParent && (patch.expectedParentId ?? null) !== folder.parentId) {
      throw new LocalError(409, 'folder_moved', 'The folder moved since', {
        parentId: folder.parentId,
      });
    }
    const name = patch.name?.trim();
    if (name !== undefined) {
      if (!name) throw new LocalError(400, 'invalid_request', 'name must not be blank');
      if (name.includes('/'))
        throw new LocalError(
          400,
          'invalid_request',
          'A folder name cannot contain /: name one folder',
        );
    }
    let parentId = folder.parentId;
    if (patch.changeParent) {
      parentId = patch.parentId ?? null;
      if (parentId !== null && !this.folder(parentId)) {
        throw new LocalError(422, 'folder_not_found', 'No such folder');
      }
      if (parentId !== null && folderSubtree(this.folders(), id).has(parentId)) {
        throw new LocalError(
          409,
          'folder_cycle',
          'A folder cannot move into itself or one of its subfolders',
        );
      }
    }
    let position: string | undefined;
    const sibling = patch.place?.before ?? patch.place?.after;
    if (sibling !== undefined) {
      const siblings = this.folders()
        .filter((each) => each.parentId === parentId && each.id !== id)
        .sort((a, b) => (a.position < b.position ? -1 : 1));
      const at = siblings.findIndex((each) => each.id === sibling);
      if (at < 0) throw new LocalError(422, 'folder_not_found', 'The sibling folder is not there');
      position =
        patch.place?.before !== undefined
          ? keyBetween(siblings[at - 1]?.position ?? null, siblings[at]!.position)
          : keyBetween(siblings[at]!.position, siblings[at + 1]?.position ?? null);
    }
    this.op(() => {
      if (name !== undefined && name !== folder.name) this.ops.renameFolder(id, name);
      if (patch.changeParent || position !== undefined) {
        if (patch.changeParent && position === undefined && parentId !== folder.parentId) {
          const last = this.folders()
            .filter((each) => each.parentId === parentId)
            .map((each) => each.position)
            .sort()
            .at(-1);
          position = keyBetween(last ?? null, null);
        }
        if (position !== undefined || parentId !== folder.parentId) {
          this.ops.moveFolder(id, parentId, position ?? folder.position);
        }
      }
      if (patch.sortMode !== undefined) setSortMode(this.workspace, id, patch.sortMode);
    });
    return this.folderReply(this.folder(id)!);
  }

  /** `PATCH /api/folders/root`: the top level's sort order. */
  patchRoot(sortMode: SortMode) {
    setSortMode(this.workspace, null, sortMode);
    return { sortMode: readWorkspace(this.workspace).rootSortMode };
  }

  /** `DELETE /api/folders/:id`: the folder and its subfolders to Trash; their notes move up. */
  deleteFolder(id: string) {
    if (!this.folder(id)) return { id, deleted: false, inTrash: false };
    this.op(() => this.ops.deleteFolder(id));
    return { id, deleted: true, inTrash: true };
  }

  // --- settings and attachments ---

  /** `GET /api/settings`: the notebook's own (A827). */
  settings(): { settings: Record<string, unknown> } {
    const all = this.ops.settings();
    return {
      settings: Object.fromEntries(
        NOTEBOOK_SETTING_KEYS.filter((key) => all[key] !== undefined).map((key) => [key, all[key]]),
      ),
    };
  }

  /** `PUT /api/settings` (A410): `{ set, base }`, refused when one changed since its base. */
  changeSettings(body: { readonly set?: unknown; readonly base?: unknown }) {
    const set = body.set;
    const base = body.base;
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    if (!isRecord(set) || !isRecord(base))
      throw new LocalError(400, 'invalid_request', 'Expected { set, base }');
    const keys = Object.keys(set);
    if (keys.length === 0) throw new LocalError(400, 'invalid_request', 'set names no setting');
    const now = this.ops.settings();
    for (const key of keys) {
      if (!(NOTEBOOK_SETTING_KEYS as readonly string[]).includes(key)) {
        throw new LocalError(
          403,
          'setting_not_allowed',
          `A git notebook keeps only ${NOTEBOOK_SETTING_KEYS.join(', ')}; ${key} is a setting of the apps`,
        );
      }
      if (!(key in base))
        throw new LocalError(400, 'invalid_request', `base must say what ${key} was`);
      const value = set[key];
      if (value === null) continue;
      if (
        key === 'timeZone' &&
        !(typeof value === 'string' && value.length <= 64 && isTimeZone(value))
      ) {
        throw new LocalError(
          400,
          'invalid_setting',
          'timeZone must be an IANA time zone, like America/Chicago',
          { key },
        );
      }
      if (
        key !== 'timeZone' &&
        !(typeof value === 'string' && value.length <= TEMPLATE_MAX_CHARS)
      ) {
        throw new LocalError(
          400,
          'invalid_setting',
          `${key} must be text of at most ${TEMPLATE_MAX_CHARS} characters`,
          { key },
        );
      }
    }
    const changedSince = keys.filter((key) => (now[key] ?? null) !== (base[key] ?? null));
    if (changedSince.length > 0) {
      throw new LocalError(
        409,
        'setting_changed',
        `Changed on another device since: ${changedSince.join(', ')}`,
        {
          keys: changedSince,
        },
      );
    }
    const writes = keys.filter((key) => (now[key] ?? null) !== (set[key] ?? null));
    for (const key of writes) this.ops.setSetting(key, set[key] === null ? undefined : set[key]);
    return { ...this.settings(), changed: writes.length > 0 };
  }

  /** `POST /api/notes/:id/attachments` (T42): stored for the next sync, which commits it (A828). */
  async attach(input: {
    readonly id: string;
    readonly name: string;
    readonly data: string;
    readonly alt?: string;
    readonly heading?: string;
  }) {
    const { doc } = this.writable(input.id);
    let bytes: Uint8Array;
    try {
      const binary = atob(input.data.replace(/\s+/g, ''));
      bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    } catch {
      throw new LocalError(400, 'invalid_request', 'data must be the file in base64');
    }
    if (bytes.length === 0) throw new LocalError(400, 'invalid_request', 'The file is empty');
    if (bytes.length > NOTEBOOK_ATTACHMENT_MAX_BYTES) {
      throw new LocalError(
        413,
        'file_too_large',
        `The file is ${Math.ceil(bytes.length / 1024)} KB; a git notebook keeps files of at most ${NOTEBOOK_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`,
      );
    }
    const contentType = sniffFileType(bytes.subarray(0, 64));
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
    const path = isImageType(contentType)
      ? attachmentPath(sha256, contentType)
      : filePath(sha256, contentType, input.name);
    const label = (input.alt ?? input.name).replace(/[[\]\n\r]/g, ' ').trim();
    const markdown = isImageType(contentType)
      ? `![${label}](${path})`
      : `[${label || path}](${path})`;
    const file = { id: input.id, sha256, path, contentType, bytes: bytes.length, markdown };
    if (versionMarkdown(doc).includes(`(${path})`)) {
      return { ...file, added: false, baseVersion: this.remember(input.id, doc) };
    }
    const op: EditOp = {
      op: 'append',
      markdown,
      ...(input.heading === undefined ? {} : { heading: input.heading }),
    };
    // The heading must be there before the file is kept.
    const dry = planEdit(doc, op, this.resolver(doc));
    if (!dry.ok) return fail(dry);
    const ext = path.slice(path.lastIndexOf('.') + 1);
    await this.op(() => this.ops.keepAttachment(bytes, ext));
    const reply = this.edit(input.id, op, null);
    return { ...file, added: true, baseVersion: reply.baseVersion };
  }

  // --- History (G6, A831, A858): versions are the commits that touched a note's logs ---

  private get history(): NotebookHistory {
    this.historyReader ??= new NotebookHistory(this.engine.transport, this.engine.layout);
    return this.historyReader;
  }

  private self() {
    const writer = this.engine.writer;
    const who = this.engine.who;
    return { id: writer?.id ?? 'this-device', kind: who.kind, label: who.label };
  }

  /** `GET /api/notes/:id/versions`: newest first, with what is not committed yet. */
  async versions(id: string, limit = 100): Promise<GitHistory> {
    this.require(id);
    return this.history.history(id, {
      limit,
      dirtySince: this.engine.replica.state.dirty[id] ?? null,
      self: this.self(),
    });
  }

  /** `GET /api/notes/:id/versions/:version`. */
  async versionDetail(id: string, version: number) {
    this.require(id);
    const detail = await this.history.detail(id, version);
    if (!detail) throw new LocalError(404, 'version_not_found', 'No such version');
    return detail;
  }

  /**
   * `POST /api/notes/:id/versions` (`save_version`): commits the note as it is now. With nothing
   * changed since the latest version, that one is the answer (`saved: false`).
   */
  async saveVersion(
    id: string,
  ): Promise<{ id: string; version: GitVersion | null; saved: boolean }> {
    this.require(id);
    const pending = this.engine.replica.state.dirty[id] !== undefined;
    if (pending && this.commitNow) await this.commitNow();
    const latest = (await this.history.history(id, { limit: 1 })).versions[0] ?? null;
    const saved = pending && this.engine.replica.state.dirty[id] === undefined;
    if (!latest && !pending) throw new LocalError(404, 'not_found', 'No such note');
    return { id, version: latest, saved };
  }

  /**
   * Before a restore or a revert, the note as it is now becomes a version, as the server saves
   * one first (note-doc's restore): what the restore replaces stays in history, so the restore
   * itself can be undone. An edit that cannot be committed (no sync here, or it did not land)
   * refuses the restore: nothing is replaced that history would not keep.
   */
  private async saveCurrentFirst(id: string): Promise<void> {
    if (this.engine.replica.state.dirty[id] === undefined) return;
    if (this.commitNow) await this.commitNow().catch(() => undefined);
    if (this.engine.replica.state.dirty[id] !== undefined) {
      throw new LocalError(
        409,
        'version_not_saved',
        'The note has changes not committed yet, and they could not be saved as a version first (sync, then try again). Nothing was changed.',
      );
    }
  }

  /** `POST /api/notes/:id/versions/:version/restore` (A80): its content back, as a new change. */
  async restoreVersion(id: string, version: number) {
    this.writable(id);
    await this.saveCurrentFirst(id);
    const { doc } = this.writable(id);
    const found = await this.history.commitOf(id, version);
    if (!found) throw new LocalError(404, 'version_not_found', 'No such version');
    const old = await this.history.docAt(id, found.commit.id);
    try {
      const changed = restoreContent(doc, old);
      if (changed) this.remember(id, doc);
      return { id, version: null, changed };
    } finally {
      old.destroy();
    }
  }

  /**
   * `POST /api/notes/:id/versions/:version/revert` (A81): undoes what that commit changed in the
   * note, keeping every later edit; overlaps are reported as conflicts and left as they are.
   */
  async revertVersion(id: string, version: number) {
    this.writable(id);
    await this.saveCurrentFirst(id);
    const { doc } = this.writable(id);
    const pair = await this.history.revertPair(id, version);
    if (!pair) throw new LocalError(404, 'version_not_found', 'No such version');
    try {
      const rev = this.engine.replica.rev(id);
      let conflicts: ReturnType<typeof revertChange>['conflicts'] = [];
      doc.transact(() => {
        conflicts = revertChange(doc, pair.before, pair.after).conflicts;
      });
      const changed = this.engine.replica.rev(id) !== rev;
      if (changed) this.remember(id, doc);
      return { id, version: null, changed, conflicts };
    } finally {
      pair.before.destroy();
      pair.after.destroy();
    }
  }

  // --- agent activity (#172, A920) ---

  /** For the people using the apps: an agent's writer cannot read or undo it (as the server). */
  private requirePerson(): void {
    if (this.engine.who.kind === 'agent' || (this.served.side ?? 'app') !== 'app') {
      throw new LocalError(
        403,
        'agent_not_allowed',
        'Agent activity is for the people using the apps; an agent cannot read or undo it',
      );
    }
  }

  private get activity(): AgentActivity {
    this.activityReader ??= new AgentActivity(this.engine.transport, this.engine.layout, (id) => {
      const doc = this.ops.note(id);
      return doc ? readNoteState(doc).title : null;
    });
    return this.activityReader;
  }

  /** `GET /api/agent-activity`: agents' folder, note-place and settings changes, newest first. */
  async agentActivity(): Promise<{ entries: ActivityEntry[] }> {
    this.requirePerson();
    return this.activity.list(this.workspace, this.clock());
  }

  /** `POST /api/agent-activity/:id/undo`: as a change by this device's writer, or 409. */
  async undoAgentActivity(id: number) {
    this.requirePerson();
    const result = await this.activity.undo(
      this.workspace,
      id,
      this.engine.who.label,
      this.clock(),
    );
    if (!result.ok) throw new LocalError(result.status, result.code, result.message);
    return { id, undone: true, alreadyUndone: result.alreadyUndone, notice: result.notice };
  }

  // --- comment threads (T60, A1064) ---

  /** This clone's writer id: the comments' author, and who "sent to me" means (A1064). */
  get writerId(): string | null {
    return this.engine.writer?.id ?? null;
  }

  /** Who this clone comments as: its writer, self-declared (A781 needs a server). */
  private commentAuthor(): CommentAuthor {
    const self = this.self();
    return { id: self.id, kind: self.kind, label: self.label };
  }

  /** One note's threads, in document order (A777): `GET /api/notes/:id/comments`. */
  noteThreads(id: string, status: StatusFilter = 'open') {
    const { doc, info } = this.require(id);
    return {
      noteId: id,
      title: info.title,
      deleted: info.deleted,
      status,
      threads: viewThreads(doc, status),
    };
  }

  /**
   * Threads across the notebook (A775), newest change first, scanning its notes (no hub keeps an
   * index here): by status, and with `sentToMe` only those sent to this clone's writer. Notes in
   * Trash keep their threads (A770) but are not listed with the rest.
   */
  allThreads(input: {
    readonly status?: StatusFilter;
    readonly sentToMe?: boolean;
    readonly noteId?: string;
    readonly limit?: number;
  }) {
    const status = input.status ?? 'open';
    const writer = this.writerId;
    const out: Array<{
      noteId: string;
      title: string;
      threadId: string;
      status: ThreadData['status'];
      quote: string;
      comments: number;
      updated: number;
      sentTo?: string;
      delivery?: string;
    }> = [];
    for (const note of this.live()) {
      if (input.noteId !== undefined && note.id !== input.noteId) continue;
      const doc = this.ops.note(note.id);
      if (!doc) continue;
      for (const thread of readThreads(doc)) {
        if (status !== 'all' && thread.status !== status) continue;
        if (input.sentToMe && (writer === null || thread.target?.writer !== writer)) continue;
        out.push({
          noteId: note.id,
          title: note.title,
          threadId: thread.id,
          status: thread.status,
          quote: thread.quote.slice(0, 200),
          comments: thread.comments.length,
          updated: threadUpdated(thread),
          ...(thread.target ? { sentTo: thread.target.label } : {}),
          ...(thread.delivery ? { delivery: thread.delivery.state } : {}),
        });
      }
    }
    out.sort((a, b) => b.updated - a.updated || a.threadId.localeCompare(b.threadId));
    return {
      status,
      threads: out.slice(0, Math.min(input.limit ?? MAX_LISTED_THREADS, MAX_LISTED_THREADS)),
    };
  }

  /**
   * One thread with every comment. Read by the writer it was sent to, Ryan's newest comment is
   * marked seen (A1061), so this may write: the caller saves and syncs as after an edit.
   */
  readCommentThread(id: string, threadId: string) {
    const { doc, info } = this.require(id);
    const thread = readThread(doc, threadId);
    if (!thread) throw new LocalError(404, 'thread_not_found', 'No such thread');
    const writer = this.writerId;
    const seen = writer ? seenDelivery(thread, writer, this.clock()) : null;
    if (seen) setThreadDelivery(doc, thread.id, seen);
    return { noteId: id, title: info.title, thread: viewThread(doc, thread.id)! };
  }

  /**
   * Changes a note's threads as this clone's writer (A775): checked and planned as the server
   * did (`planCommentChange`), written in one change. A reply in a thread sent to this writer
   * marks it replied (A1061).
   */
  changeComments(id: string, change: CommentChange) {
    const { doc, info } = this.require(id);
    const now = this.clock();
    const plan = planCommentChange(doc, this.commentAuthor(), change, now);
    if ('ok' in plan) throw new LocalError(plan.status, plan.code, plan.message, plan.details);
    const rev = this.engine.replica.rev(id);
    plan.write?.(doc);
    const changed = this.engine.replica.rev(id) !== rev;
    const writer = this.writerId;
    if (changed && change.op === 'reply' && writer) {
      const thread = readThread(doc, plan.threadId);
      const replied = thread ? repliedDelivery(thread, writer, now) : null;
      if (replied) setThreadDelivery(doc, plan.threadId, replied);
    }
    return {
      noteId: id,
      title: info.title,
      changed,
      thread: viewThread(doc, plan.threadId),
      ...(plan.commentId ? { commentId: plan.commentId } : {}),
      ...(plan.occurrences !== undefined ? { occurrences: plan.occurrences } : {}),
    };
  }

  /** Runs a NotebookOps change, its refusals as REST refusals. */
  private op<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof NotebookOpError)
        throw new LocalError(error.status, error.code, error.message);
      throw error;
    }
  }
}

/** Marks as the MCP tools give them: `**bold**` for U+0002 … U+0003 (A118). */
export const markdownMarks = (text: string): string =>
  text.replaceAll(MATCH_START, '**').replaceAll(MATCH_END, '**');

/** Title and tags as set_properties sets them (A16, A73). */
export function propertiesOp(input: { readonly title?: unknown; readonly tags?: unknown }): EditOp {
  const keys = Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined);
  const unknown = keys.filter((key) => !NOTE_PROPERTIES.includes(key));
  if (unknown.length > 0) fail(unknownProperties(unknown));
  return {
    op: 'properties',
    ...(typeof input.title === 'string' ? { title: input.title } : {}),
    ...(Array.isArray(input.tags) ? { tags: input.tags as string[] } : {}),
  };
}
