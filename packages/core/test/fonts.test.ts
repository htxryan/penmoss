import { describe, expect, it } from 'vitest';
import {
  fontChoiceOf,
  fontSettingProblem,
  fontStack,
  FONT_PRESET_STACKS,
  NOTE_FONT_SETTING,
  NOTE_FONT_SIZE_SETTING,
  noteFontSizeOf,
} from '../src/fonts';

describe('font settings (T51, A944)', () => {
  it('takes presets, safe custom families and sizes from 12 to 28', () => {
    for (const value of ['theme', 'serif', 'mono', 'custom:Avenir Next', 'custom:SF_Pro-2.1', null])
      expect(fontSettingProblem(NOTE_FONT_SETTING, value)).toBeNull();
    for (const value of ['Serif', 'custom:', 'custom: Avenir', "custom:x'}", 'custom:a;b', 3])
      expect(fontSettingProblem(NOTE_FONT_SETTING, value)).not.toBeNull();
    expect(fontSettingProblem(NOTE_FONT_SIZE_SETTING, 12)).toBeNull();
    expect(fontSettingProblem(NOTE_FONT_SIZE_SETTING, 28)).toBeNull();
    for (const value of [11, 29, 16.5, '16'])
      expect(fontSettingProblem(NOTE_FONT_SIZE_SETTING, value)).not.toBeNull();
  });

  it('reads unset or unreadable values as the defaults', () => {
    expect(fontChoiceOf({}, NOTE_FONT_SETTING)).toBe('theme');
    expect(fontChoiceOf({ [NOTE_FONT_SETTING]: 'comic' }, NOTE_FONT_SETTING)).toBe('theme');
    expect(fontChoiceOf({ [NOTE_FONT_SETTING]: 'serif' }, NOTE_FONT_SETTING)).toBe('serif');
    expect(noteFontSizeOf({})).toBe(16);
    expect(noteFontSizeOf({ [NOTE_FONT_SIZE_SETTING]: 99 })).toBe(16);
    expect(noteFontSizeOf({ [NOTE_FONT_SIZE_SETTING]: 20 })).toBe(20);
  });

  it('turns a choice into a stack with fallbacks', () => {
    expect(fontStack('theme')).toBeNull();
    expect(fontStack('serif')).toBe(FONT_PRESET_STACKS.serif);
    expect(fontStack('serif')).toMatch(/, serif$/);
    expect(fontStack('custom:Avenir Next')).toBe(`'Avenir Next', ${FONT_PRESET_STACKS.system}`);
    for (const stack of Object.values(FONT_PRESET_STACKS))
      expect(stack).toMatch(/(sans-serif|serif|monospace)$/);
  });

  it('names no face that has only a bold weight', () => {
    // 'Arial Rounded MT Bold' is on every Mac and Chromium has no ui-rounded, so the Mac app
    // and Chrome drew a note's every word in bold under Rounded (T51's manual pass).
    for (const stack of Object.values(FONT_PRESET_STACKS)) expect(stack).not.toMatch(/\bBold\b/);
  });
});
