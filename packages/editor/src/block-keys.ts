/**
 * Per-platform default keys for turning blocks into text, headings and code
 * (T20, A90), as ProseMirror names them. Apple platforms keep TipTap's ⌘⌥0–6
 * and ⌘⌥C. Elsewhere Ctrl+Alt is AltGr, which types on many layouts (German
 * `}` is AltGr+0, Polish `ć` is AltGr+C), so text and headings are
 * Ctrl+Shift+0–6 (as in Notion; Alt+digit switches tabs in Chrome on Linux)
 * and a code block is Alt+C.
 */
import { isApple } from './platform';

/** `0` is Turn into text; `1`–`6` the heading levels. */
export const blockTypeKey = (level: number): string =>
  isApple() ? `Mod-Alt-${level}` : `Mod-Shift-${level}`;

export const codeBlockKey = (): string => (isApple() ? 'Mod-Alt-c' : 'Alt-c');
