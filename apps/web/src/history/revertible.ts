/**
 * Which versions in History offer Revert (T21, T42, N7, A574; every writer's since A1575). Revert
 * takes back what one version changed and keeps later edits, whoever made it: an agent, this Mac
 * or a phone. Moving a note to Trash or restoring it also cuts a version (named "Moved to Trash"
 * or "Restored from Trash"), but there is no edit of the text to take back: Trash and its Restore
 * undo those, so they offer Restore This Version only.
 */
const TRASH_MOVES = new Set(['Moved to Trash', 'Restored from Trash']);

export function revertible(version: { readonly summary: string }): boolean {
  return !TRASH_MOVES.has(version.summary.trim());
}
