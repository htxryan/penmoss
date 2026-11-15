/**
 * Short note references in the app (PEN-69): `/notes/K7QD-9HTF2CXA`, which a
 * `penmoss://note/K7QD-9HTF2CXA` link opens, names a note by its notebook's 4 characters and the
 * last 8 of its id. The git notebook those 4 characters name, among this Mac's, holds the note.
 */
import { matchNoteRef, notebookTag, parseNoteRef } from '@penmoss/core/note-ref';
import type { Workspace } from '../workspace/service';

/** What a reference names: a note's id, no notebook here, or no note in that notebook (yet). */
export type ShortRefTarget =
  | { readonly kind: 'note'; readonly id: string }
  | { readonly kind: 'no-notebook' }
  | { readonly kind: 'no-note' };

export function noteOfShortRef(
  ref: string,
  sources: ReadonlyArray<{ readonly id: string; readonly workspace: Workspace }>,
): ShortRefTarget {
  const parsed = parseNoteRef(ref);
  if (parsed.kind === 'id') return { kind: 'note', id: parsed.id };
  const source = sources.find((each) => notebookTag(each.id) === parsed.notebook);
  if (!source) return { kind: 'no-notebook' };
  const ids = source.workspace.getState().snapshot.notes.map((note) => note.id);
  const id = matchNoteRef(parsed.note, ids);
  return id === null ? { kind: 'no-note' } : { kind: 'note', id };
}
