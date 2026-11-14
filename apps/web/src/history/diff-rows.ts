import type { DiffOp } from '@penmoss/core/diff';

/** Unchanged lines kept around each change in the diff. */
const CONTEXT = 2;

/** A line of the diff as shown: its number in this version, or the version before's if removed. */
export type DiffRow = DiffOp & { readonly n: number };
/** A run of unchanged lines folded away: how many, and this version's numbers for them. */
export interface DiffFold {
  readonly op: 'fold';
  readonly count: number;
  readonly from: number;
  readonly to: number;
}

/**
 * The diff with long unchanged runs folded, as rows to render, each line numbered (Ryan's review
 * of #193, R2-13): this version's number on an unchanged or added line, the version before's on a
 * removed one. The folded lines are counted too, so the numbers run on across a fold.
 */
export function diffRows(diff: readonly DiffOp[]): Array<DiffRow | DiffFold> {
  const rows: Array<DiffRow | DiffFold> = [];
  const changed = diff.map((op) => op.op !== 'same');
  const near = (i: number) => {
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(diff.length - 1, i + CONTEXT); j++) {
      if (changed[j]) return true;
    }
    return false;
  };
  /** The last line numbered so far, in this version and in the one before. */
  let now = 0;
  let before = 0;
  let folded = 0;
  const close = () => {
    if (folded > 0) rows.push({ op: 'fold', count: folded, from: now - folded + 1, to: now });
    folded = 0;
  };
  diff.forEach((op, i) => {
    const folds = op.op === 'same' && !near(i);
    if (!folds) close();
    if (op.op !== 'del') now++;
    if (op.op !== 'add') before++;
    if (folds) folded++;
    else rows.push({ ...op, n: op.op === 'del' ? before : now });
  });
  close();
  return rows;
}
