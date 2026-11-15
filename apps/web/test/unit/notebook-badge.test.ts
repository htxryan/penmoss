import { ICON_NAMES } from '@penmoss/ui/icons';
import { describe, expect, it } from 'vitest';
import {
  BADGE_COLOR_SETTING,
  BADGE_GLYPH_SETTING,
  BADGE_ICONS,
  BADGE_PRESETS,
  badgeOf,
  badgeOfSource,
  contrastRatio,
  defaultBadge,
  defaultGlyph,
  defaultPreset,
  glyphInk,
  INK_DARK,
  INK_LIGHT,
  parseBadgeColor,
  parseBadgeGlyph,
  setNotebookBadge,
} from '../../src/sources/badge';
import { copySettings, type SettingsHolder } from '../../src/sources/copy-settings';
import type { Source } from '../../src/sources/registry';
import { isNotebookSetting } from '@penmoss/core/settings';

// PEN-140: each notebook's badge, a colour and a glyph, its default from its id and name.

const PERSONAL = '01JD0000000000000000000001';
const PENMOSS = '01JD0000000000000000000002';

function holder(initial: Record<string, unknown>): SettingsHolder & {
  values: Record<string, unknown>;
} {
  const values: Record<string, unknown> = { ...initial };
  return {
    values,
    settings: () => ({ ...values }),
    setSetting(key, value) {
      if (value === undefined) delete values[key];
      else values[key] = value;
    },
  };
}

describe('the default badge', () => {
  it('is a preset picked from the id: the same every time, for every device', () => {
    const first = defaultBadge(PERSONAL, 'Personal');
    expect(defaultBadge(PERSONAL, 'Personal')).toEqual(first);
    expect(BADGE_PRESETS.map((preset) => preset.hex)).toContain(first.color);
    expect(first.preset).toBe(defaultPreset(PERSONAL).id);
    expect(first.custom).toBe(false);
    // Ids spread over the presets (not all one colour).
    const ids = Array.from({ length: 40 }, (_, at) => `01JD${String(at).padStart(22, '0')}`);
    expect(new Set(ids.map((id) => defaultPreset(id).id)).size).toBeGreaterThan(5);
  });

  it('shows the first letter or digit of the name, upper-cased, duplicates and all', () => {
    expect(defaultGlyph('Personal')).toEqual({ kind: 'letter', value: 'P' });
    expect(defaultGlyph('penmoss')).toEqual({ kind: 'letter', value: 'P' });
    expect(defaultBadge(PERSONAL, 'Personal').glyph).toEqual(
      defaultBadge(PENMOSS, 'Penmoss').glyph,
    );
    expect(defaultGlyph('  — über notes')).toEqual({ kind: 'letter', value: 'Ü' });
    expect(defaultGlyph('2026 Plans')).toEqual({ kind: 'number', value: '2' });
    expect(defaultGlyph('日記')).toEqual({ kind: 'letter', value: '日' });
  });

  it('is "#" when the name has no letter or digit', () => {
    expect(defaultGlyph('—— !!')).toEqual({ kind: 'letter', value: '#' });
    expect(defaultGlyph('')).toEqual({ kind: 'letter', value: '#' });
  });
});

describe('stored badges', () => {
  it('reads a preset, a custom colour and a glyph', () => {
    const badge = badgeOf(PERSONAL, 'Personal', {
      [BADGE_COLOR_SETTING]: 'violet',
      [BADGE_GLYPH_SETTING]: { kind: 'icon', value: 'star' },
    });
    expect(badge).toEqual({
      color: '#7448a0',
      preset: 'violet',
      glyph: { kind: 'icon', value: 'star' },
      custom: true,
    });
    expect(parseBadgeColor('#ABCDEF')).toEqual({ hex: '#abcdef', preset: null });
    // A custom colour that is a preset's is the preset.
    expect(parseBadgeColor('#3c7a4b')).toEqual({ hex: '#3c7a4b', preset: 'moss' });
    expect(parseBadgeGlyph({ kind: 'number', value: '99' })).toEqual({
      kind: 'number',
      value: '99',
    });
    expect(parseBadgeGlyph({ kind: 'number', value: '0' })).toEqual({ kind: 'number', value: '0' });
  });

  it('reads anything it cannot use as the default (each part on its own)', () => {
    const fallback = defaultBadge(PERSONAL, 'Personal');
    for (const color of ['plum', '#12345', '#1234567g', 42, null, '#11223344']) {
      expect(parseBadgeColor(color)).toBeNull();
    }
    for (const glyph of [
      { kind: 'letter', value: 'AB' },
      { kind: 'letter', value: ' ' },
      { kind: 'letter', value: '' },
      { kind: 'number', value: '100' },
      { kind: 'number', value: '07' },
      { kind: 'number', value: '-1' },
      { kind: 'icon', value: 'rocket' },
      { kind: 'emoji', value: 'x' },
      'P',
      null,
    ]) {
      expect(parseBadgeGlyph(glyph)).toBeNull();
    }
    expect(
      badgeOf(PERSONAL, 'Personal', {
        [BADGE_COLOR_SETTING]: 'plum',
        [BADGE_GLYPH_SETTING]: { kind: 'icon', value: 'rocket' },
      }),
    ).toEqual(fallback);
    // A chosen colour keeps the default letter, which follows a rename.
    const renamed = badgeOf(PERSONAL, 'Work', { [BADGE_COLOR_SETTING]: 'red' });
    expect(renamed.glyph).toEqual({ kind: 'letter', value: 'W' });
    expect(renamed.color).toBe('#b23a3a');
  });

  it('offers 24 icons, all from the app’s set', () => {
    expect(BADGE_ICONS).toHaveLength(24);
    expect(new Set(BADGE_ICONS).size).toBe(24);
    for (const icon of BADGE_ICONS) expect(ICON_NAMES).toContain(icon);
  });

  it('is written to the notebook’s own settings, and a reset removes it', () => {
    const settings = holder({});
    const source = { workspace: settings } as unknown as Source;
    setNotebookBadge(source, { color: 'teal', glyph: { kind: 'number', value: '7' } });
    expect(settings.values).toEqual({
      [BADGE_COLOR_SETTING]: 'teal',
      [BADGE_GLYPH_SETTING]: { kind: 'number', value: '7' },
    });
    expect(
      badgeOfSource({ id: PERSONAL, name: 'Personal', workspace: settings } as unknown as Source)
        .glyph,
    ).toEqual({ kind: 'number', value: '7' });
    setNotebookBadge(source, { color: '#AABBCC' });
    expect(settings.values[BADGE_COLOR_SETTING]).toBe('#aabbcc');
    setNotebookBadge(source, { color: null, glyph: null });
    expect(settings.values).toEqual({});
    // Both keys are the notebook's own (A827), never a device's.
    expect(isNotebookSetting(BADGE_COLOR_SETTING)).toBe(true);
    expect(isNotebookSetting(BADGE_GLYPH_SETTING)).toBe(true);
  });
});

describe('the glyph’s ink', () => {
  it('is white on every preset, at 4.5:1 or more', () => {
    for (const preset of BADGE_PRESETS) {
      expect(contrastRatio(preset.hex, INK_LIGHT), preset.label).toBeGreaterThanOrEqual(4.5);
      expect(glyphInk(preset.hex)).toBe(INK_LIGHT);
    }
  });

  it('is near-black on a light custom colour', () => {
    for (const light of ['#ffeb3b', '#f5f5f5', '#9be7c4']) {
      expect(glyphInk(light)).toBe(INK_DARK);
      expect(contrastRatio(light, INK_DARK)).toBeGreaterThanOrEqual(4.5);
    }
    expect(glyphInk('#000000')).toBe(INK_LIGHT);
  });
});

describe('copying settings between notebooks (A1137)', () => {
  it('leaves each notebook’s badge its own', () => {
    const from = holder({
      theme: 'moss',
      [BADGE_COLOR_SETTING]: 'red',
      [BADGE_GLYPH_SETTING]: { kind: 'letter', value: 'Q' },
    });
    const to = holder({ [BADGE_COLOR_SETTING]: 'blue' });
    expect(copySettings(from, to)).toBe(1);
    expect(to.values).toEqual({ theme: 'moss', [BADGE_COLOR_SETTING]: 'blue' });
  });
});
