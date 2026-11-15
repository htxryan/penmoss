/**
 * The Time Machine (PEN-21): a git notebook as it was at any commit, and what changed
 * between two moments, all read from the clone's history. No server and no new storage.
 *
 * - **Commits**: every commit of the notebook, oldest first, each with its writer (A825).
 * - **A tree at a commit**: the folders (the merged `workspace/*.yjs`) and every note that had
 *   logs there, with its title then and whether it was live (not in Trash).
 * - **A note at a commit**: its markdown then, as History compares versions (A831).
 * - **Changes between two moments**: the notes created, edited, renamed, moved, deleted and
 *   restored between the last commit before `from` and the last before `to`, with the writers
 *   whose files changed, and a line diff per note on request.
 *
 * What is safe to cache is cached: git blobs never change, so a note's or the workspace's merged
 * state is kept by the blob ids of its files, and a commit's file list by its id. Scrubbing from
 * one commit to the next reads only the logs that changed between them.
 */
import { diffLines, splitLines, type DiffOp } from '@penmoss/core/diff';
import { buildTree, folderPath, type FolderRecord, type SortMode } from '@penmoss/core/workspace';
import { bodyMarkdown, versionMarkdown } from '@penmoss/editor/markdown';
import { isDeleted, readTitle } from '@penmoss/sync-client/note';
import { readWorkspace } from '@penmoss/sync-client/workspace';
import * as Y from '@y/y';
import { parseActor } from './actors';
import { commitAuthor, type HistoryAuthor } from './history';
import { Layout } from './layout';
import { Lru } from './lru';
import type { CommitInfo, GitTransport } from './transport';
import { isUpdate } from './yjs';

/** The most commits the Time Machine reads (main's own cap on a log, A855). */
export const MAX_TIMELINE_COMMITS = 10_000;

export interface TimelineCommit {
  readonly id: string;
  /** Epoch ms (the commit's author date). */
  readonly at: number;
  readonly author: HistoryAuthor;
}

export interface TimelineNote {
  readonly id: string;
  readonly title: string;
  /** Its folder in the registry then; null at the top level (or not filed). */
  readonly folderId: string | null;
  readonly position: string;
  /** In Trash then. */
  readonly deleted: boolean;
}

export interface TimelineTree {
  /** The commit; null before the notebook's first. */
  readonly commit: string | null;
  readonly folders: readonly FolderRecord[];
  readonly rootSortMode: SortMode;
  /** Every note with logs at the commit, Trash too (`deleted`). */
  readonly notes: readonly TimelineNote[];
}

export interface TimelineNoteText {
  readonly noteId: string;
  readonly commit: string;
  readonly title: string;
  /** The note as History compares versions: title and tags as frontmatter, then the body. */
  readonly markdown: string;
  readonly deleted: boolean;
}

export type NoteChangeKind = 'created' | 'edited' | 'renamed' | 'moved' | 'deleted' | 'restored';

export interface NoteChange {
  readonly noteId: string;
  /** Its title at the end of the range (or before it, when it was deleted for good). */
  readonly title: string;
  /** Its title before the range, when it was renamed. */
  readonly previousTitle: string | null;
  /** Its folder's path at the end (`Projects/Work`); '' at the top level. */
  readonly folder: string;
  /** Its folder's path before the range, when it moved. */
  readonly previousFolder: string | null;
  readonly kinds: readonly NoteChangeKind[];
  /** The writers whose files for it changed in the range. */
  readonly authors: readonly HistoryAuthor[];
  /** Whether it is live at the end of the range (not in Trash, not deleted for good). */
  readonly live: boolean;
}

export interface TimelineChanges {
  /** The last commit before the range (null: the range starts before the first). */
  readonly from: string | null;
  /** The last commit in the range (null: none at all). */
  readonly to: string | null;
  /** How many commits the range holds. */
  readonly commits: number;
  readonly notes: readonly NoteChange[];
}

export interface TimelineDiff {
  readonly before: string;
  readonly after: string;
  readonly diff: DiffOp[];
}

/** One commit's files: the workspace's logs, each note's logs and the actor files, with blobs. */
interface Listing {
  readonly workspace: ReadonlyArray<readonly [string, string]>;
  readonly notes: ReadonlyMap<string, ReadonlyArray<readonly [string, string]>>;
  readonly actors: ReadonlyMap<string, readonly [string, string]>;
}

interface NoteState {
  readonly title: string;
  readonly deleted: boolean;
}

interface NoteText {
  readonly markdown: string;
  readonly body: string;
}

interface WorkspaceState {
  readonly folders: FolderRecord[];
  readonly registry: ReadonlyMap<string, { folderId: string | null; position: string }>;
  readonly rootSortMode: SortMode;
}

const EMPTY_LISTING: Listing = { workspace: [], notes: new Map(), actors: new Map() };
const EMPTY_WORKSPACE: WorkspaceState = {
  folders: [],
  registry: new Map(),
  rootSortMode: 'manual',
};

/** A key for a set of files by their blobs: the same key, the same merged state. */
function keyOf(files: ReadonlyArray<readonly [string, string]>): string {
  return files
    .map(([path, blob]) => `${path}=${blob}`)
    .sort()
    .join('\n');
}

/** The last commit (in history's order) at or before `at`; null before the first. */
export function commitAt(
  commits: readonly TimelineCommit[],
  at: number,
  options: { readonly before?: boolean } = {},
): TimelineCommit | null {
  let found: TimelineCommit | null = null;
  for (const commit of commits) {
    if (options.before ? commit.at < at : commit.at <= at) found = commit;
  }
  return found;
}

export class NotebookTimeline {
  private commitList: Promise<TimelineCommit[]> | null = null;
  private readonly listings = new Lru<string, Promise<Listing>>(24);
  /** Note title and Trash state by the blobs of its logs (small, so all kept). */
  private readonly noteStates = new Map<string, NoteState>();
  private readonly noteTexts = new Lru<string, NoteText>(400);
  private readonly workspaces = new Lru<string, WorkspaceState>(64);

  constructor(
    private readonly transport: GitTransport,
    private readonly layout: Layout,
  ) {}

  /** Every commit of the notebook, oldest first; `refresh` reads the log again. */
  async commits(refresh = false): Promise<TimelineCommit[]> {
    if (refresh || !this.commitList) {
      const reading = this.transport
        .log({ limit: MAX_TIMELINE_COMMITS })
        .then((listed) => listed.reverse().map(toTimelineCommit));
      // A failed read is not kept: the next asks git again.
      reading.catch(() => {
        if (this.commitList === reading) this.commitList = null;
      });
      this.commitList = reading;
    }
    return this.commitList;
  }

  private listing(commit: string | null): Promise<Listing> {
    if (commit === null) return Promise.resolve(EMPTY_LISTING);
    const cached = this.listings.get(commit);
    if (cached) return cached;
    const reading = this.transport.list(commit).then((files) => {
      const workspace: Array<readonly [string, string]> = [];
      const notes = new Map<string, Array<readonly [string, string]>>();
      const actors = new Map<string, readonly [string, string]>();
      for (const [path, blob] of files) {
        const parsed = this.layout.parse(path);
        if (parsed?.kind === 'workspace') workspace.push([path, blob]);
        else if (parsed?.kind === 'note') {
          const list = notes.get(parsed.noteId) ?? [];
          list.push([path, blob]);
          notes.set(parsed.noteId, list);
        } else if (parsed?.kind === 'actor') actors.set(parsed.writer, [path, blob]);
      }
      return { workspace, notes, actors };
    });
    reading.catch(() => undefined);
    this.listings.set(commit, reading);
    return reading;
  }

  /** The merged Yjs doc of `files` at `commit`, read in one go. */
  private async docOf(
    commit: string,
    files: ReadonlyArray<readonly [string, string]>,
  ): Promise<Y.Doc> {
    const doc = new Y.Doc();
    if (files.length === 0) return doc;
    const read = await this.transport.read(
      commit,
      files.map(([path]) => path),
    );
    for (const [path] of files) {
      const bytes = read.get(path);
      if (bytes && isUpdate(bytes)) Y.applyUpdate(doc, bytes);
    }
    return doc;
  }

  private async workspaceAt(commit: string | null, listing: Listing): Promise<WorkspaceState> {
    if (commit === null || listing.workspace.length === 0) return EMPTY_WORKSPACE;
    const key = keyOf(listing.workspace);
    const cached = this.workspaces.get(key);
    if (cached) return cached;
    const doc = await this.docOf(commit, listing.workspace);
    try {
      const snapshot = readWorkspace(doc);
      const state: WorkspaceState = {
        folders: snapshot.folders,
        registry: new Map(
          snapshot.notes.map((note) => [
            note.id,
            { folderId: note.folderId, position: note.position },
          ]),
        ),
        rootSortMode: snapshot.rootSortMode,
      };
      this.workspaces.set(key, state);
      return state;
    } finally {
      doc.destroy();
    }
  }

  /**
   * Every note's title and Trash state at `commit`: the notes whose logs this reader has not
   * seen merged are read in one go, the rest come from the cache.
   */
  private async noteStatesAt(
    commit: string | null,
    listing: Listing,
  ): Promise<Map<string, NoteState>> {
    const out = new Map<string, NoteState>();
    if (commit === null) return out;
    const missing: Array<[string, ReadonlyArray<readonly [string, string]>, string]> = [];
    for (const [noteId, files] of listing.notes) {
      const key = keyOf(files);
      const known = this.noteStates.get(key);
      if (known) out.set(noteId, known);
      else missing.push([noteId, files, key]);
    }
    if (missing.length > 0) {
      const read = await this.transport.read(
        commit,
        missing.flatMap(([, files]) => files.map(([path]) => path)),
      );
      for (const [noteId, files, key] of missing) {
        const doc = new Y.Doc();
        try {
          for (const [path] of files) {
            const bytes = read.get(path);
            if (bytes && isUpdate(bytes)) Y.applyUpdate(doc, bytes);
          }
          const state = { title: readTitle(doc), deleted: isDeleted(doc) };
          this.noteStates.set(key, state);
          out.set(noteId, state);
        } finally {
          doc.destroy();
        }
      }
    }
    return out;
  }

  /** The folders and notes at `commit` (null: before the first commit, an empty notebook). */
  async tree(commit: string | null): Promise<TimelineTree> {
    const listing = await this.listing(commit);
    const [workspace, states] = await Promise.all([
      this.workspaceAt(commit, listing),
      this.noteStatesAt(commit, listing),
    ]);
    const notes: TimelineNote[] = [];
    for (const [id, state] of states) {
      // A note the registry does not know shows at the top level, as the app files it (T7).
      const entry = workspace.registry.get(id);
      notes.push({
        id,
        title: state.title,
        folderId: entry?.folderId ?? null,
        position: entry?.position ?? 'a0',
        deleted: state.deleted,
      });
    }
    return { commit, folders: workspace.folders, rootSortMode: workspace.rootSortMode, notes };
  }

  private async textOf(
    commit: string,
    files: ReadonlyArray<readonly [string, string]>,
  ): Promise<NoteText & NoteState> {
    return (await this.textsOf(commit, [files]))[0]!;
  }

  /** Several notes' texts at `commit`; the ones not cached are read in one go. */
  private async textsOf(
    commit: string,
    each: ReadonlyArray<ReadonlyArray<readonly [string, string]>>,
  ): Promise<Array<NoteText & NoteState>> {
    const keys = each.map(keyOf);
    const missing = each.filter(
      (_, i) => !this.noteTexts.get(keys[i]!) || !this.noteStates.has(keys[i]!),
    );
    if (missing.length > 0) {
      const read = await this.transport.read(
        commit,
        missing.flatMap((files) => files.map(([path]) => path)),
      );
      for (const files of missing) {
        const doc = new Y.Doc();
        try {
          for (const [path] of files) {
            const bytes = read.get(path);
            if (bytes && isUpdate(bytes)) Y.applyUpdate(doc, bytes);
          }
          const key = keyOf(files);
          this.noteTexts.set(key, { markdown: versionMarkdown(doc), body: bodyMarkdown(doc) });
          this.noteStates.set(key, { title: readTitle(doc), deleted: isDeleted(doc) });
        } finally {
          doc.destroy();
        }
      }
    }
    return keys.map((key) => {
      const text = this.noteTexts.get(key) ?? { markdown: '', body: '' };
      const state = this.noteStates.get(key) ?? { title: '', deleted: false };
      return { ...text, ...state };
    });
  }

  /** A note's text at `commit`; null where it had no logs then. */
  async note(noteId: string, commit: string): Promise<TimelineNoteText | null> {
    const listing = await this.listing(commit);
    const files = listing.notes.get(noteId);
    if (!files) return null;
    const text = await this.textOf(commit, files);
    return { noteId, commit, title: text.title, markdown: text.markdown, deleted: text.deleted };
  }

  /** A note's line diff from one commit to another (either null: no note there). */
  async diff(noteId: string, from: string | null, to: string | null): Promise<TimelineDiff> {
    const [before, after] = await Promise.all([
      this.markdownAt(noteId, from),
      this.markdownAt(noteId, to),
    ]);
    return { before, after, diff: diffLines(splitLines(before), splitLines(after)) };
  }

  private async markdownAt(noteId: string, commit: string | null): Promise<string> {
    if (commit === null) return '';
    const listing = await this.listing(commit);
    const files = listing.notes.get(noteId);
    return files ? (await this.textOf(commit, files)).markdown : '';
  }

  /**
   * What changed from the last commit before `from` to the last before `to` (epoch ms, `to`
   * excluded): each note created, edited, renamed, moved, deleted or restored, with who did it.
   */
  async changes(from: number, to: number): Promise<TimelineChanges> {
    const commits = await this.commits();
    const base = commitAt(commits, from, { before: true });
    const end = commitAt(commits, to, { before: true });
    const baseIndex = base ? commits.indexOf(base) : -1;
    const endIndex = end ? commits.indexOf(end) : -1;
    if (endIndex <= baseIndex || !end) {
      return { from: base?.id ?? null, to: base?.id ?? null, commits: 0, notes: [] };
    }
    const inRange = commits.slice(baseIndex + 1, endIndex + 1);
    const [beforeListing, afterListing] = await Promise.all([
      this.listing(base?.id ?? null),
      this.listing(end.id),
    ]);
    const [before, after] = await Promise.all([this.tree(base?.id ?? null), this.tree(end.id)]);
    const beforeNotes = new Map(before.notes.map((note) => [note.id, note]));
    const afterNotes = new Map(after.notes.map((note) => [note.id, note]));

    // Who: the writers whose files changed. Each writer writes only its own files (A821), so a
    // note's changed log names exactly who edited it; a move is the workspace's, so the writers
    // whose workspace file changed are named for it.
    const writersOf = (
      a: ReadonlyArray<readonly [string, string]>,
      b: ReadonlyArray<readonly [string, string]>,
    ): Set<string> => {
      const was = new Map(a);
      const now = new Map(b);
      const out = new Set<string>();
      for (const path of new Set([...was.keys(), ...now.keys()])) {
        if (was.get(path) === now.get(path)) continue;
        const parsed = this.layout.parse(path);
        if (parsed && 'writer' in parsed) out.add(parsed.writer);
      }
      return out;
    };
    const workspaceWriters = writersOf(beforeListing.workspace, afterListing.workspace);
    const authors = await this.authorsOf(inRange, end.id, afterListing);

    const folderName = (tree: TimelineTree, folderId: string | null): string =>
      folderId === null ? '' : (folderPath(tree.folders, folderId) ?? '');
    const filesOf = (listing: Listing, noteId: string) => listing.notes.get(noteId) ?? [];
    const ids = [...new Set([...beforeNotes.keys(), ...afterNotes.keys()])].filter((noteId) => {
      const was = beforeNotes.get(noteId);
      const now = afterNotes.get(noteId);
      // Live at one end at least: a note made and put in Trash within the range is not shown.
      return (was !== undefined && !was.deleted) || (now !== undefined && !now.deleted);
    });
    // The texts to compare, read in one go at each end.
    const compared = ids.filter(
      (noteId) =>
        afterNotes.has(noteId) &&
        keyOf(filesOf(beforeListing, noteId)) !== keyOf(filesOf(afterListing, noteId)),
    );
    const withBefore = compared.filter((noteId) => beforeNotes.has(noteId));
    const [beforeTexts, afterTexts] = await Promise.all([
      base
        ? this.textsOf(
            base.id,
            withBefore.map((noteId) => filesOf(beforeListing, noteId)),
          )
        : [],
      this.textsOf(
        end.id,
        compared.map((noteId) => filesOf(afterListing, noteId)),
      ),
    ]);
    const textBefore = new Map(withBefore.map((noteId, i) => [noteId, beforeTexts[i]!]));
    const textAfter = new Map(compared.map((noteId, i) => [noteId, afterTexts[i]!]));

    const notes: NoteChange[] = [];
    for (const noteId of ids) {
      const was = beforeNotes.get(noteId);
      const now = afterNotes.get(noteId);
      const wasLive = was !== undefined && !was.deleted;
      const nowLive = now !== undefined && !now.deleted;
      const kinds: NoteChangeKind[] = [];
      let previousTitle: string | null = null;
      let previousFolder: string | null = null;
      if (!was) kinds.push('created');
      if (was && now && !wasLive && nowLive) kinds.push('restored');
      if (was && now) {
        if (was.title !== now.title) {
          kinds.push('renamed');
          previousTitle = was.title;
        }
        const wasFolder = folderName(before, was.folderId);
        const nowFolder = folderName(after, now.folderId);
        if (wasLive && nowLive && wasFolder !== nowFolder) {
          kinds.push('moved');
          previousFolder = wasFolder;
        }
      }
      const a = textBefore.get(noteId);
      const b = textAfter.get(noteId);
      if (b && a) {
        // The body, or the tags (the version's frontmatter) with the title the same.
        if (a.body !== b.body || (a.title === b.title && a.markdown !== b.markdown)) {
          kinds.push('edited');
        }
      } else if (b && !was && b.body.trim() !== '') {
        // Made in the range, and given text.
        kinds.push('edited');
      }
      if (wasLive && !nowLive) kinds.push('deleted');
      if (kinds.length === 0) continue;
      const writers = writersOf(filesOf(beforeListing, noteId), filesOf(afterListing, noteId));
      if (kinds.includes('moved') || writers.size === 0) {
        for (const writer of workspaceWriters) writers.add(writer);
      }
      notes.push({
        noteId,
        title: (now ?? was)!.title,
        previousTitle,
        folder: now ? folderName(after, now.folderId) : folderName(before, was!.folderId),
        previousFolder,
        kinds,
        authors: [...writers]
          .map((writer) => authors.get(writer) ?? unknownWriter(writer))
          .sort((x, y) => x.label.localeCompare(y.label)),
        live: nowLive,
      });
    }
    notes.sort(
      (a, b) =>
        a.folder.localeCompare(b.folder) ||
        (a.title || 'Untitled').localeCompare(b.title || 'Untitled') ||
        (a.noteId < b.noteId ? -1 : 1),
    );
    return { from: base?.id ?? null, to: end.id, commits: inRange.length, notes };
  }

  /** Writers by id: from the commits' trailers, else from their actor files at `head`. */
  private async authorsOf(
    commits: readonly TimelineCommit[],
    head: string,
    listing: Listing,
  ): Promise<Map<string, HistoryAuthor>> {
    const out = new Map<string, HistoryAuthor>();
    for (const commit of commits) out.set(commit.author.id, commit.author);
    const unknown = [...listing.actors].filter(([writer]) => !out.has(writer));
    if (unknown.length > 0) {
      const read = await this.transport.read(
        head,
        unknown.map(([, [path]]) => path),
      );
      for (const [writer, [path]] of unknown) {
        const actor = parseActor(read.get(path));
        if (actor) out.set(writer, { id: writer, kind: actor.kind, label: actor.label });
      }
    }
    return out;
  }
}

function toTimelineCommit(commit: CommitInfo): TimelineCommit {
  return { id: commit.id, at: commit.at, author: commitAuthor(commit) };
}

function unknownWriter(id: string): HistoryAuthor {
  return { id, kind: 'device', label: 'Another writer' };
}

/** The tree for display: folders nested, notes in their folders, Trash left out. */
export function liveTree(tree: TimelineTree) {
  return buildTree(
    tree.folders,
    tree.notes
      .filter((note) => !note.deleted)
      .map((note) => ({
        id: note.id,
        folderId: note.folderId,
        position: note.position,
        title: note.title,
        updatedAt: 0,
      })),
    tree.rootSortMode,
  );
}

export { Layout };
export type { CommitInfo, GitTransport } from './transport';
