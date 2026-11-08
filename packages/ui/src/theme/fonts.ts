/**
 * The font settings as CSS variables (T51 item 16, A944): what the person chose for the
 * interface's font, the note text's font and its size, laid over the theme's own
 * (`themeVariables`). The web app sets them on `<html>` after the theme; Android's editor page
 * calls the same function, so both read a choice alike.
 *
 * `--pm-font` is the interface, `--pm-font-body` the note text (the title, headings and body),
 * `--pm-note-size` the note text's base size, from which its headings and title scale. Code
 * keeps the theme's `--pm-mono`. A font left at the theme's own sets nothing, so the theme's
 * stays; the size is always set.
 */
import {
  fontChoiceOf,
  fontStack,
  INTERFACE_FONT_SETTING,
  NOTE_FONT_SETTING,
  noteFontSizeOf,
} from '@penmoss/core/fonts';

/** The size's variable, read by the note's stylesheet as `var(--pm-note-size, 16px)`. */
export const NOTE_SIZE_VARIABLE = '--pm-note-size';

export function fontVariables(settings: Readonly<Record<string, unknown>>): Record<string, string> {
  const vars: Record<string, string> = {};
  const ui = fontStack(fontChoiceOf(settings, INTERFACE_FONT_SETTING));
  if (ui !== null) vars['--pm-font'] = ui;
  const note = fontStack(fontChoiceOf(settings, NOTE_FONT_SETTING));
  if (note !== null) vars['--pm-font-body'] = note;
  vars[NOTE_SIZE_VARIABLE] = `${noteFontSizeOf(settings)}px`;
  return vars;
}
