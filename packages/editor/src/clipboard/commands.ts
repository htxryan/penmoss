/**
 * Copy as Markdown and Copy as rich text as named commands (T15), for the
 * clipboard extension's default shortcuts, the selection toolbar's Copy menu
 * and T20's command registry with customisable shortcuts.
 */
import type { Editor } from '@tiptap/core';
import { isApple } from '../platform';

export interface ClipboardCommand {
  /** Stable id for the command registry and saved shortcut overrides (T20). */
  readonly id: 'copy-markdown' | 'copy-rich-text';
  readonly label: string;
  readonly format: 'markdown' | 'rich';
  /**
   * Default keys as ProseMirror names them (Mod is ⌘ on Apple platforms, Ctrl
   * elsewhere), or null for no default shortcut.
   */
  readonly keys: { readonly apple: string | null; readonly other: string | null };
  /** Copies the selection, or the whole note when nothing is selected. */
  readonly run: (editor: Editor) => boolean;
}

export const CLIPBOARD_COMMANDS: readonly ClipboardCommand[] = [
  {
    id: 'copy-markdown',
    label: 'Copy as Markdown',
    format: 'markdown',
    keys: { apple: 'Mod-Shift-c', other: 'Mod-Shift-c' },
    run: (editor) => editor.commands.copyAsMarkdown(),
  },
  {
    id: 'copy-rich-text',
    label: 'Copy as Rich Text',
    format: 'rich',
    // ⌘⌥⇧C on Apple platforms only: Ctrl+Alt+Shift+C is AltGr+Shift+C on Windows and
    // Linux, which types a letter on some layouts (Polish Ć). The menus still offer it.
    keys: { apple: 'Mod-Alt-Shift-c', other: null },
    run: (editor) => editor.commands.copyAsRichText(),
  },
];

/** A command's default keys on this platform, or null. */
export function defaultKeys(command: ClipboardCommand): string | null {
  return isApple() ? command.keys.apple : command.keys.other;
}
