/**
 * How long a tooltip waits (PEN-70, A-NEW-1, amends A189): the mouse pointer rests on a control
 * this long before its tooltip shows, as Settings → Display → Show Tooltips After says. One
 * synced per-user setting, like the rest of Display (A576, A1134), so the choice follows the
 * user to every device:
 *
 * - `tooltip.delay`: 500, 1000, 1500 or 2000 (milliseconds), or `"never"` for no tooltip on
 *   hover. Unset, or any other value (an older or newer client's), is the default, 1000.
 *
 * Keyboard focus shows a tooltip at once whatever it says. The Mac app and the web read it;
 * Android has no hover and ignores it.
 */

export const TOOLTIP_DELAY_SETTING = 'tooltip.delay';

/** The wait when the setting is unset or unknown. */
export const DEFAULT_TOOLTIP_DELAY_MS = 1000;

/** What `tooltip.delay` stores for Never. */
export const TOOLTIP_NEVER = 'never';

export type TooltipDelayChoice = 500 | 1000 | 1500 | 2000 | typeof TOOLTIP_NEVER;

/** The choices, in the order Settings → Display offers them, each with its name. */
export const TOOLTIP_DELAY_CHOICES: ReadonlyArray<{
  readonly value: TooltipDelayChoice;
  readonly label: string;
}> = [
  { value: 500, label: '0.5 Seconds' },
  { value: 1000, label: '1 Second (Default)' },
  { value: 1500, label: '1.5 Seconds' },
  { value: 2000, label: '2 Seconds' },
  { value: TOOLTIP_NEVER, label: 'Never' },
];

const isChoice = (value: unknown): value is TooltipDelayChoice =>
  TOOLTIP_DELAY_CHOICES.some((choice) => choice.value === value);

/** The choice the settings hold: the default for unset or anything unknown. */
export function tooltipDelayChoice(
  settings: Readonly<Record<string, unknown>>,
): TooltipDelayChoice {
  const value = settings[TOOLTIP_DELAY_SETTING];
  return isChoice(value) ? value : DEFAULT_TOOLTIP_DELAY_MS;
}

/** How long, in milliseconds, the pointer rests before a tooltip shows; null for Never. */
export function tooltipDelay(settings: Readonly<Record<string, unknown>>): number | null {
  const choice = tooltipDelayChoice(settings);
  return choice === TOOLTIP_NEVER ? null : choice;
}
