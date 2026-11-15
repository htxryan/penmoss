/**
 * The icon picker's grid (A1568), as rows: each section's heading, then its items a row of
 * `columns` at a time. Only the rows in view are drawn (`rowsInView`), so all of Lucide's icons
 * or every emoji scroll as fast as twenty. The arrow keys move through the items as they are
 * laid out: ← → along the items, ↑ ↓ to the same column of the row above or below, across
 * sections.
 */
/** "notebook-pen" and "flag: united states" as "Notebook Pen" and "Flag: United States". */
export function cellLabel(name: string): string {
  return name
    .replace(/-/g, ' ')
    .replace(/(^|\s)(\S)/g, (_, space: string, first: string) => space + first.toUpperCase());
}

export interface GridSection<T> {
  /** Its heading (Recently Used, Smileys and Emotion), or null for none. */
  readonly label: string | null;
  readonly items: readonly T[];
}

export type GridRow<T> =
  | { readonly kind: 'head'; readonly label: string; readonly top: number }
  | {
      readonly kind: 'items';
      /** The index of its first item among all the grid's items. */
      readonly first: number;
      readonly items: readonly T[];
      readonly top: number;
    };

export interface GridLayout<T> {
  readonly rows: readonly GridRow<T>[];
  /** Every item, in order: what the keys move through. */
  readonly items: readonly T[];
  /** For each item, its row in `rows` and its column. */
  readonly places: ReadonlyArray<{ readonly row: number; readonly column: number }>;
  readonly height: number;
}

/** Heights in pixels: a heading's row and an items row (the cell's size). */
export interface GridMetrics {
  readonly head: number;
  readonly cell: number;
}

export function gridLayout<T>(
  sections: readonly GridSection<T>[],
  columns: number,
  metrics: GridMetrics,
): GridLayout<T> {
  const across = Math.max(1, Math.floor(columns));
  const rows: GridRow<T>[] = [];
  const items: T[] = [];
  const places: Array<{ row: number; column: number }> = [];
  let top = 0;
  for (const section of sections) {
    if (section.items.length === 0) continue;
    if (section.label !== null) {
      rows.push({ kind: 'head', label: section.label, top });
      top += metrics.head;
    }
    for (let at = 0; at < section.items.length; at += across) {
      const slice = section.items.slice(at, at + across);
      slice.forEach((_, column) => places.push({ row: rows.length, column }));
      rows.push({ kind: 'items', first: items.length, items: slice, top });
      items.push(...slice);
      top += metrics.cell;
    }
  }
  return { rows, items, places, height: top };
}

/** The rows that show in a viewport `[top, top + height)`, with `overscan` pixels either side. */
export function rowsInView<T>(
  layout: GridLayout<T>,
  top: number,
  height: number,
  metrics: GridMetrics,
  overscan = 160,
): readonly GridRow<T>[] {
  const from = top - overscan;
  const to = top + height + overscan;
  return layout.rows.filter((row) => {
    const bottom = row.top + (row.kind === 'head' ? metrics.head : metrics.cell);
    return bottom > from && row.top < to;
  });
}

/** Where a key moves the active item (null: the key is not the grid's). */
export function gridStep<T>(
  layout: GridLayout<T>,
  active: number,
  key: string,
  page = 5,
): number | null {
  const count = layout.items.length;
  if (count === 0) return null;
  const at = Math.min(Math.max(active, 0), count - 1);
  if (key === 'ArrowRight') return Math.min(at + 1, count - 1);
  if (key === 'ArrowLeft') return Math.max(at - 1, 0);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const vertical: Record<string, number> = {
    ArrowDown: 1,
    ArrowUp: -1,
    PageDown: page,
    PageUp: -page,
  };
  const step = vertical[key];
  if (step === undefined) return null;
  const { row, column } = layout.places[at]!;
  // The items rows, so a heading between sections is passed over.
  const itemRows = layout.rows
    .map((each, index) => ({ each, index }))
    .filter(({ each }) => each.kind === 'items');
  const here = itemRows.findIndex(({ index }) => index === row);
  const target = itemRows[Math.min(Math.max(here + step, 0), itemRows.length - 1)]!.each;
  if (target.kind !== 'items') return at;
  return target.first + Math.min(column, target.items.length - 1);
}
