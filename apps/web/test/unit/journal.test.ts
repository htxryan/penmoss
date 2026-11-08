import { DEFAULT_DAILY_TEMPLATE, DEFAULT_WEEKLY_TEMPLATE } from '@penmoss/core/periodic';
import { describe, expect, it } from 'vitest';
import { templateOf, thisWeek, timeZoneOf, today } from '../../src/journal/journal';

// T19: the day and week come from the synced time zone setting, never the device's zone.
describe('journal settings', () => {
  // 03:30 UTC on 22 October: still the 21st in Chicago, already the 22nd in Tokyo.
  const now = new Date('2026-10-22T03:30:00Z');

  it('uses America/Chicago until a time zone is set', () => {
    expect(timeZoneOf({})).toBe('America/Chicago');
    expect(today({}, now).toString()).toBe('2026-10-21');
  });

  it('follows the time zone setting, and ignores one this browser does not know', () => {
    expect(today({ timeZone: 'Asia/Tokyo' }, now).toString()).toBe('2026-10-22');
    expect(timeZoneOf({ timeZone: 'Mars/Olympus' })).toBe('America/Chicago');
    expect(timeZoneOf({ timeZone: 42 })).toBe('America/Chicago');
  });

  it('names the ISO week of today in that zone', () => {
    // Sunday 1 November 2026 is in week 44; Monday the 2nd starts week 45.
    const sundayNight = new Date('2026-11-02T03:00:00Z');
    expect(thisWeek({}, sundayNight)).toBe('2026-W44');
    expect(thisWeek({ timeZone: 'Europe/Berlin' }, sundayNight)).toBe('2026-W45');
  });

  it('uses the saved template, the empty one included, or the default', () => {
    expect(templateOf({}, 'daily')).toBe(DEFAULT_DAILY_TEMPLATE);
    expect(templateOf({}, 'weekly')).toBe(DEFAULT_WEEKLY_TEMPLATE);
    expect(templateOf({ 'template.daily': '# {{date}}\n' }, 'daily')).toBe('# {{date}}\n');
    expect(templateOf({ 'template.weekly': '' }, 'weekly')).toBe('');
  });
});
