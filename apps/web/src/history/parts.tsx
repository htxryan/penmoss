/**
 * Pieces of History (T21) the Time Machine shows too (PEN-21): who made a change, as a chip per
 * writer (✦ for an agent), and a line diff with the added and removed lines marked.
 */
import type { DiffOp } from '@penmoss/core/diff';
import type { HistoryAuthor } from './source';

type Author = HistoryAuthor;

/** Unchanged lines kept around each change in the diff. */
const CONTEXT = 2;

/** The diff with long unchanged runs folded, as rows to render. */
function diffRows(diff: readonly DiffOp[]): Array<DiffOp | { op: 'fold'; count: number }> {
  const rows: Array<DiffOp | { op: 'fold'; count: number }> = [];
  const changed = diff.map((op) => op.op !== 'same');
  const near = (i: number) => {
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(diff.length - 1, i + CONTEXT); j++) {
      if (changed[j]) return true;
    }
    return false;
  };
  let folded = 0;
  diff.forEach((op, i) => {
    if (op.op === 'same' && !near(i)) {
      folded++;
      return;
    }
    if (folded > 0) rows.push({ op: 'fold', count: folded });
    folded = 0;
    rows.push(op);
  });
  if (folded > 0) rows.push({ op: 'fold', count: folded });
  return rows;
}

export function Authors({ authors }: { authors: readonly Author[] }) {
  return (
    <span className="history-authors">
      {authors.map((author) => (
        <span key={author.id} className="history-author" data-kind={author.kind}>
          <span className="sr-only">{author.kind === 'agent' ? 'Agent' : 'Device'}: </span>
          {author.kind === 'agent' ? (
            <svg viewBox="0 0 16 16" aria-hidden="true" className="history-kind">
              <path d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true" className="history-kind">
              <rect x="2" y="3" width="12" height="8" rx="1.2" fill="none" stroke="currentColor" />
              <path d="M5.5 13.5h5" stroke="currentColor" />
            </svg>
          )}
          {author.label}
        </span>
      ))}
    </span>
  );
}

/**
 * A line diff as History shows it: `+` and `−` on the added and removed lines. Long unchanged runs
 * are folded.
 */
export function DiffLines({ diff }: { diff: readonly DiffOp[] }) {
  const rows = diffRows(diff);
  return (
    <pre>
      {rows.map((row, i) =>
        row.op === 'fold' ? (
          <span key={i} className="diff-fold">
            ⋯ {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
            {'\n'}
          </span>
        ) : (
          <span key={i} className={`diff-${row.op}`} data-op={row.op}>
            <span className="diff-sign" aria-hidden="true">
              {row.op === 'add' ? '+' : row.op === 'del' ? '−' : ' '}
            </span>
            {row.op === 'add' ? (
              <ins>{row.line}</ins>
            ) : row.op === 'del' ? (
              <del>{row.line}</del>
            ) : (
              row.line
            )}
            {'\n'}
          </span>
        ),
      )}
    </pre>
  );
}
