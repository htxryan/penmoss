/** Counts in the apps' own words: one is singular, every other count plural. */
import { describe, expect, it } from 'vitest';
import { counted, pluralise } from '../src/words';

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
    expect(counted(12_345, 'note')).toBe('12345 notes');
    expect(`${(12_345).toLocaleString('en-GB')} ${pluralise(12_345, 'note')}`).toBe('12,345 notes');
  });

  it('gives the word alone', () => {
    expect(pluralise(1, 'link')).toBe('link');
    expect(pluralise(7, 'link')).toBe('links');
    expect(pluralise(1, 'it', 'them')).toBe('it');
    expect(pluralise(2, 'it', 'them')).toBe('them');
  });
});
