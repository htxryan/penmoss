/**
 * History for git notebooks (T50 G6, #154; A831, A858). A note's versions are the commits that
 * touched its logs (`.penmoss/notes/<id>/`): each writer commits its own files, so every sync of a
 * device and every burst of an agent's edits is a version of its own. The note's state at a
 * version is the merge of every writer's file there. Who made it comes from the commit's
 * `Penmoss-Writer` trailer (A825) and the actor files (A829).
 *
 * The answers have the server's shapes (`/api/notes/:id/versions`, MCP `get_history`), so the
 * apps' History panel, the CLI and the local MCP read them unchanged. Version ids are whole
 * numbers, as the server's are: the oldest commit that touched the note is 1, and each later one
 * the next. Pushes are fast-forwards only, so an id never changes once given.
 *
 * Restore is A80's diff-apply (`restoreContent`) and Revert A81's three-way merge
 * (`revertChange`), both applied by the caller as an ordinary local change that syncs.
 */
import { diffLines, splitLines, summarise, type DiffOp } from '@penmoss/core/diff';
import { versionMarkdown } from '@penmoss/editor/markdown';
import * as Y from '@y/y';
import type { Layout } from './layout';
import type { CommitInfo, GitTransport } from './transport';
import { commitWriter } from './writer';
import type { WriterKind } from './writer';
import { isUpdate, mergeUpdates } from './yjs';

export interface HistoryAuthor {
  /** The writer's id (or the commit author's email where a commit names no writer). */
  readonly id: string;
  readonly kind: WriterKind;
  readonly label: string;
}

/** A version as `GET /api/notes/:id/versions` lists it. */
export interface GitVersion {
  readonly id: number;
  /** The commit (git notebooks only). */
  readonly commit: string;
  readonly createdAt: number;
  /** `edit` for an agent's commit (its edits can be reverted, A81), else `auto`. */
  readonly reason: 'auto' | 'edit';
  readonly summary: string;
  readonly authors: HistoryAuthor[];
}

export interface GitHistory {
  /** Newest first. */
  readonly versions: GitVersion[];
  /** Changes made here and not committed yet. */
  readonly unversioned: { readonly authors: HistoryAuthor[]; readonly since: number } | null;
}

export interface GitVersionDetail {
  readonly id: number;
  readonly previousId: number | null;
  readonly markdown: string;
  readonly diff: DiffOp[];
}

export { commitWriter } from './writer';

/** Who made a commit: its `Penmoss-Writer` trailer (A825), else the commit's git identity. */
export function commitAuthor(commit: CommitInfo): HistoryAuthor {
  const named = commitWriter(commit.message);
  if (named) return named;
  // A commit from before the trailer: the device's git identity.
  return { id: commit.author.email, kind: 'device', label: commit.author.name };
}

/** The most versions listed (as the server's History keeps them, newest first). */
export const MAX_VERSIONS = 1000;

export class NotebookHistory {
  /** Merged note states by commit and note. */
  private readonly states = new Map<string, Uint8Array | null>();

  constructor(
    private readonly transport: GitTransport,
    private readonly layout: Layout,
  ) {}

  /** The commits that touched the note's logs, oldest first (version 1 is the first). */
  private async commits(noteId: string): Promise<CommitInfo[]> {
    const listed = await this.transport.log({
      paths: [this.layout.noteDir(noteId)],
      limit: MAX_VERSIONS,
    });
    return listed.reverse();
  }

  /** The note as every writer's files had it at `commit`; null where it had none. */
  async stateAt(noteId: string, commit: string): Promise<Uint8Array | null> {
    const key = `${commit}:${noteId}`;
    if (this.states.has(key)) return this.states.get(key)!;
    const files = await this.transport.list(commit);
    const dir = this.layout.noteDir(noteId);
    const paths = [...files.keys()].filter((path) => path.startsWith(dir));
    let state: Uint8Array | null = null;
    if (paths.length > 0) {
      const read = await this.transport.read(commit, paths);
      const parts = [...read.values()].filter(isUpdate);
      state = parts.length > 0 ? mergeUpdates(parts) : null;
    }
    this.states.set(key, state);
    return state;
  }

  /** A doc of the note at `commit` (empty where it had none). */
  async docAt(noteId: string, commit: string | null): Promise<Y.Doc> {
    const doc = new Y.Doc();
    const state = commit ? await this.stateAt(noteId, commit) : null;
    if (state) Y.applyUpdate(doc, state);
    return doc;
  }

  private author(commit: CommitInfo): HistoryAuthor {
    return commitAuthor(commit);
  }

  /**
   * The note's versions, newest first, at most `limit` (20) of them with summaries; and what
   * this device changed since its last commit (`dirtySince`, with `self` as the author).
   */
  async history(
    noteId: string,
    options: {
      readonly limit?: number;
      readonly dirtySince?: number | null;
      readonly self?: HistoryAuthor | null;
    } = {},
  ): Promise<GitHistory> {
    const commits = await this.commits(noteId);
    const limit = Math.min(options.limit ?? 20, MAX_VERSIONS);
    const versions: GitVersion[] = [];
    for (let index = commits.length - 1; index >= 0 && versions.length < limit; index--) {
      const commit = commits[index]!;
      const previous = index > 0 ? commits[index - 1]!.id : null;
      const [after, before] = await Promise.all([
        this.markdownAt(noteId, commit.id),
        previous ? this.markdownAt(noteId, previous) : Promise.resolve(''),
      ]);
      const author = this.author(commit);
      versions.push({
        id: index + 1,
        commit: commit.id,
        createdAt: commit.at,
        reason: author.kind === 'agent' ? 'edit' : 'auto',
        summary: summarise(before, after),
        authors: [author],
      });
    }
    return {
      versions,
      unversioned:
        options.dirtySince != null && options.self
          ? { authors: [options.self], since: options.dirtySince }
          : null,
    };
  }

  private async markdownAt(noteId: string, commit: string): Promise<string> {
    const doc = await this.docAt(noteId, commit);
    try {
      return versionMarkdown(doc);
    } finally {
      doc.destroy();
    }
  }

  /** The commit of version `id` and the one before it (null: the first). */
  async commitOf(
    noteId: string,
    id: number,
  ): Promise<{ commit: CommitInfo; previous: CommitInfo | null } | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const commits = await this.commits(noteId);
    const commit = commits[id - 1];
    if (!commit) return null;
    return { commit, previous: id > 1 ? commits[id - 2]! : null };
  }

  /** A version's markdown and its line diff against the version before (the server's shape). */
  async detail(noteId: string, id: number): Promise<GitVersionDetail | null> {
    const found = await this.commitOf(noteId, id);
    if (!found) return null;
    const markdown = await this.markdownAt(noteId, found.commit.id);
    const before = found.previous ? await this.markdownAt(noteId, found.previous.id) : '';
    return {
      id,
      previousId: found.previous ? id - 1 : null,
      markdown,
      diff: diffLines(splitLines(before), splitLines(markdown)),
    };
  }

  /**
   * What reverting version `id` merges (A81, A831): the note after that commit and before it
   * (the commit's parent: everything other writers had then, so only this commit's change is
   * undone). Null when there is no such version.
   */
  async revertPair(noteId: string, id: number): Promise<{ before: Y.Doc; after: Y.Doc } | null> {
    const found = await this.commitOf(noteId, id);
    if (!found) return null;
    const parent = found.commit.parents[0] ?? null;
    const [after, before] = await Promise.all([
      this.docAt(noteId, found.commit.id),
      this.docAt(noteId, parent),
    ]);
    return { before, after };
  }
}
