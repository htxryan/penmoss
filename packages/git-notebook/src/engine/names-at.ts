/**
 * What the files at head say about names (A823), as a sync's render and `renderAll` both read
 * them: which rendered files are Penmoss's and whose, which are foreign, and every note's name.
 */
import { readWorkspace } from '@penmoss/model/workspace';
import type * as Y from '@y/y';
import type { Layout } from '../layout';
import { assignNames, foreignOf, storedNotePath, type Foreign, type Named } from '../names';
import type { NotebookReplica } from '../replica';

/** The `.md` files at head under the notebook's directory, outside `.penmoss/`. */
export function renderedPaths(layout: Layout, files: ReadonlyMap<string, string>): string[] {
  return [...files.keys()].filter(
    (path) => path.endsWith('.md') && !path.startsWith(layout.base) && layout.contains(path),
  );
}

/**
 * The files at head as Penmoss's and foreign ones, `idOf` giving a rendered file's frontmatter
 * id: a file is a note's when this device knows the note (its doc, a purge, the registry).
 */
export function foreignAt(
  replica: NotebookReplica,
  layout: Layout,
  files: ReadonlyMap<string, string>,
  idOf: (path: string) => string | null,
  purged: ReadonlySet<string>,
): Foreign {
  const known = new Set([
    ...replica.noteIds(),
    ...purged,
    ...readWorkspace(replica.workspace).notes.map((note) => note.id),
  ]);
  return foreignOf(files.keys(), idOf, layout.root, known, owner(replica.workspace, purged));
}

/** Every folder's and live note's name and path, around the foreign files. */
export function namesAt(
  replica: NotebookReplica,
  layout: Layout,
  purged: ReadonlySet<string>,
  foreign: Foreign,
): Named {
  return assignNames({
    workspace: replica.workspace,
    notes: replica.notes,
    purged,
    foreign,
    root: layout.root,
  });
}

/** Where each note's file is at head: note id → path. */
export function headPaths(foreign: Foreign): Map<string, string> {
  return new Map([...foreign.penmoss].map(([path, id]) => [id, path]));
}

/**
 * Whether Penmoss put the file at `rel` (relative to `<dir>`) for note `id` (A823): where it
 * last rendered it, as stored with the names that landed. A file with the note's id anywhere
 * else is a copy someone made: Penmoss leaves it. A purged note's files all go (A828); a note
 * with no stored path (rendered before the record existed) owns every file with its id.
 */
function owner(workspace: Y.Doc, purged: ReadonlySet<string>) {
  return (rel: string, id: string) => {
    if (purged.has(id)) return true;
    const at = storedNotePath(workspace, id);
    return at === undefined || at === rel;
  };
}
