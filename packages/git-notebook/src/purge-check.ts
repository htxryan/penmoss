/**
 * What a commit deletes for good (T50, A828, A855), for a process that runs git for an engine it
 * does not trust: the Mac app's main process, for the page's engine. Delete for good is the one
 * change that removes other writers' files and makes every device drop a note, so main lets a
 * commit carry one only for a note the Mac's owner confirmed (Touch ID) for that id. A script in
 * the page that marks a note purged and syncs is refused here, whatever the page says. Logs only
 * grow, so a commit that replaces one with less than the head holds (emptied, or cut) is refused
 * too: that would wipe a note, or the folders, without deleting anything.
 *
 * `@penmoss/git-notebook/purge-check`: Yjs and the layout, without the engine.
 */
import * as Y from '@y/y';
import { Layout } from './layout';
import { purgedIds, recoveredFromOf } from './purge';
import { isUpdate } from './yjs';

/** Who made a commit (its `Penmoss-Writer` trailer), for main and the guard. */
export { commitWriter } from './writer';
import { readTitle } from '@penmoss/sync-client/note';

export interface CommitPurges {
  /** Notes the commit deletes for good that the head had not. */
  readonly added: readonly string[];
  /** Notes whose logs the commit removes although no one deleted them for good. */
  readonly stray: readonly string[];
  /** Logs (note or workspace) the commit replaces with less than the head holds. */
  readonly shrunk: readonly string[];
  /** Notes the head holds deleted for good that the commit takes back (never allowed). */
  readonly reversed: readonly string[];
  /**
   * Copies brought back after a store was cleared (A886) that the commit adds to the branch
   * although their original was deleted for good at head, by another device before them: the
   * engine withholds them, and main lets one through only with the person's confirmation for that
   * copy (Keep and sync). A purge the commit itself makes does not count: the person deleted only
   * the original, with the copy before them.
   */
  readonly raced: readonly string[];
  /**
   * Commits whose undo mark (`agentUndone`) the commit adds, changes or removes (#174 delta review): only
   * a person's writer marks an agent's change undone, so main and Android's guard refuse a commit
   * from an agent writer with any.
   */
  readonly undoneMarks: readonly string[];
}

/** The WorkspaceDoc root that marks agents' changes undone (`agent-activity`'s). */
const AGENT_UNDONE = 'agentUndone';

/** What reads the head (a transport's `list` and `read`). */
export interface HeadReader {
  list(head: string): Promise<ReadonlyMap<string, string>>;
  read(head: string, paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>>;
}

/** The notes a commit of `changes` on top of `head` deletes for good, and logs it drops. */
export async function commitPurges(
  reader: HeadReader,
  root: string,
  head: string | null,
  changes: ReadonlyMap<string, Uint8Array | null>,
): Promise<CommitPurges> {
  const layout = new Layout(root);
  const isLog = (path: string) => {
    const kind = layout.parse(path)?.kind;
    return kind === 'workspace' || kind === 'note';
  };
  if (![...changes.keys()].some(isLog)) {
    return { added: [], stray: [], shrunk: [], reversed: [], raced: [], undoneMarks: [] };
  }
  const files = head ? await reader.list(head) : new Map<string, string>();
  const atHead = [...files.keys()].filter((path) => layout.parse(path)?.kind === 'workspace');
  const rewritten = [...changes]
    .filter(([path, bytes]) => bytes !== null && isLog(path) && files.has(path))
    .map(([path]) => path);
  const wanted = [...new Set([...atHead, ...rewritten])];
  const read =
    head && wanted.length > 0 ? await reader.read(head, wanted) : new Map<string, Uint8Array>();
  const shrunk = rewritten.filter((path) => !covers(changes.get(path)!, read.get(path))).sort();
  const merged = (logs: Iterable<Uint8Array | null | undefined>) => {
    const doc = new Y.Doc();
    for (const bytes of logs) if (bytes && isUpdate(bytes)) Y.applyUpdate(doc, bytes);
    const ids = purgedIds(doc);
    copies = recoveredFromOf(doc);
    marks = new Map(
      Object.entries(doc.get(AGENT_UNDONE).getAttrs() as Record<string, unknown>).map(
        ([commit, value]) => [commit, JSON.stringify(value ?? null)],
      ),
    );
    doc.destroy();
    return ids;
  };
  let copies = new Map<string, string>();
  let marks = new Map<string, string>();
  const before = merged(atHead.map((path) => read.get(path)));
  const marksBefore = marks;
  const paths = new Set([
    ...atHead,
    ...[...changes.keys()].filter((path) => layout.parse(path)?.kind === 'workspace'),
  ]);
  const after = merged(
    [...paths].map((path) => (changes.has(path) ? changes.get(path) : read.get(path))),
  );
  // Added, changed or taken away.
  const undoneMarks = [...new Set([...marks.keys(), ...marksBefore.keys()])]
    .filter((commit) => marksBefore.get(commit) !== marks.get(commit))
    .sort();
  const added = [...after].filter((id) => !before.has(id)).sort();
  // A Delete for good that landed stays (A855): a workspace that no longer holds it would bring
  // the note back from any writer that still has an old copy.
  const reversed = [...before].filter((id) => !after.has(id)).sort();
  const stray = new Set<string>();
  for (const [path, bytes] of changes) {
    const parsed = layout.parse(path);
    if (bytes === null && parsed?.kind === 'note' && !after.has(parsed.noteId)) {
      stray.add(parsed.noteId);
    }
  }
  // A copy the commit adds (no log of it at head) whose original is deleted for good at head
  // (A886): a purge this commit makes is the person's own, with the copy in front of them.
  const noteAtHead = new Set(
    [...files.keys()].flatMap((path) => {
      const parsed = layout.parse(path);
      return parsed?.kind === 'note' ? [parsed.noteId] : [];
    }),
  );
  const raced = new Set<string>();
  for (const [path, bytes] of changes) {
    const parsed = layout.parse(path);
    if (bytes === null || parsed?.kind !== 'note' || noteAtHead.has(parsed.noteId)) continue;
    const from = copies.get(parsed.noteId);
    if (from !== undefined && before.has(from) && !after.has(parsed.noteId)) {
      raced.add(parsed.noteId);
    }
  }
  return {
    added,
    stray: [...stray].sort(),
    shrunk,
    reversed,
    raced: [...raced].sort(),
    undoneMarks,
  };
}

/** Whether `next` holds at least what `before` did, for every client (a log only grows). */
function covers(next: Uint8Array, before: Uint8Array | undefined): boolean {
  if (!before || !isUpdate(before)) return true;
  if (!isUpdate(next)) return false;
  const had = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(before));
  const has = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(next));
  for (const [client, clock] of had) if ((has.get(client) ?? 0) < clock) return false;
  return true;
}

/** The notes deleted for good at `head` (its workspace logs merged). */
export async function purgedAt(
  reader: HeadReader,
  root: string,
  head: string | null,
): Promise<Set<string>> {
  if (!head) return new Set();
  const layout = new Layout(root);
  const files = await reader.list(head);
  const paths = [...files.keys()].filter((path) => layout.parse(path)?.kind === 'workspace');
  const read = paths.length > 0 ? await reader.read(head, paths) : new Map<string, Uint8Array>();
  const doc = new Y.Doc();
  for (const path of paths) {
    const bytes = read.get(path);
    if (bytes && isUpdate(bytes)) Y.applyUpdate(doc, bytes);
  }
  const ids = purgedIds(doc);
  doc.destroy();
  return ids;
}

/**
 * The titles of `noteIds` at `head` (every writer's logs of each merged), for main to name the
 * notes it asks about. A note with no readable log at head is left out.
 */
export async function titlesAt(
  reader: HeadReader,
  root: string,
  head: string | null,
  noteIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!head || noteIds.length === 0) return out;
  const layout = new Layout(root);
  const wanted = new Set(noteIds);
  const byNote = new Map<string, string[]>();
  for (const path of (await reader.list(head)).keys()) {
    const parsed = layout.parse(path);
    if (parsed?.kind !== 'note' || !wanted.has(parsed.noteId)) continue;
    byNote.set(parsed.noteId, [...(byNote.get(parsed.noteId) ?? []), path]);
  }
  const paths = [...byNote.values()].flat();
  const read = paths.length > 0 ? await reader.read(head, paths) : new Map<string, Uint8Array>();
  for (const [noteId, logs] of byNote) {
    const doc = new Y.Doc();
    for (const path of logs) {
      const bytes = read.get(path);
      if (bytes && isUpdate(bytes)) Y.applyUpdate(doc, bytes);
    }
    out.set(noteId, readTitle(doc));
    doc.destroy();
  }
  return out;
}
