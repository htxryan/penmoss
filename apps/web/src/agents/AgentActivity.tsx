import { Icon } from '@penmoss/ui/icons';
import { shortWhen } from '../shell/when';
import type { ActivityEntry } from './activity';

/**
 * The list (T42, A561): newest first, each change with the agent that made it (✦), when, and
 * Undo, or who undid it (a git notebook's, #172, A920).
 */
export function ActivityList({
  entries,
  busy,
  onUndo,
  empty = 'No agent has moved notes or changed folders, settings or tags in the last 30 days.',
}: {
  readonly entries: readonly ActivityEntry[];
  readonly busy: number | null;
  readonly onUndo: (entry: ActivityEntry) => void;
  /** What an empty list says (a git notebook's lists no tags: those are in History). */
  readonly empty?: string;
}) {
  if (entries.length === 0) {
    return (
      <p className="muted" data-testid="agent-activity-empty">
        {empty}
      </p>
    );
  }
  return (
    <ul className="trash-list" aria-label="Agent activity" data-testid="agent-activity-list">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="trash-item"
          data-activity-id={entry.id}
          data-undone={entry.undoneAt ? 'true' : undefined}
        >
          <div className="trash-info">
            <span className="trash-title" id={`agent-activity-${entry.id}`}>
              {entry.summary}
            </span>
            <span className="muted">
              ✦ {entry.actor.label} · {shortWhen(entry.at)}
              {entry.undoneAt
                ? ` · Undone${entry.undoneBy ? ` by ${entry.undoneBy}` : ''} ${shortWhen(entry.undoneAt)}`
                : ''}
            </span>
          </div>
          {entry.undoneAt ? null : (
            <div className="trash-actions">
              <button
                type="button"
                className="btn"
                data-ui="item"
                disabled={busy !== null}
                aria-describedby={`agent-activity-${entry.id}`}
                onClick={() => onUndo(entry)}
              >
                <Icon name="undo" />
                Undo
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
