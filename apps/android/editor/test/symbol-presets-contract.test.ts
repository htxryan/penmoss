/**
 * The symbol picker's preset glyphs (T51, A939): `contract/settings-v1.json`'s
 * `symbolGlyphPresets` is core's `SYMBOL_GLYPH_PRESETS` exactly, in its order, so the phone's
 * picker offers the web's. The Kotlin `SettingsContractTest` holds `LineSymbols.PRESET_GLYPHS`
 * to the same field.
 */
import { glyphProblem, SYMBOL_GLYPH_PRESETS } from '@penmoss/core/line-symbols';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/settings-v1.json';

describe('the symbol picker’s presets (A939)', () => {
  it('are core’s, in its order, each a glyph the rules take', () => {
    const presets = (contract as unknown as { symbolGlyphPresets: string[] }).symbolGlyphPresets;
    expect(presets).toEqual([...SYMBOL_GLYPH_PRESETS]);
    for (const glyph of presets) expect(glyphProblem(glyph)).toBeNull();
  });
});
