/**
 * Which versions in History offer Revert (T21, T42, N7, A574). Revert takes back an agent's own
 * edit and keeps later ones. An agent moving a note to Trash or restoring it also cuts a version
 * (named "Moved to Trash" or "Restored from Trash"), but there is no edit of the text to take
 * back: Trash and its Restore undo those, so they offer Restore this version only.
 */
const TRASH_MOVES = new Set(['Moved to Trash', 'Restored from Trash']);

export function revertible(version: {
  readonly summary: string;
  readonly authors: readonly { readonly kind: 'device' | 'agent' }[];
}): boolean {
  if (TRASH_MOVES.has(version.summary.trim())) return false;
  return version.authors.some((author) => author.kind === 'agent');
}
