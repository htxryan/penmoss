import { Icon, type IconName } from '@penmoss/ui/icons';

/** One choice of a segmented control. */
export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** An icon before the label (Mode's System, Light and Dark). */
  readonly icon?: IconName;
  /** The id of help this choice alone is described by. */
  readonly describedBy?: string;
}

/**
 * The segmented control (`.seg`, theme.css): one radio per choice, its label bold when chosen
 * without the row moving (`bold-steady`). Named by `labelledBy` or `label`, it is its own
 * radiogroup; with neither, a fieldset around it is the group (and can disable it).
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  event,
  onChange,
  labelledBy,
  label,
  testId,
}: {
  /** The radios' name, unique in the page (from `useId`). */
  readonly name: string;
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  /** Each radio's `data-event`. */
  readonly event: string;
  readonly onChange: (value: T) => void;
  readonly labelledBy?: string;
  readonly label?: string;
  readonly testId?: string;
}) {
  const named = labelledBy !== undefined || label !== undefined;
  return (
    <div
      className="seg"
      role={named ? 'radiogroup' : undefined}
      aria-labelledby={labelledBy}
      aria-label={label}
      data-testid={testId}
    >
      {options.map((option) => (
        <label key={option.value} className="seg-option">
          <input
            type="radio"
            name={name}
            data-event={event}
            value={option.value}
            checked={value === option.value}
            aria-describedby={option.describedBy}
            onChange={() => onChange(option.value)}
          />
          {option.icon ? <Icon name={option.icon} size={14} /> : null}
          <span className="bold-steady" data-label={option.label}>
            {option.label}
          </span>
        </label>
      ))}
    </div>
  );
}
