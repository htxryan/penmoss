import { describe, expect, it } from 'vitest';
import { thisWeek, today } from '../../src/journal/journal';

// T19: the day and week come from the synced time zone setting, never the device's zone.
describe('journal settings', () => {
  // 03:30 UTC on 22 October: still the 21st in Chicago, already the 22nd in Tokyo.
  const now = new Date('2026-10-22T03:30:00Z');

  it('uses America/Chicago until a time zone is set', () => {
    expect(today({}, now).toString()).toBe('2026-10-21');
  });

  it('follows the time zone setting, and ignores one this browser does not know', () => {
    expect(today({ timeZone: 'Asia/Tokyo' }, now).toString()).toBe('2026-10-22');
    expect(today({ timeZone: 'Mars/Olympus' }, now).toString()).toBe('2026-10-21');
  });

  it('names the ISO week of today in that zone', () => {
    // Sunday 1 November 2026 is in week 44; Monday the 2nd starts week 45.
    const sundayNight = new Date('2026-11-02T03:00:00Z');
    expect(thisWeek({}, sundayNight)).toBe('2026-W44');
    expect(thisWeek({ timeZone: 'Europe/Berlin' }, sundayNight)).toBe('2026-W45');
  });
});
