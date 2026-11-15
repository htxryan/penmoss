/** The folder tree's rows in the page: each is an element with its row's key as `data-key`. */

/** The row element an event came from (null: the tree's empty space). */
export const rowElement = (event: { target: EventTarget }) =>
  (event.target as HTMLElement).closest<HTMLElement>('[data-key]');

/** The row element with `key` in `tree`. */
export function findRow(tree: HTMLElement | null, key: string): HTMLElement | null {
  return tree?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) ?? null;
}
