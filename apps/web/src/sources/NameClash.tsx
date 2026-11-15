/**
 * A name another notebook on this Mac has (Ryan's review of PR #192): says another notebook here
 * is named `other` already (`name`, ignoring case), and offers `suggestion`. `onKeep`, when given,
 * is the way to use the name anyway (Rename asks before it renames).
 */
export function NameClash({
  name,
  other,
  suggestion,
  onUse,
  onKeep,
  onCancel,
}: {
  readonly name: string;
  readonly other: string;
  readonly suggestion: string;
  readonly onUse: (name: string) => void;
  readonly onKeep?: () => void;
  readonly onCancel?: () => void;
}) {
  return (
    <div className="name-clash" role="alert" data-testid="notebook-name-clash">
      <p>
        Another notebook on this Mac is named “{other}”, so agents can’t tell them apart by name.
        Try “{suggestion}”.
      </p>
      <div className="name-clash-actions">
        <button
          type="button"
          className="btn primary"
          data-ui="item"
          data-testid="notebook-name-clash-use"
          onClick={() => onUse(suggestion)}
        >
          Use “{suggestion}”
        </button>
        {onKeep ? (
          <button
            type="button"
            className="btn"
            data-ui="item"
            data-testid="notebook-name-clash-keep"
            onClick={onKeep}
          >
            Keep “{name}”
          </button>
        ) : null}
        {onCancel ? (
          <button type="button" className="btn" data-ui="item" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
