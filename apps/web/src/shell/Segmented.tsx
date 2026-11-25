import { Icon, type IconName } from '@penmoss/ui/icons';
import type { Ref } from 'react';

/** One choice of a segmented control. */
export interface SegmentedOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  /** An icon before the label (Mode's System, Light and Dark). */
  readonly icon?: IconName;
  /** The id of help this choice alone is described by. */
  readonly describedBy?: string;
  /** This choice's radio's `data-testid`. */
  readonly testId?: string;
}

/**
 * The segmented control (`.seg`, theme.css), the app's one: one radio per choice, its label bold
 * when chosen without the row moving (`bold-steady`). Named by `labelledBy` or `label`, it is its
 * own radiogroup; with neither, a fieldset around it is the group (and can disable it). Nothing
 * is chosen while `value` is null (Send Feedback's Type and Priority until picked).
 */
export function Segmented<T extends string | number>({
  name,
  value,
  options,
  event,
  onChange,
  labelledBy,
  label,
  testId,
  invalid,
  firstRef,
}: {
  /** The radios' name, unique in the page (from `useId`). */
  readonly name: string;
  readonly value: T | null;
  readonly options: readonly SegmentedOption<T>[];
  /** Each radio's `data-event`. */
  readonly event: string;
  readonly onChange: (value: T) => void;
  readonly labelledBy?: string;
  readonly label?: string;
  readonly testId?: string;
  /** A choice is still to be made (a form refused it): the control is framed in red. */
  readonly invalid?: boolean;
  /** The first radio, for a form to move focus to. */
  readonly firstRef?: Ref<HTMLInputElement>;
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
      {options.map((option, index) => (
        <label key={option.value} className="seg-option">
          <input
            ref={index === 0 ? firstRef : undefined}
            type="radio"
            name={name}
            data-event={event}
            data-testid={option.testId}
            value={option.value}
            checked={value === option.value}
            aria-invalid={invalid ? true : undefined}
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
