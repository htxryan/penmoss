/**
 * Titles inside the apps' own words (A855, #170 F11, #174 review): cleaned of control, bidi and
 * format characters, emoji sequences kept whole, and cut without splitting a character.
 */
import { describe, expect, it } from 'vitest';
import { cleanTitle, isolatedTitle } from '../src/titles';

describe('cleanTitle and isolatedTitle', () => {
  it('keeps emoji sequences whole and takes out a joiner anywhere else', () => {
    const scotland = '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    expect(cleanTitle(`Plan 👨\u200D👩\u200D👧 ${scotland}`)).toBe(
      `Plan 👨\u200D👩\u200D👧 ${scotland}`,
    );
    expect(cleanTitle('Sha\u200Dlom\u202E notes')).toBe('Sha lom notes');
    expect(isolatedTitle('\u202E\u200B\u200D')).toBeNull();
  });

  it('never cuts a surrogate pair in half', () => {
    const title = `${'a'.repeat(58)}😀😀`;
    const cut = cleanTitle(title, 60)!;
    expect(cut).toBe(`${'a'.repeat(58)}…`);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut)).toBe(false);
    expect(isolatedTitle(title, 60)).toBe(`\u2068${'a'.repeat(58)}…\u2069`);
  });
});
