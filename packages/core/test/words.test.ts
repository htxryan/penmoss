/** Counts in the apps' own words: one is singular, every other count plural. */
import { describe, expect, it } from 'vitest';
import { counted, formatBytes, pluralise, timeAgo } from '../src/words';

describe('formatBytes', () => {
  it('writes sizes in decimal units, one decimal under 10', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20_000_000)).toBe('20 MB');
    expect(formatBytes(196_725_760)).toBe('197 MB');
    expect(formatBytes(1_250_000_000)).toBe('1.3 GB');
  });

  it('moves up a unit rather than say 1,000 of one, and groups the largest', () => {
    expect(formatBytes(999_999)).toBe('1 MB');
    expect(formatBytes(9_960)).toBe('10 KB');
    expect(formatBytes(1_234_000_000_000_000)).toBe('1,234 TB');
    expect(formatBytes(-5)).toBe('0 B');
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-11-24T18:00:00Z');
  const zone = 'America/Chicago';
  it('says minutes and hours gone by, whole ones', () => {
    expect(timeAgo(now - 59_000, now, zone)).toBe('just now');
    expect(timeAgo(now - 60_000, now, zone)).toBe('1 min ago');
    expect(timeAgo(now - 119_000, now, zone)).toBe('1 min ago');
    expect(timeAgo(now - 59 * 60_000, now, zone)).toBe('59 min ago');
    expect(timeAgo(now - 3 * 3_600_000 - 59 * 60_000, now, zone)).toBe('3 h ago');
    expect(timeAgo(now + 5 * 60_000, now, zone)).toBe('just now');
  });

  it('gives the day after a day, with its year when not this one', () => {
    expect(timeAgo(now - 24 * 3_600_000, now, zone)).toBe('Nov 23');
    expect(timeAgo(Date.parse('2024-03-02T18:00:00Z'), now, zone)).toBe('Mar 2, 2024');
    // The day is the zone's: 03:00 UTC on 1 Jan is still 31 Dec in Chicago.
    expect(timeAgo(Date.parse('2026-01-01T03:00:00Z'), now, zone)).toBe('Dec 31, 2025');
  });
});

describe('counted and pluralise', () => {
  it('says one in the singular and every other count, 0 included, in the plural', () => {
    expect(counted(1, 'note')).toBe('1 note');
    expect(counted(0, 'note')).toBe('0 notes');
    expect(counted(2, 'note')).toBe('2 notes');
    expect(counted(-1, 'day')).toBe('-1 days');
  });

  it('takes an irregular plural, and a phrase that agrees with its count', () => {
    expect(counted(1, 'copy', 'copies')).toBe('1 copy');
    expect(counted(3, 'copy', 'copies')).toBe('3 copies');
    expect(counted(1, 'note was', 'notes were')).toBe('1 note was');
    expect(counted(4, 'note was', 'notes were')).toBe('4 notes were');
    expect(counted(2, 'Agent Copy', 'Agent Copies')).toBe('2 Agent Copies');
  });

  it('writes the number as it is, without grouping', () => {
    expect(counted(12_345, 'note')).toBe('12,345 notes');
    expect(`${(12_345).toLocaleString('en-GB')} ${pluralise(12_345, 'note')}`).toBe('12,345 notes');
  });

  it('gives the word alone', () => {
    expect(pluralise(1, 'link')).toBe('link');
    expect(pluralise(7, 'link')).toBe('links');
    expect(pluralise(1, 'it', 'them')).toBe('it');
    expect(pluralise(2, 'it', 'them')).toBe('them');
  });
});
