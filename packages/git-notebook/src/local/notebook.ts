/**
 * A git notebook's notes API, on this device (T50 G2, #150; A830): what the CLI, the local MCP
 * server, Android's local notes server and the relay run, in the shapes, codes and statuses they
 * read. Every answer comes from the local engine: the shared edit engine (`@penmoss/model/edit-engine`), the
 * offline search index (`@penmoss/model/local-index`), core's links for backlinks, and the
 * notebook's own settings and salted periodic notes. Nothing here reaches the network; the next
 * sync carries every change.
 *
 * `LocalNotebook` is the one facade. Notes, settings and attachments are here; search and
 * backlinks (`search.ts`), tags (`tags.ts`), folders (`folders.ts`), History and agent activity
 * (`versions.ts`) and comment threads (`comments.ts`) are its parts, over the notes it holds
 * (`catalog.ts`).
 *
 * Search is by words unless the caller gives meaning (an embedder, a cache and an index, A1156);
 * `baseVersion` is the note's local change counter, and a base this process never read is
 * `base_unknown`; agent limits and folder scopes do not exist here.
 */
import { templateSetting, TIME_ZONE_SETTING } from '@penmoss/core/settings';
import { MATCH_END, MATCH_START, type MeaningNote } from '@penmoss/core/search';
import {
  attachmentPath,
  filePath,
  isImageType,
  MAX_ATTACHMENT_BYTES,
  sniffFileType,
} from '@penmoss/core/attachments';
import { findSection } from '@penmoss/core/diff-apply';
import { summarise } from '@penmoss/core/diff';
import { matchNoteRef, notebookTag, noteRefNamer, parseNoteRef } from '@penmoss/core/note-ref';
import { isTimeZone, type PeriodKind } from '@penmoss/core/periodic';
import type { TagPromptNote } from '@penmoss/core/ai-description';
import type { DescribedTag } from '@penmoss/core/tags';
import type { SortMode } from '@penmoss/core/workspace';
import {
  applyPlan,
  baseConflict,
  bodyText,
  headingRefs,
  incomingMarkdown,
  SETTABLE_PROPERTIES,
  planCreate,
  planEdit,
  unknownProperties,
  unsupportedNotice,
  type EditOp,
} from '@penmoss/model/edit-engine';
import { bodyDelta, readNoteState, renderNote, versionMarkdown } from '@penmoss/model/markdown';
import type { CommentChange, StatusFilter } from '@penmoss/model/comment-delivery';
import { setBody } from '@penmoss/model/history';
import { setFrontmatterTag } from '@penmoss/model/tags';
import { readWorkspace } from '@penmoss/model/workspace';
import * as Y from '@y/y';
import type { ActivityEntry } from '../agent-activity';
import type { GitNotebookEngine } from '../engine';
import type { GitHistory, GitVersion } from '../history';
import type { NotebookOps } from '../ops';
import type { AgentSession } from '../sessions';
import { isPurged } from '../purge';
import { changedAtOf } from '../render';
import { LocalError, NoteCatalog, fail, type NoteInfo } from './catalog';
import { LocalComments } from './comments';
import { LocalFolders, type FolderPatch, type LocalFolder } from './folders';
import {
  LocalSearch,
  type LocalMeaning,
  type LocalSearchAnswer,
  type LocalSearchInput,
} from './search';
import { LocalTags } from './tags';
import { LocalVersions, type ServedTo } from './versions';
import { formatBytes } from '@penmoss/core/words';

export { LocalError, type NoteInfo } from './catalog';
export type { FolderPatch, LocalFolder } from './folders';
export {
  coverageNotice,
  type LocalMeaning,
  type LocalSearchAnswer,
  type LocalSearchInput,
} from './search';
export type { ServedTo } from './versions';

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
  /** The note's description, or null (A1656). */
  readonly description: string | null;
  readonly markdown: string;
  readonly body: string;
  readonly headings: string[];
  readonly baseVersion: number;
  readonly deleted: boolean;
  /**
   * Set when the note holds content from a newer Penmoss (A1493): `markdown` and `body` are
   * then only its text, and edits to its body are refused.
   */
  readonly notice?: string;
}

/** What one read gives an agent at once (A150). */
const READ_PART_BYTES = 60_000;
/** At most this many linked notes in read_note's `links` (A1656). */
const MAX_LINKED = 50;
/** Markdown in one edit. */
const MAX_MARKDOWN_BYTES = 256 * 1024;
/** A create replayed with the same derived key within this returns its note. */
export const CREATE_RETRY_WINDOW_MS = 10 * 60_000;
const EXCERPT_LENGTH = 200;

/** The settings a git notebook keeps (A827): its time zone and templates. */
const NOTEBOOK_SETTING_KEYS = [
  TIME_ZONE_SETTING,
  templateSetting('daily'),
  templateSetting('weekly'),
] as const;
const TEMPLATE_MAX_CHARS = 10_000;

const encoder = new TextEncoder();
const utf8 = (text: string) => encoder.encode(text).byteLength;

/** At most `maxBytes` of `text` from `offset`, ending at a line break when one is near (A150). */
function readPart(
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
  private readonly notes: NoteCatalog;
  private readonly searcher: LocalSearch;
  private readonly tagger: LocalTags;
  private readonly folderer: LocalFolders;
  private readonly versioner: LocalVersions;
  private readonly comments: LocalComments;
  /** Idempotency keys of creates this process made (A135): key → note id, when. */
  private readonly creates = new Map<string, { id: string; at: number; ttl: number | null }>();

  constructor(
    readonly ops: NotebookOps,
    private readonly clock: () => number = Date.now,
    /**
     * Commits what this writer has now (G6's `save_version`): a sync, through the caller's checks.
     * Absent: a version is saved by the next sync.
     */
    commitNow?: () => Promise<void>,
    /**
     * Who this notebook is served to (#174 review): the apps (the person, by default), or the
     * CLI and `penmoss mcp`, which are agents' sides whatever the clone's writer is. Agent
     * activity is a person's: the CLI and MCP never read or undo it.
     */
    served: ServedTo = {},
  ) {
    this.notes = new NoteCatalog(ops);
    this.searcher = new LocalSearch(this.notes);
    this.tagger = new LocalTags(this.notes, (id, op) => this.edit(id, op, null));
    this.folderer = new LocalFolders(this.notes);
    this.versioner = new LocalVersions(this.notes, clock, commitNow, served);
    this.comments = new LocalComments(this.notes, clock);
  }

  get engine(): GitNotebookEngine {
    return this.ops.engine;
  }

  private get workspace(): Y.Doc {
    return this.ops.workspace;
  }

  /**
   * Runs `edit` for an agent session (PEN-152), and records the notes it changed and whether it
   * changed the workspace, so the commit that carries them names the session.
   */
  async attributed<T>(session: AgentSession, edit: () => T | Promise<T>): Promise<T> {
    const replica = this.engine.replica;
    const before = { ...replica.state.dirty };
    const workspaceBefore = Y.encodeStateVector(replica.workspace);
    const out = await edit();
    const after = replica.state.dirty;
    const notes = Object.keys(after).filter((id) => after[id] !== before[id]);
    const workspaceAfter = Y.encodeStateVector(replica.workspace);
    const workspace =
      workspaceAfter.length !== workspaceBefore.length ||
      workspaceAfter.some((byte, i) => byte !== workspaceBefore[i]);
    if (notes.length > 0 || workspace) replica.recordSession(session, notes, workspace);
    return out;
  }

  // --- what the notes are ---

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
    return this.notes.info(id, filed);
  }

  /** The notebook's id (`notebook.json`), whose hash names it in short references (PEN-69). */
  get notebookId(): string | null {
    return this.engine.info?.id ?? null;
  }

  /**
   * The note a reference names (PEN-69): a note id as it is, or a short reference
   * (`K7QD-9HTF2CXA`) resolved among this notebook's notes. A short reference of another notebook
   * is refused (`other_notebook`, its 4 characters in `details.notebook`); one naming no note
   * here is `not_found`.
   */
  noteIdOf(ref: string): string {
    const parsed = parseNoteRef(ref);
    if (parsed.kind === 'id') return parsed.id;
    const own = this.notebookId;
    if (own === null || notebookTag(own) !== parsed.notebook) {
      throw new LocalError(
        404,
        'other_notebook',
        `${ref.trim()} is a note of another notebook (${parsed.notebook}), not of this one`,
        { notebook: parsed.notebook },
      );
    }
    const id = matchNoteRef(parsed.note, this.notes.heldIds());
    if (id === null) throw new LocalError(404, 'not_found', 'No such note');
    return id;
  }

  /** Whether this notebook holds the note (in Trash or not): how one server finds its notebook. */
  holdsNote(id: string): boolean {
    return this.notes.heldIds().includes(id);
  }

  /** Whether this notebook has the folder. */
  holdsFolder(id: string): boolean {
    return this.notes.folder(id) !== undefined;
  }

  /** Names this notebook's notes by their short references (PEN-69), for one list. */
  refNamer(): (id: string) => string {
    const own = this.notebookId;
    return own === null ? (id) => id : noteRefNamer(own, this.notes.heldIds());
  }

  // --- notes ---

  /** `GET /api/notes`: the most recently edited, or the notes with exactly a title. */
  listNotes(input: { readonly title?: string; readonly limit?: number }) {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 5_000);
    let notes = this.notes.live();
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
        description: note.description,
      })),
    };
  }

  /** `GET /api/notes/:id/content` (A121). */
  content(id: string): LocalNoteContent {
    const { doc, info } = this.notes.require(id);
    const state = readNoteState(doc);
    const links = this.notes.resolver(doc);
    return {
      id,
      title: state.title,
      tags: info.tags,
      description: info.description,
      // `updated` as the note's file has it (A1024): its last change, not the
      // list's time, which is never before `created` (a day's note made ahead of its day).
      markdown: renderNote(
        state,
        id,
        Math.max(changedAtOf(doc), this.engine.replica.state.dirty[id] ?? 0),
        { links },
      ).markdown,
      body: bodyText(state.body, links),
      headings: headingRefs(state.body),
      baseVersion: this.notes.remember(id, doc),
      deleted: info.deleted,
      // Only the text of a body this build cannot read, and said so (A1493).
      ...(state.unsupported ? { notice: unsupportedNotice(state.unsupported) } : {}),
    };
  }

  /**
   * The notes this one links to, each with its description when it has one (A1656): what an
   * agent reads to choose which link to follow. In the order they first appear, at most 50.
   */
  private linkedNotes(info: NoteInfo) {
    const wanted = [...new Set(info.links.map((link) => link.noteId))].filter(
      (each): each is string => typeof each === 'string' && each !== info.id,
    );
    if (wanted.length === 0) return [];
    const live = new Map(this.notes.live().map((note) => [note.id, note]));
    const linked: Array<{ id: string; title: string; description?: string }> = [];
    for (const noteId of wanted) {
      const note = live.get(noteId);
      if (!note) continue;
      linked.push({
        id: note.id,
        title: note.title,
        ...(note.description ? { description: note.description } : {}),
      });
      if (linked.length === MAX_LINKED) break;
    }
    return linked;
  }

  /** read_note's view (A150): the body or one section, at most `maxBytes` from `offset`. */
  view(
    id: string,
    options: { readonly heading?: string; readonly offset?: number; readonly maxBytes?: number },
  ) {
    const { doc, info } = this.notes.require(id);
    const state = readNoteState(doc);
    const links = this.notes.resolver(doc);
    let text = bodyText(state.body, links);
    let heading: string | undefined;
    if (options.heading !== undefined && state.unsupported) {
      // Its text has no sections to find; only its whole text can be read (A1493).
      throw new LocalError(
        409,
        'unsupported_content',
        'This note holds content from a newer Penmoss; update Penmoss to read it by section. Read it without a heading for its text.',
        { nodeTypes: state.unsupported },
      );
    }
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
      description: info.description,
      links: this.linkedNotes(info),
      headings: headingRefs(state.body),
      baseVersion: this.notes.remember(id, doc),
      deleted: info.deleted,
      ...(heading === undefined ? {} : { heading }),
      text: part.text,
      offset,
      length: text.length,
      nextOffset: part.nextOffset,
      ...(state.unsupported ? { notice: unsupportedNotice(state.unsupported) } : {}),
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
              baseVersion: this.notes.remember(earlier.id, doc),
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
    if (folderId !== null && !this.notes.folder(folderId)) {
      throw new LocalError(422, 'folder_not_found', 'No such folder');
    }
    const plan = planCreate(
      { title: input.title, markdown, tags: input.tags ?? [] },
      this.notes.resolver(null),
    );
    if (!plan.ok) return fail(plan);
    const id = this.notes.op(() => this.ops.createNote({ title: plan.title, folderId }));
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
        baseVersion: this.notes.remember(id, doc),
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
    const inTrashOk = op.op === 'rename-tag' || op.op === 'delete-tag';
    const { doc } = inTrashOk ? this.notes.require(id) : this.notes.writable(id);
    const links = this.notes.resolver(doc);
    if (baseVersion !== null) {
      const current = this.engine.replica.rev(id);
      if (baseVersion !== current) {
        const kept = this.notes.base(id, baseVersion);
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
      baseVersion: this.notes.remember(id, doc),
      ...(changed ? { summary: `${plan.label} · ${summarise(before, versionMarkdown(doc))}` } : {}),
      version: null,
    };
  }

  /** `POST /api/notes/:id/move`. */
  move(id: string, folderId: string | null): { id: string; folderId: string | null } {
    this.notes.require(id);
    if (folderId !== null && !this.notes.folder(folderId)) {
      throw new LocalError(422, 'folder_not_found', 'No such folder');
    }
    const entry = readWorkspace(this.workspace).notes.find((note) => note.id === id)!;
    if (entry.folderId !== folderId) this.notes.op(() => this.ops.move(id, folderId));
    return { id, folderId };
  }

  /** `POST /api/notes/:id/trash` (T42, A566). */
  trash(id: string) {
    this.notes.require(id);
    const result = this.notes.op(() => this.ops.trash(id));
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
    this.notes.require(id);
    const result = this.notes.op(() => this.ops.restore(id));
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
    const day = this.notes.op(() =>
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

  /** Gives search meaning (A1156), or takes it away (null: words only, as before). */
  useMeaning(meaning: LocalMeaning | null): void {
    this.searcher.useMeaning(meaning);
  }

  /** The live notes as meaning reads them (A1154): title and body sections, by revision. */
  meaningNotes(): MeaningNote[] {
    return this.searcher.meaningNotes();
  }

  /**
   * `GET /api/search` (A101, A1156). Without meaning: words only; hybrid, the default, falls back
   * to them and says so, and semantic is refused. With meaning: semantic answers by meaning, and
   * hybrid fuses the words' top 50 with meaning's (A1155), each saying how far indexing has got.
   */
  search(input: LocalSearchInput): Promise<LocalSearchAnswer> {
    return this.searcher.search(input);
  }

  /**
   * `GET /api/tags`: every tag with its note count (nested tags counted under their own), and
   * its description when it has one (PEN-68).
   */
  tags(): { tags: Array<{ name: string; notes: number; description?: string }> } {
    return this.tagger.tags();
  }

  /**
   * `describe_tags` (PEN-68): each tag with what it means, its note count (with nested tags) and
   * its parents' descriptions; every tag, or `wanted` and the tags nested under each.
   */
  describeTags(wanted?: readonly string[]): { tags: DescribedTag[] } {
    return this.tagger.describeTags(wanted);
  }

  /** Every live note as a tag's AI description reads it (A1677), newest first. */
  tagPromptNotes(): TagPromptNote[] {
    return this.tagger.promptNotes();
  }

  /** `GET /api/tags?tag=`: the notes with a tag or one nested under it, newest first. */
  tagged(tag: string, limit?: number) {
    return this.tagger.tagged(tag, limit);
  }

  /** `POST /api/tags/rename` (A125): at once here, in every note that has it (Trash too). */
  renameTag(input: { readonly from: string; readonly to: string; readonly merge?: boolean }) {
    return this.tagger.renameTag(input);
  }

  /**
   * Deletes a tag, and those nested under it, from every note that has it (Trash too, so a
   * restore never brings it back), at once here: a frontmatter tag goes, and an inline `#tag`
   * loses its `#` and keeps its word, so the sentence it was in still reads. The notes stay.
   */
  deleteTag(input: { readonly tag: string }) {
    return this.tagger.deleteTag(input);
  }

  /** `get_backlinks`: the notes linking to a note, and those naming its title without a link. */
  backlinks(id: string) {
    return this.searcher.backlinks(id);
  }

  // --- folders ---

  /** `GET /api/folders`: a folder's subfolders and notes in app order (by id or path). */
  listFolder(input: { readonly folderId?: string; readonly path?: string }, limit?: number) {
    return this.folderer.listFolder(input, limit);
  }

  /** `POST /api/folders`: idempotent by id, and with `reuseName` by name under the parent. */
  createFolder(input: {
    readonly id: string;
    readonly name: string;
    readonly parentId: string | null;
    readonly reuseName?: boolean;
  }): { status: 200 | 201; folder: LocalFolder } {
    return this.folderer.createFolder(input);
  }

  /** `PATCH /api/folders/:id`: rename, move, sort or reorder, with `expected…` preconditions. */
  patchFolder(id: string, patch: FolderPatch): LocalFolder {
    return this.folderer.patchFolder(id, patch);
  }

  /** `PATCH /api/folders/root`: the top level's sort order. */
  patchRoot(sortMode: SortMode) {
    return this.folderer.patchRoot(sortMode);
  }

  /** `DELETE /api/folders/:id`: the folder and its subfolders to Trash; their notes move up. */
  deleteFolder(id: string) {
    return this.folderer.deleteFolder(id);
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
    // A notebook that never set its time zone reports the default one (the sync tree, A827), so a
    // base naming that default is the unset value it saw, not a change made since (A1557).
    const unchanged = (key: string) =>
      (now[key] ?? null) === (base[key] ?? null) ||
      (key === 'timeZone' && now[key] === undefined && base[key] === this.ops.timeZone());
    const changedSince = keys.filter((key) => !unchanged(key));
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
    const { doc } = this.notes.writable(input.id);
    let bytes: Uint8Array;
    try {
      const binary = atob(input.data.replace(/\s+/g, ''));
      bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    } catch {
      throw new LocalError(400, 'invalid_request', 'data must be the file in base64');
    }
    if (bytes.length === 0) throw new LocalError(400, 'invalid_request', 'The file is empty');
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new LocalError(
        413,
        'file_too_large',
        `The file is ${formatBytes(bytes.length)}; a git notebook keeps files of at most ${formatBytes(MAX_ATTACHMENT_BYTES)}`,
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
      return { ...file, added: false, baseVersion: this.notes.remember(input.id, doc) };
    }
    const op: EditOp = {
      op: 'append',
      markdown,
      ...(input.heading === undefined ? {} : { heading: input.heading }),
    };
    // The heading must be there before the file is kept.
    const dry = planEdit(doc, op, this.notes.resolver(doc));
    if (!dry.ok) return fail(dry);
    const ext = path.slice(path.lastIndexOf('.') + 1);
    await this.notes.op(() => this.ops.keepAttachment(bytes, ext));
    const reply = this.edit(input.id, op, null);
    return { ...file, added: true, baseVersion: reply.baseVersion };
  }

  // --- History (G6, A831, A858): versions are the commits that touched a note's logs ---

  /** `GET /api/notes/:id/versions`: newest first, with what is not committed yet. */
  versions(id: string, limit?: number): Promise<GitHistory> {
    return this.versioner.versions(id, limit);
  }

  /** `GET /api/notes/:id/versions/:version`. */
  versionDetail(id: string, version: number) {
    return this.versioner.versionDetail(id, version);
  }

  /**
   * `POST /api/notes/:id/versions` (`save_version`): commits the note as it is now. With nothing
   * changed since the latest version, that one is the answer (`saved: false`).
   */
  saveVersion(id: string): Promise<{ id: string; version: GitVersion | null; saved: boolean }> {
    return this.versioner.saveVersion(id);
  }

  /** `POST /api/notes/:id/versions/:version/restore` (A80): its content back, as a new change. */
  restoreVersion(id: string, version: number) {
    return this.versioner.restoreVersion(id, version);
  }

  /**
   * `POST /api/notes/:id/versions/:version/revert` (A81): undoes what that commit changed in the
   * note, keeping every later edit; overlaps are reported as conflicts and left as they are.
   */
  revertVersion(id: string, version: number) {
    return this.versioner.revertVersion(id, version);
  }

  // --- agent activity (#172, A920) ---

  /** `GET /api/agent-activity`: agents' folder, note-place and settings changes, newest first. */
  agentActivity(): Promise<{ entries: ActivityEntry[] }> {
    return this.versioner.agentActivity();
  }

  /** `POST /api/agent-activity/:id/undo`: as a change by this device's writer, or 409. */
  undoAgentActivity(id: number) {
    return this.versioner.undoAgentActivity(id);
  }

  // --- comment threads (T60, A1064) ---

  /** This clone's writer id: the comments' author, and who "sent to me" means (A1064). */
  get writerId(): string | null {
    return this.comments.writerId;
  }

  /** One note's threads, in document order (A777): `GET /api/notes/:id/comments`. */
  noteThreads(id: string, status?: StatusFilter) {
    return this.comments.noteThreads(id, status);
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
    return this.comments.allThreads(input);
  }

  /**
   * One thread with every comment. Read by the writer it was sent to, Ryan's newest comment is
   * marked seen (A1061), so this may write: the caller saves and syncs as after an edit.
   */
  readCommentThread(id: string, threadId: string) {
    return this.comments.readCommentThread(id, threadId);
  }

  /**
   * Changes a note's threads as this clone's writer (A775): checked and planned as an agent's
   * (`planCommentChange`), written in one change. A reply in a thread sent to this writer marks
   * it replied (A1061).
   */
  changeComments(id: string, change: CommentChange) {
    return this.comments.changeComments(id, change);
  }
}

/** Marks as the MCP tools give them: `**bold**` for U+0002 … U+0003 (A118). */
export const markdownMarks = (text: string): string =>
  text.replaceAll(MATCH_START, '**').replaceAll(MATCH_END, '**');

/** Title, tags and description as set_properties sets them (A16, A73, A1656). */
export function propertiesOp(input: {
  readonly title?: unknown;
  readonly tags?: unknown;
  readonly description?: unknown;
}): EditOp {
  const keys = Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined);
  const unknown = keys.filter((key) => !SETTABLE_PROPERTIES.includes(key));
  if (unknown.length > 0) fail(unknownProperties(unknown));
  return {
    op: 'properties',
    ...(typeof input.title === 'string' ? { title: input.title } : {}),
    ...(Array.isArray(input.tags) ? { tags: input.tags as string[] } : {}),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
  };
}
