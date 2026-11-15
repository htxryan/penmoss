/**
 * Pieces of History (T21) the Time Machine shows too (PEN-21): who made a change, as a chip per
 * writer (✦ for an agent), and a line diff with the added and removed lines marked.
 */
import type { DiffOp } from '@penmoss/core/diff';
import { Icon } from '@penmoss/ui/icons';
import type { CSSProperties } from 'react';
import { diffRows } from './diff-rows';
import { authorName } from './format';
import type { HistoryAuthor } from './source';

type Author = HistoryAuthor;

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
 * are folded. `numbered` adds a gutter of line numbers (History's docked preview, R2-13), drawn by
 * CSS from `data-n`: never selected or copied with the text, and not read out.
 */
export function DiffLines({
  diff,
  numbered = false,
}: {
  diff: readonly DiffOp[];
  numbered?: boolean;
}) {
  const rows = diffRows(diff);
  // The gutter is as wide as the longest number, in either version.
  const digits = String(Math.max(1, diff.length)).length;
  return (
    <pre
      data-numbered={numbered ? '' : undefined}
      style={numbered ? ({ '--diff-digits': digits } as CSSProperties) : undefined}
    >
      {rows.map((row, i) =>
        row.op === 'fold' ? (
          <span key={i} className="diff-fold">
            ⋯ {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
            {numbered ? (
              <span
                className="diff-fold-lines"
                aria-hidden="true"
                data-n={row.from === row.to ? `${row.from}` : `${row.from}–${row.to}`}
              />
            ) : null}
            {'\n'}
          </span>
        ) : (
          <span key={i} className={`diff-${row.op}`} data-op={row.op}>
            {numbered ? (
              <>
                <span className="diff-num" aria-hidden="true" data-n={row.n} />
                {/* The mark and the text in one cell, so a selection copies them as one line. */}
                <span className="diff-line">
                  <Line row={row} />
                </span>
              </>
            ) : (
              <Line row={row} />
            )}
            {'\n'}
          </span>
        ),
      )}
    </pre>
  );
}
