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
import { Lru } from './lru';
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

/** Commits listed and read at once where the transport has no `readDir`. */
const PARALLEL_READS = 4;

/** Versions rendered to markdown before `summaries` lets other work run (a page's input). */
const RENDERS_PER_TURN = 8;

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Runs `work` on each of `items`, at most `limit` at a time. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** The merge of every writer's log among `files`; null where there is none. */
function merged(files: ReadonlyMap<string, Uint8Array> | undefined): Uint8Array | null {
  const parts = [...(files?.values() ?? [])].filter(isUpdate);
  return parts.length > 0 ? mergeUpdates(parts) : null;
}

function docOf(state: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  return doc;
}

/** The note's markdown as History compares versions. */
function markdownOf(state: Uint8Array | null): string {
  const doc = docOf(state);
  try {
    return versionMarkdown(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * A note's versions from its git notebook's commits. Reading is batched (Ryan's review of #192,
 * finding 10): the list comes from the log alone (`versions`), and what each version changed
 * (`summaries`) is read for many versions at once: only the note's own directory at each commit,
 * in one `readDir`, never the whole tree, with a partial clone's missing blobs fetched in one
 * request. A version never changes (pushes are fast-forwards), so its markdown and summary are
 * kept for the reader's life, and a History opened again reads only the versions made since.
 */
export class NotebookHistory {
  /** Merged note states by note and commit (Restore, Revert, the Time Machine's restore). */
  private readonly states = new Lru<string, Uint8Array | null>(32);
  /** Each version's markdown as History compares them, by note and commit. */
  private readonly texts = new Lru<string, string>(512);
  /** What each version changed (`summarise`), by note and commit. */
  private readonly summaryOf = new Lru<string, string>(5000);
  /** The commit of the version before each one (null: the first), by note and commit. */
  private readonly previousOf = new Lru<string, string | null>(5000);

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
    const commits = listed.reverse();
    for (const [index, commit] of commits.entries()) {
      this.previousOf.set(`${noteId}:${commit.id}`, index > 0 ? commits[index - 1]!.id : null);
    }
    return commits;
  }

  /** The note's files at each of `commits` (path → bytes), read together. */
  private async filesAt(
    noteId: string,
    commits: readonly string[],
  ): Promise<Map<string, ReadonlyMap<string, Uint8Array>>> {
    const dir = this.layout.noteDir(noteId);
    const out = new Map<string, ReadonlyMap<string, Uint8Array>>();
    if (commits.length === 0) return out;
    if (this.transport.readDir) {
      const { files, blobs } = await this.transport.readDir(commits, dir);
      for (const commit of commits) {
        const read = new Map<string, Uint8Array>();
        for (const [path, blob] of files.get(commit) ?? []) {
          const bytes = blobs.get(blob);
          if (bytes) read.set(path, bytes);
        }
        out.set(commit, read);
      }
      return out;
    }
    // A transport without it lists each commit and reads the note's files, a few at a time.
    await eachLimited(commits, PARALLEL_READS, async (commit) => {
      const files = await this.transport.list(commit);
      const paths = [...files.keys()].filter((path) => path.startsWith(dir));
      out.set(commit, paths.length > 0 ? await this.transport.read(commit, paths) : new Map());
    });
    return out;
  }

  /** The note as every writer's files had it at each of `commits`, read together. */
  private async statesAt(
    noteId: string,
    commits: readonly (string | null)[],
  ): Promise<Map<string, Uint8Array | null>> {
    const out = new Map<string, Uint8Array | null>();
    const wanted: string[] = [];
    for (const commit of new Set(commits)) {
      if (commit === null) continue;
      const key = `${noteId}:${commit}`;
      if (this.states.has(key)) out.set(commit, this.states.get(key) ?? null);
      else wanted.push(commit);
    }
    const read = await this.filesAt(noteId, wanted);
    for (const commit of wanted) {
      const state = merged(read.get(commit));
      this.states.set(`${noteId}:${commit}`, state);
      out.set(commit, state);
    }
    return out;
  }

  /** The note as every writer's files had it at `commit`; null where it had none. */
  async stateAt(noteId: string, commit: string): Promise<Uint8Array | null> {
    return (await this.statesAt(noteId, [commit])).get(commit) ?? null;
  }

  /** A doc of the note at `commit` (empty where it had none). */
  async docAt(noteId: string, commit: string | null): Promise<Y.Doc> {
    return docOf(commit ? await this.stateAt(noteId, commit) : null);
  }

  /** The note's markdown at each of `commits`, the ones not known yet read together. */
  private async markdownsAt(
    noteId: string,
    commits: readonly string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const wanted: string[] = [];
    for (const commit of new Set(commits)) {
      const key = `${noteId}:${commit}`;
      const known = this.texts.get(key);
      if (known !== undefined) out.set(commit, known);
      else if (this.states.has(key)) out.set(commit, markdownOf(this.states.get(key) ?? null));
      else wanted.push(commit);
    }
    const read = await this.filesAt(noteId, wanted);
    for (const [i, commit] of wanted.entries()) {
      // Rendering a long note's markdown takes a few ms: a window's page stays responsive.
      if (i > 0 && i % RENDERS_PER_TURN === 0) await nextTurn();
      out.set(commit, markdownOf(merged(read.get(commit))));
    }
    for (const [commit, markdown] of out) this.texts.set(`${noteId}:${commit}`, markdown);
    return out;
  }

  private author(commit: CommitInfo): HistoryAuthor {
    return commitAuthor(commit);
  }

  /**
   * The note's versions, newest first, at most `limit` (20) of them, from the log alone: one
   * `git log`, nothing read. A version's summary is there when this reader worked it out
   * before, else '' (`summaries` reads them). With what this device changed since its last
   * commit (`dirtySince`, with `self` as the author).
   */
  async versions(
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
      const author = this.author(commit);
      versions.push({
        id: index + 1,
        commit: commit.id,
        createdAt: commit.at,
        reason: author.kind === 'agent' ? 'edit' : 'auto',
        summary: this.summaryOf.get(`${noteId}:${commit.id}`) ?? '',
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

  /**
   * What each of `versions` (as `versions` lists them) changed since the version before it,
   * by version id: every markdown not known yet read in one go.
   */
  async summaries(
    noteId: string,
    versions: readonly Pick<GitVersion, 'id' | 'commit'>[],
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const todo = versions.filter((version) => {
      const known = this.summaryOf.get(`${noteId}:${version.commit}`);
      if (known !== undefined) out.set(version.id, known);
      return known === undefined;
    });
    if (todo.length === 0) return out;
    if (todo.some((version) => !this.previousOf.has(`${noteId}:${version.commit}`))) {
      await this.commits(noteId);
    }
    const previous = (commit: string) => this.previousOf.get(`${noteId}:${commit}`) ?? null;
    const needed: string[] = [];
    for (const version of todo) {
      needed.push(version.commit);
      const before = previous(version.commit);
      if (before) needed.push(before);
    }
    const texts = await this.markdownsAt(noteId, needed);
    for (const version of todo) {
      const before = previous(version.commit);
      const summary = summarise(
        before ? (texts.get(before) ?? '') : '',
        texts.get(version.commit) ?? '',
      );
      this.summaryOf.set(`${noteId}:${version.commit}`, summary);
      out.set(version.id, summary);
    }
    return out;
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
    const listed = await this.versions(noteId, options);
    const summaries = await this.summaries(noteId, listed.versions);
    return {
      ...listed,
      versions: listed.versions.map((version) => ({
        ...version,
        summary: summaries.get(version.id) ?? version.summary,
      })),
    };
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
    const texts = await this.markdownsAt(
      noteId,
      found.previous ? [found.commit.id, found.previous.id] : [found.commit.id],
    );
    const markdown = texts.get(found.commit.id) ?? '';
    const before = found.previous ? (texts.get(found.previous.id) ?? '') : '';
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
    const states = await this.statesAt(noteId, [found.commit.id, parent]);
    return {
      before: docOf(parent ? (states.get(parent) ?? null) : null),
      after: docOf(states.get(found.commit.id) ?? null),
    };
  }
}
