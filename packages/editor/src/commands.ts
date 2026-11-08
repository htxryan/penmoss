/**
 * The editor's user-visible actions as commands (T20, FR-NAV-1): an id, a
 * title, default key combinations (the app's `Mod+Shift+E` format, see
 * apps/web/src/commands/keys.ts) and what it does to an editor. The app's
 * command registry lists them in the palette, lets them be rebound and
 * dispatches their keys; the extensions' own keymaps (the same defaults) stay
 * for editors outside the app (tests, the Android WebView until it gets the
 * registry). `editor-commands.test.ts` checks that every modified key the
 * extensions bind is one of these defaults.
 */
import type { Editor } from '@tiptap/core';
import { redoCommand, undoCommand } from '@y/prosemirror';
import { blockTypeKey, codeBlockKey } from './block-keys';
import { CLIPBOARD_COMMANDS, defaultKeys } from './clipboard/commands';
import { BLOCK_ITEMS, type BlockItem } from './extensions/block-items';
import {
  deleteSelectedBlock,
  duplicateSelectedBlock,
  moveSelectedBlock,
} from './extensions/block-move';
import type { SelectionToolbarStorage } from './extensions/bubble-toolbar';
import { selectionToolbarKey, wantsToolbar } from './extensions/bubble-toolbar';
import type { ImageServices } from './extensions/image';
import { commentsEnabled, requestComment } from './extensions/comments';
import { openSymbolPicker, readDOMSelection, toggleSymbolIn } from './extensions/line-symbols';
import { comboFromKeymapName } from './keys';
import type { LineSymbol } from '@penmoss/core/line-symbols';
import { isApple } from './platform';

export interface EditorCommandContext {
  readonly editor: Editor;
  /** Image storage for the Image block (absent: that command is unavailable). */
  readonly images?: ImageServices | undefined;
  /** What ran it: a key reads the browser's selection first (T44, line symbols). */
  readonly source?: 'key' | 'palette' | 'button' | 'menu' | undefined;
}

export interface EditorCommand {
  readonly id: string;
  readonly title: string;
  /** Default key combinations, e.g. `Mod+B`. */
  readonly keys: readonly string[];
  /** Palette group. */
  readonly area: 'Editor' | 'Insert' | 'Symbols';
  /**
   * The command acts only in a narrow situation (Link: text selected) and
   * otherwise leaves its keys to the next command bound to them (A42: Mod-K
   * opens the palette when no text is selected).
   */
  readonly yields?: boolean;
  /** Runs the command; false when it does not apply here (the key then falls through). */
  readonly run: (context: EditorCommandContext) => boolean;
}

/** Commands that act on the editor through a TipTap chain (one transaction, one undo step). */
const chain = (editor: Editor) => {
  if (!editor.view.hasFocus()) editor.view.focus();
  return editor.chain();
};

/** Shows the selection toolbar and runs `then` on it; false without a text selection. */
function withToolbar(editor: Editor, then: (storage: SelectionToolbarStorage) => void): boolean {
  if (!wantsToolbar(editor)) return false;
  editor.view.dispatch(editor.state.tr.setMeta(selectionToolbarKey, 'show'));
  const storage = editor.storage as unknown as { selectionToolbar?: SelectionToolbarStorage };
  if (storage.selectionToolbar) then(storage.selectionToolbar);
  return true;
}

const headings = [1, 2, 3, 4, 5, 6].map((level): EditorCommand => ({
  id: `editor.heading${level}`,
  title: `Heading ${level}`,
  keys: [comboFromKeymapName(blockTypeKey(level))],
  area: 'Editor',
  run: ({ editor }) =>
    chain(editor)
      .toggleHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 })
      .run(),
}));

const FORMATTING: readonly EditorCommand[] = [
  {
    id: 'editor.bold',
    title: 'Bold',
    keys: ['Mod+B'],
    area: 'Editor',
    run: ({ editor }) => chain(editor).toggleBold().run(),
  },
  {
    id: 'editor.italic',
    title: 'Italic',
    keys: ['Mod+I'],
    area: 'Editor',
    run: ({ editor }) => chain(editor).toggleItalic().run(),
  },
  {
    id: 'editor.strike',
    title: 'Strikethrough',
    keys: ['Mod+Shift+S'],
    area: 'Editor',
    run: ({ editor }) => chain(editor).toggleStrike().run(),
  },
  {
    // Mod-Shift-E, as in the prototype: Mod-E is the recent-notes switcher (A42).
    id: 'editor.code',
    title: 'Inline Code',
    keys: ['Mod+Shift+E'],
    area: 'Editor',
    run: ({ editor }) => chain(editor).toggleCode().run(),
  },
  {
    id: 'editor.highlight',
    title: 'Highlight',
    keys: ['Mod+Shift+H'],
    area: 'Editor',
    run: ({ editor }) => chain(editor).toggleHighlight().run(),
  },
  {
    id: 'editor.link',
    title: 'Link Selected Text',
    keys: ['Mod+K'],
    area: 'Editor',
    yields: true,
    run: ({ editor }) => withToolbar(editor, (storage) => storage.toolbar?.openLink()),
  },
  {
    id: 'editor.toolbar',
    title: 'Focus the Formatting Toolbar',
    keys: ['Alt+F10'],
    area: 'Editor',
    yields: true,
    run: ({ editor }) => withToolbar(editor, (storage) => storage.toolbar?.focus()),
  },
  {
    // T48: a thread on the selection, or at the caret. Not Google Docs' ⌘⌥M: on a Mac that is
    // Minimize All, which the Mac app's Window menu takes first, so ⌘⌥⇧M (beside the panel's
    // ⌘⌥⇧C). Elsewhere Ctrl+Alt is AltGr (A90), so Alt+Shift+M.
    id: 'editor.comment',
    title: 'Comment',
    keys: [isApple() ? 'Mod+Alt+Shift+M' : 'Alt+Shift+M'],
    area: 'Editor',
    run: ({ editor, source }) => {
      if (!commentsEnabled(editor)) return false;
      // A key is read before the browser says where the caret went (T44): read it now.
      if (source === 'key') readDOMSelection(editor.view);
      requestComment(editor);
      return true;
    },
  },
  {
    id: 'editor.paragraph',
    title: 'Turn into Text',
    keys: [comboFromKeymapName(blockTypeKey(0))],
    area: 'Editor',
    run: ({ editor }) => chain(editor).setParagraph().run(),
  },
  ...headings,
  {
    id: 'editor.bulletList',
    title: 'Bulleted List',
    keys: ['Mod+Shift+8'],
    area: 'Editor',
    run: ({ editor }) => chain(editor).toggleBulletList().run(),
  },
  {
    id: 'editor.orderedList',
    title: 'Numbered List',
    keys: ['Mod+Shift+7'],
    area: 'Editor',
    run: ({ editor }) => chain(editor).toggleOrderedList().run(),
  },
  {
    id: 'editor.taskList',
    title: 'Checklist',
    keys: ['Mod+Shift+9'],
    area: 'Editor',
    run: ({ editor }) => chain(editor).toggleTaskList().run(),
  },
  {
    id: 'editor.blockquote',
    title: 'Quote',
    keys: ['Mod+Shift+B'],
    area: 'Editor',
    run: ({ editor }) => chain(editor).toggleBlockquote().run(),
  },
  {
    id: 'editor.codeBlock',
    title: 'Code Block',
    keys: [comboFromKeymapName(codeBlockKey())],
    area: 'Editor',
    run: ({ editor }) => chain(editor).toggleCodeBlock().run(),
  },
  {
    id: 'editor.undo',
    title: 'Undo',
    keys: ['Mod+Z'],
    area: 'Editor',
    run: ({ editor }) => undoCommand(editor.state, editor.view.dispatch),
  },
  {
    id: 'editor.redo',
    title: 'Redo',
    keys: ['Mod+Shift+Z', 'Mod+Y'],
    area: 'Editor',
    run: ({ editor }) => redoCommand(editor.state, editor.view.dispatch),
  },
  {
    // False at the first block, so the browser's own Alt-Shift-↑ (extend selection) still works.
    id: 'editor.moveBlockUp',
    title: 'Move Block Up',
    keys: ['Alt+Shift+Up'],
    area: 'Editor',
    yields: true,
    run: ({ editor }) => moveSelectedBlock(-1)(editor.state, editor.view.dispatch, editor.view),
  },
  {
    id: 'editor.moveBlockDown',
    title: 'Move Block Down',
    keys: ['Alt+Shift+Down'],
    area: 'Editor',
    yields: true,
    run: ({ editor }) => moveSelectedBlock(1)(editor.state, editor.view.dispatch, editor.view),
  },
  {
    // No default keys: the phone's Block menu (T40 P8, ED5) and the palette run it.
    id: 'editor.duplicateBlock',
    title: 'Duplicate Block',
    keys: [],
    area: 'Editor',
    run: ({ editor }) => duplicateSelectedBlock()(editor.state, editor.view.dispatch, editor.view),
  },
  {
    id: 'editor.deleteBlock',
    title: 'Delete Block',
    keys: [],
    area: 'Editor',
    run: ({ editor }) => deleteSelectedBlock()(editor.state, editor.view.dispatch, editor.view),
  },
];

/**
 * Line symbols (T44, A744): one command per slot of the person's list, toggling that symbol on
 * every line in the selection, and the picker. ⌃1–9 and ⌃0 on Apple platforms (⌘⌥1–6 are
 * headings, A90); Alt+Shift+1–9 and Alt+Shift+0 elsewhere, where Ctrl+Shift+digits are headings
 * and lists and Ctrl+Alt is AltGr (Ryan, 25 Oct 2026). A slot the list does not fill declines,
 * so its key keeps its usual meaning.
 */
const symbolKey = (digit: number) => (isApple() ? `Ctrl+${digit}` : `Alt+Shift+${digit}`);

const SYMBOL_COMMAND = /^editor\.symbol([1-9])$/;

/**
 * A symbol command's title for the person's list (T51 item 12, A940): "Toggle Symbol ★" for
 * the glyph in its slot; undefined for any other command, and for a slot the list does not
 * fill (its own title, "Toggle Symbol 4", stands).
 */
export function symbolCommandTitle(id: string, symbols: readonly LineSymbol[]): string | undefined {
  const slot = SYMBOL_COMMAND.exec(id)?.[1];
  const symbol = slot === undefined ? undefined : symbols[Number(slot) - 1];
  return symbol ? `Toggle Symbol ${symbol.glyph}` : undefined;
}

export const SYMBOL_COMMANDS: readonly EditorCommand[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot): EditorCommand => ({
    id: `editor.symbol${slot}`,
    // The slot's own title; in use its glyph names it (symbolCommandTitle, A940).
    title: `Toggle Symbol ${slot}`,
    keys: [symbolKey(slot)],
    area: 'Symbols',
    run: ({ editor, source }) => {
      if (!editor.view.hasFocus()) editor.view.focus();
      return toggleSymbolIn(editor.view, slot - 1, source === 'key');
    },
  })),
  {
    id: 'editor.symbolPicker',
    title: 'Symbols…',
    keys: [symbolKey(0)],
    area: 'Symbols',
    run: ({ editor, source }) => openSymbolPicker(editor, source === 'key'),
  },
];

/** The id of the palette command that inserts a slash-menu block. */
export const insertCommandId = (item: Pick<BlockItem, 'id'>) => `editor.insert.${item.id}`;

/** One "Insert …" command per slash-menu block (callout types included). */
const INSERTS: readonly EditorCommand[] = BLOCK_ITEMS.map((item) => ({
  id: insertCommandId(item),
  title: `Insert: ${item.label}`,
  keys: [],
  area: 'Insert',
  run: ({ editor, images }) => {
    if (item.needsImages && !images) return false;
    const { from } = editor.state.selection;
    return item.insert({ editor, range: { from, to: from }, images });
  },
}));

/**
 * T15's Copy as Markdown and Copy as rich text, registered under T15's own ids
 * (`copy-markdown`, `copy-rich-text`) with its per-platform defaults: ⌘⇧C and
 * ⌘⌥⇧C on Apple devices; Ctrl+Shift+C elsewhere, and no default for rich
 * text there (Ctrl+Alt+Shift+C is AltGr+Shift+C, which types on some layouts).
 */
const CLIPBOARD: readonly EditorCommand[] = CLIPBOARD_COMMANDS.map((command) => {
  const keys = defaultKeys(command);
  return {
    id: command.id,
    title: command.label,
    keys: keys ? [comboFromKeymapName(keys)] : [],
    area: 'Editor',
    run: ({ editor }) => command.run(editor),
  };
});

export const EDITOR_COMMANDS: readonly EditorCommand[] = [
  ...FORMATTING,
  ...SYMBOL_COMMANDS,
  ...CLIPBOARD,
  ...INSERTS,
];

/**
 * Keys the extensions bind that are text editing, like typing, not commands:
 * Enter and Tab variants, Backspace and Delete variants, select all, and the
 * arrows code blocks and tables handle. They are never rebound.
 */
export const EDITING_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Shift+Enter',
  'Mod+Enter',
  'Tab',
  'Shift+Tab',
  'Backspace',
  'Mod+Backspace',
  'Shift+Backspace',
  'Delete',
  'Mod+Delete',
  'Mod+A',
  'Up',
  'Down',
  'Right',
]);
