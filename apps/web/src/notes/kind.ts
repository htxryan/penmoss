/**
 * The label a periodic note carries in the Info panel (T42, A572); an ordinary note has none,
 * since "Kind: Note" told Ryan nothing. Unknown kinds show nothing either.
 */
export function kindLabel(kind: unknown): string | null {
  return kind === 'daily' ? 'Daily note' : kind === 'weekly' ? 'Weekly note' : null;
}
