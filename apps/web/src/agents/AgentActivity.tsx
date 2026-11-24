import { Icon } from '@penmoss/ui/icons';
import { shortWhen } from '../shell/when';
import type { NotebookActivity } from '../sources/agent-activity-list';

/**
 * The list (T42, A561; Settings → Agent Activity, PEN-146): newest first, each change with the
 * agent that made it (✦), its notebook, when, and Undo, or who undid it (a git notebook's, #172,
 * A920). The page says what an empty list means; this draws one with something in it.
 */
export function ActivityList({
  items,
  busy,
  canUndo,
  onUndo,
}: {
  readonly items: readonly NotebookActivity[];
  /** An Undo is under way: every Undo waits for it. */
  readonly busy: boolean;
  /** Whether a change not yet undone offers Undo (its notebook is still on this Mac). */
  readonly canUndo: (item: NotebookActivity) => boolean;
  readonly onUndo: (item: NotebookActivity) => void;
}) {
  return (
    <ul className="trash-list" aria-label="Agent Activity" data-testid="agent-activity-list">
      {items.map((item) => {
        const { entry } = item;
        const label = `agent-activity-${item.notebookId}-${entry.id}`;
        return (
          <li
            key={`${item.notebookId}:${entry.id}`}
            className="trash-item"
            data-activity-id={entry.id}
            data-notebook-id={item.notebookId}
            data-undone={entry.undoneAt ? 'true' : undefined}
          >
            <div className="trash-info">
              <span className="trash-title" id={label}>
                {entry.summary}
              </span>
              <span className="muted">
                ✦ {entry.actor.label} · {item.notebook} · {shortWhen(entry.at)}
                {entry.undoneAt
                  ? ` · Undone${entry.undoneBy ? ` by ${entry.undoneBy}` : ''} ${shortWhen(entry.undoneAt)}`
                  : ''}
              </span>
            </div>
            {entry.undoneAt || !canUndo(item) ? null : (
              <div className="trash-actions">
                <button
                  data-event="settings.agent-activity.undo"
                  type="button"
                  className="btn"
                  data-ui="item"
                  disabled={busy}
                  aria-describedby={label}
                  onClick={() => onUndo(item)}
                >
                  <Icon name="undo" />
                  Undo
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
