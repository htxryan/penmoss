import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOLTIP_DELAY_MS,
  TOOLTIP_DELAY_CHOICES,
  TOOLTIP_DELAY_SETTING,
  tooltipDelay,
  tooltipDelayChoice,
} from '../src/tooltips';

// PEN-70 (A-NEW-1): Settings → Display → Show Tooltips After, the synced `tooltip.delay`.

const delayOf = (value: unknown) => tooltipDelay({ [TOOLTIP_DELAY_SETTING]: value });

describe('tooltip delay (PEN-70)', () => {
  it('offers the choices in order, 1 second the default', () => {
    expect(TOOLTIP_DELAY_SETTING).toBe('tooltip.delay');
    expect(TOOLTIP_DELAY_CHOICES.map((choice) => choice.label)).toEqual([
      '0.5 Seconds',
      '1 Second (Default)',
      '1.5 Seconds',
      '2 Seconds',
      'Never',
    ]);
    expect(DEFAULT_TOOLTIP_DELAY_MS).toBe(1000);
  });

  it('waits 1000 ms when unset', () => {
    expect(tooltipDelay({})).toBe(1000);
    expect(tooltipDelayChoice({})).toBe(1000);
  });

  it('reads each choice', () => {
    expect(delayOf(500)).toBe(500);
    expect(delayOf(1000)).toBe(1000);
    expect(delayOf(1500)).toBe(1500);
    expect(delayOf(2000)).toBe(2000);
    expect(delayOf('never')).toBeNull();
    expect(tooltipDelayChoice({ [TOOLTIP_DELAY_SETTING]: 'never' })).toBe('never');
  });

  it('reads anything else as the default (AC9)', () => {
    for (const value of [0, 400, 750, 3000, -1, '1000', 'Never', true, null, [], {}, NaN]) {
      expect(delayOf(value), JSON.stringify(value)).toBe(1000);
      expect(tooltipDelayChoice({ [TOOLTIP_DELAY_SETTING]: value }), JSON.stringify(value)).toBe(
        1000,
      );
    }
  });
});
