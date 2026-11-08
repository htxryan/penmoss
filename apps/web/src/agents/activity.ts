/** Agent activity's data and wording, apart from its components (T42, A561). */

/** One agent change, as a git notebook's agent activity lists it (#172, A920). */
export interface ActivityEntry {
  readonly id: number;
  readonly at: number;
  readonly actor: { readonly id: string; readonly label: string };
  readonly kinds: readonly string[];
  readonly summary: string;
  readonly undoneAt: number | null;
  readonly undoneBy: string | null;
}

/** What a git notebook's Undo said (#172, A920). */
export function gitUndoMessage(
  result:
    | { readonly ok: true; readonly alreadyUndone: boolean; readonly notice: string | null }
    | { readonly ok: false; readonly message: string },
  entry: ActivityEntry,
): string {
  if (!result.ok) return result.message;
  if (result.alreadyUndone) return 'That change was undone already.';
  return result.notice ?? `Undone: ${entry.summary}.`;
}
