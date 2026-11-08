import { plainDate } from '@penmoss/core/periodic';
import { describe, expect, it } from 'vitest';
import { cellKey, cellMonth, dayCell, moveCell, weekCell } from '../../src/journal/calendar-keys';

// T39 pass 2 (A523): the sidebar calendar is one Tab stop, moved around with the keys.
const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return dayCell(plainDate(y, m, d));
};
const key = (from: ReturnType<typeof day>, k: string) => {
  const to = moveCell(from, k);
  return to ? cellKey(to) : null;
};

describe('calendar keys', () => {
  it('moves by a day and a week, across months', () => {
    expect(key(day('2026-10-24'), 'ArrowRight')).toBe('d:2026-10-25');
    expect(key(day('2026-10-31'), 'ArrowRight')).toBe('d:2026-11-01');
    expect(key(day('2026-10-24'), 'ArrowUp')).toBe('d:2026-10-17');
    expect(key(day('2026-10-28'), 'ArrowDown')).toBe('d:2026-11-04');
    expect(key(day('2026-10-24'), 'ArrowLeft')).toBe('d:2026-10-23');
  });

  it('reaches the week number left of Monday, and Monday right of it', () => {
    // 19 October 2026 is a Monday.
    expect(key(day('2026-10-19'), 'ArrowLeft')).toBe('w:2026-10-19');
    expect(key(weekCell(plainDate(2026, 10, 19)), 'ArrowRight')).toBe('d:2026-10-19');
    expect(key(weekCell(plainDate(2026, 10, 19)), 'ArrowDown')).toBe('w:2026-10-26');
    expect(key(weekCell(plainDate(2026, 10, 19)), 'ArrowLeft')).toBe('w:2026-10-19');
  });

  it('goes to the week’s ends with Home and End, and a month away with Page keys', () => {
    expect(key(day('2026-10-22'), 'Home')).toBe('d:2026-10-19');
    expect(key(day('2026-10-22'), 'End')).toBe('d:2026-10-25');
    expect(key(day('2026-10-24'), 'PageDown')).toBe('d:2026-11-24');
    // A shorter month takes its last day.
    expect(key(day('2026-01-31'), 'PageDown')).toBe('d:2026-02-28');
    expect(key(day('2024-03-31'), 'PageUp')).toBe('d:2024-02-29');
    expect(key(day('2026-01-15'), 'PageUp')).toBe('d:2025-12-15');
  });

  it('leaves other keys alone', () => {
    expect(moveCell(day('2026-10-24'), 'Enter')).toBeNull();
    expect(moveCell(day('2026-10-24'), 'a')).toBeNull();
  });

  it('files a week under the month of its Thursday', () => {
    // The week of Monday 28 September 2026 has its Thursday on 1 October.
    expect(cellMonth(weekCell(plainDate(2026, 9, 30)))).toEqual({ year: 2026, month: 10 });
  });
});
