import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEMES, NORD, PENMOSS } from '../src/theme/builtins';
import { contrast, isHexColour, mix, over } from '../src/theme/colour';
import {
  contrastChecks,
  contrastProblems,
  EDGE_MIN,
  TEXT_MIN,
  UI_MIN,
} from '../src/theme/contrast';
import { COLOUR_KEYS } from '../src/theme/tokens';

describe('colour maths (T28)', () => {
  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
    // The WCAG reference: #767676 on white is the lightest grey that passes 4.5:1.
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.5);
  });

  it('mixes like color-mix in oklab, and lays translucent colours over a surface', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    // Oklab's midpoint between black and white is lighter than sRGB's #808080.
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#636363');
    expect(over('#000000', 0.5, '#ffffff')).toBe('#808080');
    expect(over('#3f7d4e', 0, '#fbfaf7')).toBe('#fbfaf7');
  });
});

describe('built-in themes (T28)', () => {
  it('ships the eight themes the plan names, each with light and dark', () => {
    expect(BUILT_IN_THEMES.map((theme) => theme.name)).toEqual([
      'Penmoss',
      'Paper',
      'Slate',
      'Nord',
      'Solarized',
      'Gruvbox',
      'Rosé Pine',
      'High Contrast',
    ]);
    expect(new Set(BUILT_IN_THEMES.map((theme) => theme.id)).size).toBe(8);
    for (const theme of BUILT_IN_THEMES) {
      for (const variant of ['light', 'dark'] as const) {
        expect(Object.keys(theme[variant]).sort(), `${theme.id} ${variant}`).toEqual(
          [...COLOUR_KEYS].sort(),
        );
        for (const key of COLOUR_KEYS) {
          expect(isHexColour(theme[variant][key]), `${theme.id} ${variant} ${key}`).toBe(true);
        }
      }
    }
  });

  it('keeps Penmoss looking as the app did before themes', () => {
    // The surfaces, text and borders of the stylesheet that T28 replaced (styles.css).
    expect(PENMOSS.light).toMatchObject({
      bg: '#fbfaf7',
      sidebar: '#f1f0ea',
      raised: '#ffffff',
      border: '#dedbd2',
      fg: '#1f2421',
      muted: '#57635b',
      danger: '#b3261e',
      warnBg: '#fbefc9',
    });
    expect(PENMOSS.dark).toMatchObject({
      bg: '#161a17',
      sidebar: '#121512',
      raised: '#202620',
      border: '#2c332e',
      fg: '#e6ebe7',
      muted: '#9aa69e',
      accent: '#7fbf8e',
      danger: '#f2b8b5',
    });
    // Wider since T41 (A500): Ryan found 46rem too narrow.
    expect(PENMOSS.editorWidth).toBe(52);
  });

  // The acceptance criterion: every built-in passes WCAG AA in both variants. Text pairs
  // (body, secondary, links, accent text, code tokens, callout labels, labels on fills) need
  // 4.5:1; icons, focus rings and graph marks need 3:1.
  for (const theme of BUILT_IN_THEMES) {
    for (const variant of ['light', 'dark'] as const) {
      it(`${theme.name} (${variant}) passes WCAG AA`, () => {
        const checks = contrastChecks(theme[variant]);
        expect(checks.filter((check) => check.kind === 'text').length).toBeGreaterThan(40);
        expect(checks.filter((check) => check.kind === 'ui').length).toBeGreaterThan(15);
        expect(checks.filter((check) => check.kind === 'edge').length).toBe(3);
        for (const check of checks) {
          expect(check.min).toBe({ text: TEXT_MIN, ui: UI_MIN, edge: EDGE_MIN }[check.kind]);
        }
        const failures = checks
          .filter((check) => check.ratio < check.min)
          .map(
            (check) => `${check.label}: ${check.fg} on ${check.bg} is ${check.ratio.toFixed(2)}:1`,
          );
        expect(failures).toEqual([]);
      });
    }
  }

  it('gives High Contrast 7:1 text (AAA) in both variants', () => {
    const theme = BUILT_IN_THEMES.find((each) => each.id === 'high-contrast')!;
    for (const variant of ['light', 'dark'] as const) {
      const text = contrastChecks(theme[variant]).filter((check) => check.kind === 'text');
      expect(Math.min(...text.map((check) => check.ratio)), variant).toBeGreaterThanOrEqual(7);
    }
  });

  it('gives each graph group its own colour', () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const variant of ['light', 'dark'] as const) {
        const groups = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => theme[variant][`graph${n}` as 'graph1']);
        expect(new Set(groups).size, `${theme.id} ${variant}`).toBe(8);
      }
    }
  });
});

describe('a notebook’s name in the sidebar (T52)', () => {
  it('is checked, as the accent mixed a quarter of the way to the text', () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const variant of ['light', 'dark'] as const) {
        const c = theme[variant];
        const name = contrastChecks(c).filter((check) => check.label.startsWith('A notebook’s'));
        expect(name.map((check) => check.bg)).toEqual([c.sidebar, over(c.fg, 0.06, c.sidebar)]);
        for (const check of name) expect(check.fg).toBe(mix(c.accent, c.fg, 0.25));
      }
    }
  });

  it('is not the plain accent, which some sidebars do not carry at 4.5:1', () => {
    expect(contrast(NORD.light.accent, NORD.light.sidebar)).toBeLessThan(TEXT_MIN);
    expect(
      contrast(mix(NORD.light.accent, NORD.light.fg, 0.25), NORD.light.sidebar),
    ).toBeGreaterThanOrEqual(TEXT_MIN);
  });
});

describe('borders (T28 review)', () => {
  it('flags borders that cannot be told from the page, the sidebar or a menu', () => {
    const labels = (colours: typeof NORD.light) =>
      contrastProblems(colours).map((check) => check.label);
    expect(labels({ ...NORD.light, border: NORD.light.bg })).toContain('Borders on the page');
    expect(labels({ ...NORD.light, border: NORD.light.raised })).toContain(
      'Borders on a menu or dialog',
    );
    expect(labels({ ...NORD.light, border: NORD.light.sidebar })).toContain(
      'Borders on the sidebar',
    );
    // Nord's own borders are fine.
    expect(labels(NORD.light)).toEqual([]);
  });
});
