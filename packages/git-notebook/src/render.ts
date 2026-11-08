/**
 * The rendered markdown of a git notebook (T50, A823; #147's A743). Deterministic: a pure
 * function of the merged note docs, the merged WorkspaceDoc (tree, stored names, Trash, purges),
 * the foreign file names and `RENDER_VERSION`, so two writers with the same state write the same
 * bytes. The format is the mirror's (A204, A205): it renders through the same `mirrorMarkdown`.
 */
import { assetPrefix } from '@penmoss/core/mirror';
import { mirrorMarkdown, readNoteState } from '@penmoss/editor/markdown';
import { NOTE_META } from '@penmoss/sync-client/note';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import * as Y from '@y/y';
import type { Named } from './names';

/** The per-writer key of a note's last change (A823): `changedAt/<writer>`. */
export const CHANGED_AT_PREFIX = 'changedAt/';

/**
 * `updated` (A823): the latest of the per-writer keys. Yjs settles concurrent writes to one key
 * by client id, not by time, so a single shared key could go backwards.
 */
export function changedAtOf(doc: Y.Doc): number {
  let max = 0;
  for (const [key, value] of doc.get(NOTE_META).attrEntries()) {
    if (String(key).startsWith(CHANGED_AT_PREFIX) && typeof value === 'number' && value > max) {
      max = value;
    }
  }
  return max;
}

/** The notes a body links to or embeds, by id. */
export function linkTargets(doc: Y.Doc): Set<string> {
  const out = new Set<string>();
  const walk = (node: Y.Node) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.Node)) continue;
      if (child.name === 'wikilink' || child.name === 'embed') {
        const id: unknown = child.getAttr('noteId');
        if (typeof id === 'string' && id) out.add(id);
      } else {
        walk(child);
      }
    }
  };
  walk(doc.get(NOTE_ROOT));
  return out;
}

/** One note's markdown, as the mirror writes it. */
export function renderNoteFile(
  doc: Y.Doc,
  noteId: string,
  path: string,
  named: Named,
  root: string,
): string {
  const link = (id: string) => {
    const name = named.paths.has(id) ? named.names.get(id) : undefined;
    return name ? { name: name.name, title: name.title } : null;
  };
  return mirrorMarkdown(readNoteState(doc), noteId, changedAtOf(doc), {
    link,
    assetPrefix: assetPrefix(path.slice(root.length)),
  }).markdown;
}

/**
 * The render set (A823, with G0's change): the notes whose logs changed or that this writer
 * changed, notes whose file someone else changed (a hand edit, a colleague's commit), notes with
 * no file at their path yet or whose path moved (renamed, moved, a folder renamed or moved), and
 * the notes linking to any note whose name, title or presence may have changed.
 */
export function renderSet(input: {
  readonly named: Named;
  readonly notes: ReadonlyMap<string, Y.Doc>;
  /** Notes whose logs this sync applied, and notes this writer changed. */
  readonly changed: Iterable<string>;
  /** Each note's file at head (Penmoss's rendered files). */
  readonly headPath: ReadonlyMap<string, string>;
  /** Notes whose file at head changed since the last synced head. */
  readonly touched?: ReadonlySet<string>;
}): Set<string> {
  const { named, notes, headPath } = input;
  const set = new Set([...input.changed, ...(input.touched ?? [])]);
  const renamed = new Set<string>();
  for (const [id, path] of named.paths) {
    if (headPath.get(id) !== path) {
      set.add(id);
      renamed.add(id);
    }
  }
  // Gone from the render (Trash, purged): their linkers write the link differently now.
  for (const id of headPath.keys()) if (!named.paths.has(id)) renamed.add(id);
  // A changed note's title may have changed: `[[name|Title]]` in its linkers too.
  for (const id of set) if (named.paths.has(id)) renamed.add(id);
  if (renamed.size > 0) {
    for (const id of named.paths.keys()) {
      if (set.has(id)) continue;
      const doc = notes.get(id);
      if (!doc) continue;
      for (const target of linkTargets(doc)) {
        if (renamed.has(target)) {
          set.add(id);
          break;
        }
      }
    }
  }
  return set;
}
