import { TOOLTIP_DELAY_CHOICES } from '@penmoss/core/tooltips';
import { Select } from '@penmoss/ui/controls/Select';
import { useId } from 'react';
import { SettingRow } from '../theme/look-rows';
import { useTooltipDelay } from './tooltip-state';

/**
 * Show Tooltips After (PEN-70, A1247): how long the mouse rests on a control before its
 * tooltip shows, or Never. Keyboard focus shows a tooltip at once whatever it says. Synced. A row
 * of Settings → Appearance → Text since PEN-146; it was on Display.
 */
export function TooltipDelaySetting() {
  const { choice, set, canChange } = useTooltipDelay();
  const id = useId();
  return (
    <SettingRow
      setting="show-tooltips-after"
      label="Show Tooltips After"
      labelFor={id}
      help={
        <span data-testid="tooltip-delay-help">
          How long the pointer rests on a button before its name shows. Tabbing to a button shows it
          at once.
        </span>
      }
      helpId={`${id}-help`}
      testId="tooltip-delay-setting"
    >
      <Select
        id={id}
        className="settings-choice"
        value={String(choice)}
        disabled={!canChange}
        aria-describedby={`${id}-help`}
        data-testid="tooltip-delay"
        onChange={(event) => {
          const picked = TOOLTIP_DELAY_CHOICES.find(
            (each) => String(each.value) === event.target.value,
          );
          if (picked) set(picked.value);
        }}
      >
        {TOOLTIP_DELAY_CHOICES.map(({ value, label }) => (
          <option key={value} value={String(value)}>
            {label}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}
