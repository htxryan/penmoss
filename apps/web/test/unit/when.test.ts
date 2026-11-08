import { describe, expect, it } from 'vitest';
import { shortWhen } from '../../src/shell/when';

describe('shortWhen (T39)', () => {
  const now = new Date(2026, 9, 24, 12, 0).getTime();

  it('shows the month, day and time, without seconds', () => {
    const text = shortWhen(new Date(2026, 9, 24, 5, 52, 8).getTime(), now);
    expect(text).toContain('Oct');
    expect(text).toContain('24');
    expect(text).not.toContain(':08');
    expect(text).not.toContain('2026');
  });

  it('adds the year for another year', () => {
    expect(shortWhen(new Date(2025, 0, 2, 9, 0).getTime(), now)).toContain('2025');
  });

  it('says never for no time', () => {
    expect(shortWhen(null, now)).toBe('never');
    expect(shortWhen(0, now)).toBe('never');
  });
});
