import { SYMBOL_COLOURS, SYMBOL_COLOUR_KEYS } from '@penmoss/core/line-symbols';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEMES } from '../src/theme/builtins';
import { contrast } from '../src/theme/colour';
import { COLOUR_TOKENS } from '../src/theme/tokens';

describe('line symbol colours (T44, A743, D14)', () => {
  it('are theme tokens, each setting the custom property core names', () => {
    for (const key of SYMBOL_COLOUR_KEYS) {
      const token = COLOUR_TOKENS.find((info) => info.key === key);
      expect(token, key).toBeDefined();
      expect(token!.css).toContain(SYMBOL_COLOURS[key]);
    }
  });

  it('are legible on the page in every built-in theme, light and dark', () => {
    const faint: string[] = [];
    for (const theme of BUILT_IN_THEMES) {
      for (const variant of ['light', 'dark'] as const) {
        const colours = theme[variant] as unknown as Record<string, string>;
        for (const key of SYMBOL_COLOUR_KEYS) {
          // A glyph is a large, bold mark: WCAG's 3:1 for non-text graphics.
          if (contrast(colours[key]!, colours['bg']!) < 3)
            faint.push(`${theme.id} ${variant} ${key}`);
        }
      }
    }
    expect(faint).toEqual([]);
  });
});
