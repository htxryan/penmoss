/**
 * A note as the branch had it at a commit: its directory's files, every writer's log merged, and
 * its title. History, the Time Machine and agent activity all read old notes this one way.
 */
import { readTitle } from '@penmoss/sync-client/note';
import * as Y from '@y/y';
import type { Layout } from './layout';
import type { GitTransport } from './transport';
import { isUpdate, mergeUpdates } from './yjs';

/** What reading a note at a commit takes of a transport. */
export type NoteReader = Pick<GitTransport, 'list' | 'read' | 'readDir'>;

/** Commits listed and read at once where the transport has no `readDir`. */
const PARALLEL_READS = 4;

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

/**
 * A note's files (path → bytes) at each of `commits`, read together: only the note's directory,
 * in one `readDir` where the transport has it (Ryan's review of #192, finding 10); otherwise each
 * commit is listed and the note's files read, a few commits at a time.
 */
export async function noteFilesAt(
  transport: NoteReader,
  layout: Layout,
  noteId: string,
  commits: readonly string[],
): Promise<Map<string, ReadonlyMap<string, Uint8Array>>> {
  const dir = layout.noteDir(noteId);
  const out = new Map<string, ReadonlyMap<string, Uint8Array>>();
  if (commits.length === 0) return out;
  if (transport.readDir) {
    const { files, blobs } = await transport.readDir(commits, dir);
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
  await eachLimited(commits, PARALLEL_READS, async (commit) => {
    const files = await transport.list(commit);
    const paths = [...files.keys()].filter((path) => path.startsWith(dir));
    out.set(commit, paths.length > 0 ? await transport.read(commit, paths) : new Map());
  });
  return out;
}

/** The merge of every writer's log among `files` (a file that is not a Yjs update is left out); null where there is none. */
export function mergedLogs(files: Iterable<Uint8Array> | undefined): Uint8Array | null {
  const parts = [...(files ?? [])].filter(isUpdate);
  return parts.length > 0 ? mergeUpdates(parts) : null;
}

/** A doc holding `state` (empty for null). The caller destroys it. */
export function docOfState(state: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  return doc;
}

/**
 * A doc with each of `logs` applied in turn (one not there, or not a Yjs update, is left out): a
 * note's or the WorkspaceDoc's files at a commit, as the Time Machine reads them. The caller
 * destroys it.
 */
export function docOfLogs(logs: Iterable<Uint8Array | undefined>): Y.Doc {
  const doc = new Y.Doc();
  for (const bytes of logs) if (bytes && isUpdate(bytes)) Y.applyUpdate(doc, bytes);
  return doc;
}

/** A note's title as the branch had it at `commit`; null where none of its logs is there. */
export async function titleAt(
  transport: NoteReader,
  layout: Layout,
  noteId: string,
  commit: string,
): Promise<string | null> {
  const files = (await noteFilesAt(transport, layout, noteId, [commit])).get(commit);
  const state = mergedLogs(files?.values());
  if (state === null) return null;
  const doc = docOfState(state);
  try {
    return readTitle(doc);
  } finally {
    doc.destroy();
  }
}
