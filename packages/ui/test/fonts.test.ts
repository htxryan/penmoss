import { FONT_PRESET_STACKS } from '@penmoss/core/fonts';
import { describe, expect, it } from 'vitest';
import { fontVariables, NOTE_SIZE_VARIABLE } from '../src/theme/fonts';

// T51 item 16 (A944): the font settings as CSS variables, for the web and Android's editor page.

describe('fontVariables', () => {
  it('sets only the note size while the fonts are the theme’s', () => {
    expect(fontVariables({})).toEqual({ [NOTE_SIZE_VARIABLE]: '16px' });
    expect(fontVariables({ 'font.interface': 'theme', 'font.note': null })).toEqual({
      '--pm-note-size': '16px',
    });
  });

  it('gives a preset’s stack, a custom family over the system’s, and the size', () => {
    expect(
      fontVariables({
        'font.interface': 'rounded',
        'font.note': 'custom:Avenir Next',
        'font.noteSize': 22,
      }),
    ).toEqual({
      '--pm-font': FONT_PRESET_STACKS.rounded,
      '--pm-font-body': `'Avenir Next', ${FONT_PRESET_STACKS.system}`,
      '--pm-note-size': '22px',
    });
  });

  it('never sets the code font', () => {
    expect(fontVariables({ 'font.note': 'mono' })).not.toHaveProperty('--pm-mono');
  });

  it('reads what it cannot use as the default', () => {
    expect(
      fontVariables({
        'font.interface': 'comic',
        'font.note': 'custom:a;b{}',
        'font.noteSize': 99,
      }),
    ).toEqual({ '--pm-note-size': '16px' });
    expect(fontVariables({ 'font.noteSize': 12.5 })).toEqual({ '--pm-note-size': '16px' });
  });
});
