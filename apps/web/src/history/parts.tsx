/**
 * Pieces of History (T21): who made a change, and a line diff with the added and removed lines
 * marked.
 */
import type { DiffOp } from '@penmoss/core/diff';
import { Icon } from '@penmoss/ui/icons';
import type { CSSProperties } from 'react';
import { diffRows } from './diff-rows';
import { authorName } from './format';
import type { HistoryAuthor } from './source';
import { pluralise } from '@penmoss/core/words';

type Author = HistoryAuthor;

/** The icon for a writer: ✦ for an agent, a phone for an Android device, else a laptop. */
const authorIcon = (author: Author | undefined) =>
  author?.kind === 'agent'
    ? 'agentRef'
    : /android|phone/i.test(author?.label ?? '')
      ? 'phone'
      : 'laptop';

/**
 * Who made a version, as History's one-line rows show it (Ryan's review of #192, finding 13): the
 * first writer's icon, their names in a tooltip on hover, and in words for screen readers.
 */
export function AuthorMark({ authors }: { authors: readonly Author[] }) {
  const names = authors.map(authorName).join(', ');
  const first = authors[0];
  return (
    <span
      className="history-who"
      data-kind={first?.kind ?? 'device'}
      data-tip={names || undefined}
      data-tip-on="hover"
    >
      <Icon name={authorIcon(first)} size={14} />
      <span className="sr-only">{names}</span>
    </span>
  );
}

/** A diff line's mark (`+`, `−` or a space) and its text. */
function Line({ row }: { row: DiffOp }) {
  return (
    <>
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
    </>
  );
}

/**
 * A line diff as History shows it: `+` and `−` on the added and removed lines. Long unchanged runs
 * are folded. A gutter of line numbers (History's docked preview, R2-13) is drawn by CSS from
 * `data-n`: never selected or copied with the text, and not read out.
 */
export function DiffLines({ diff }: { diff: readonly DiffOp[] }) {
  const rows = diffRows(diff);
  // The gutter is as wide as the longest number, in either version.
  const digits = String(Math.max(1, diff.length)).length;
  return (
    <pre data-numbered="" style={{ '--diff-digits': digits } as CSSProperties}>
      {rows.map((row, i) =>
        row.op === 'fold' ? (
          <span key={i} className="diff-fold">
            ⋯ {row.count} unchanged {pluralise(row.count, 'line')}
            <span
              className="diff-fold-lines"
              aria-hidden="true"
              data-n={row.from === row.to ? `${row.from}` : `${row.from}–${row.to}`}
            />
            {'\n'}
          </span>
        ) : (
          <span key={i} className={`diff-${row.op}`} data-op={row.op}>
            <span className="diff-num" aria-hidden="true" data-n={row.n} />
            {/* The mark and the text in one cell, so a selection copies them as one line. */}
            <span className="diff-line">
              <Line row={row} />
            </span>
            {'\n'}
          </span>
        ),
      )}
    </pre>
  );
}
