/**
 * The icon picker's grid (A1568): sections laid out a row of `columns` at a time under their
 * headings, only the rows in view drawn, and the arrow keys moving as the cells are laid out.
 */
import { describe, expect, it } from 'vitest';
import { cellLabel, gridLayout, gridStep, rowsInView } from '../../src/shell/icon-grid';

const METRICS = { cell: 40, head: 30 };
const letters = (count: number, from = 'a') =>
  Array.from({ length: count }, (_, at) => String.fromCharCode(from.charCodeAt(0) + at));

describe('gridLayout', () => {
  it('puts each section under its heading, a row of columns at a time', () => {
    const layout = gridLayout(
      [
        { label: 'Recently Used', items: letters(3) },
        { label: 'All Icons', items: letters(7, 'k') },
      ],
      4,
      METRICS,
    );
    expect(
      layout.rows.map((row) => (row.kind === 'head' ? row.label : row.items.join(''))),
    ).toEqual(['Recently Used', 'abc', 'All Icons', 'klmn', 'opq']);
    expect(layout.rows.map((row) => row.top)).toEqual([0, 30, 70, 100, 140]);
    expect(layout.height).toBe(180);
    expect(layout.items).toEqual([...letters(3), ...letters(7, 'k')]);
    expect(layout.places[4]).toEqual({ row: 3, column: 1 });
  });

  it('leaves out an empty section and its heading, and a section without a heading has none', () => {
    const layout = gridLayout(
      [
        { label: 'Recently Used', items: [] },
        { label: null, items: letters(2) },
      ],
      8,
      METRICS,
    );
    expect(layout.rows).toEqual([{ kind: 'items', first: 0, items: ['a', 'b'], top: 0 }]);
  });
});

describe('rowsInView', () => {
  it('draws only the rows in the viewport and its overscan', () => {
    const layout = gridLayout([{ label: null, items: letters(26 * 3) }], 1, METRICS);
    const shown = rowsInView(layout, 400, 200, METRICS, 0);
    expect(shown.map((row) => row.top)).toEqual([400, 440, 480, 520, 560]);
    expect(rowsInView(layout, 400, 200, METRICS, 40)).toHaveLength(7);
  });
});

describe('gridStep', () => {
  // Two sections: [a b c] then [k l m n / o p q] in rows of four.
  const layout = gridLayout(
    [
      { label: 'Recently Used', items: letters(3) },
      { label: 'All Icons', items: letters(7, 'k') },
    ],
    4,
    METRICS,
  );
  const at = (letter: string) => layout.items.indexOf(letter);
  const step = (from: string, key: string) => {
    const next = gridStep(layout, at(from), key);
    return next === null ? null : layout.items[next];
  };

  it('moves along the items with ← and →, stopping at the ends', () => {
    expect(step('b', 'ArrowRight')).toBe('c');
    expect(step('c', 'ArrowRight')).toBe('k');
    expect(step('k', 'ArrowLeft')).toBe('c');
    expect(step('a', 'ArrowLeft')).toBe('a');
    expect(step('q', 'ArrowRight')).toBe('q');
  });

  it('moves to the same column above or below with ↑ and ↓, across a heading', () => {
    expect(step('b', 'ArrowDown')).toBe('l');
    expect(step('l', 'ArrowDown')).toBe('p');
    expect(step('p', 'ArrowUp')).toBe('l');
    expect(step('l', 'ArrowUp')).toBe('b');
    // A shorter row below: its last cell.
    expect(step('n', 'ArrowDown')).toBe('q');
    expect(step('n', 'ArrowUp')).toBe('c');
    expect(step('a', 'ArrowUp')).toBe('a');
  });

  it('goes to the ends with Home and End, and a page of rows with Page Up and Down', () => {
    expect(step('m', 'Home')).toBe('a');
    expect(step('a', 'End')).toBe('q');
    expect(step('a', 'PageDown')).toBe('o');
    expect(step('p', 'PageUp')).toBe('b');
  });

  it('leaves other keys alone, and an empty grid', () => {
    expect(step('a', 'Enter')).toBeNull();
    expect(gridStep(gridLayout([], 4, METRICS), 0, 'ArrowDown')).toBeNull();
  });
});

describe('cellLabel', () => {
  it('names a cell in Title Case', () => {
    expect(cellLabel('notebook-pen')).toBe('Notebook Pen');
    expect(cellLabel('light bulb')).toBe('Light Bulb');
    expect(cellLabel('flag: united states')).toBe('Flag: United States');
  });
});
