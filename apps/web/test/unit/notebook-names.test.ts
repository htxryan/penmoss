/**
 * Two notebooks of one name on this Mac (Ryan's review of PR #192): `--notebook "<name>"` can't
 * tell them apart, so adding or renaming to a name in use is warned about, with a free one.
 */
import { describe, expect, it } from 'vitest';
import { freeName, nameClash } from '../../src/sources/notebook-names';

describe('a notebook name in use on this Mac', () => {
  it('is found ignoring case and extra spaces, as the CLI matches names', () => {
    expect(nameClash('personal', ['Work', 'Personal'])).toBe('Personal');
    expect(nameClash('  Personal  ', ['Personal'])).toBe('Personal');
    expect(nameClash('Personal (old)', ['Personal'])).toBeNull();
    expect(nameClash('', ['Personal'])).toBeNull();
  });

  it('suggests “<name> (2)”, or the next number free', () => {
    expect(freeName('Personal', ['Personal'])).toBe('Personal (2)');
    expect(freeName('Personal', ['Personal', 'Personal (2)'])).toBe('Personal (3)');
    // A name that is already numbered counts on from its base.
    expect(freeName('Personal (2)', ['Personal', 'Personal (2)'])).toBe('Personal (3)');
    // Kept within the longest name a notebook may have.
    expect(freeName('x'.repeat(80), ['x'.repeat(80)])).toHaveLength(80);
  });
});
