/**
 * Copy and paste (T15): the clipboard extension. See copy.ts and paste.ts.
 *
 * Commands: `copyAsMarkdown` (Mod-Shift-C) and `copyAsRichText` (⌘⌥⇧C on
 * Apple platforms, no default elsewhere) copy the selection, or the whole
 * note when nothing is selected; `copyNoteAs` always copies the whole note.
 * The selection toolbar and the note header offer them too. Their ids and
 * default keys are in `CLIPBOARD_COMMANDS` (commands.ts).
 */
import { Extension } from '@tiptap/core';
import type { ImageServices } from '../extensions/image';
import { CLIPBOARD_COMMANDS, defaultKeys } from './commands';
import { copyAs } from './copy';
import { loadCodec, type NoteFields } from './markdown';
import { clipboardPlugin } from './paste';

export { CLIPBOARD_COMMANDS, defaultKeys, type ClipboardCommand } from './commands';
export {
  setNativeClipboard,
  type CopyFormat,
  type NativeClipboardPayload,
  type NativeClipboardWriter,
} from './copy';
export type { NoteFields } from './markdown';
export { looksLikeMarkdown, loadCodec } from './markdown';
export { pastePlainText } from './paste';
export { sanitizeClipboardHTML } from './sanitize';

export interface ClipboardOptions {
  /** Where pictures inside pasted HTML are stored (T10). */
  readonly images?: ImageServices | undefined;
  /** The note's frontmatter fields, for Copy as Markdown of a whole note. */
  readonly note?: () => NoteFields | null;
  /** Told after an explicit copy (for a "Copied" notice); `ok` is false when the clipboard refused. */
  readonly onCopy?: (format: 'markdown' | 'rich', ok: boolean) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    clipboard: {
      /** Copies the selection (or the whole note) as markdown only. */
      copyAsMarkdown: () => ReturnType;
      /** Copies the selection (or the whole note) as HTML with readable plain text. */
      copyAsRichText: () => ReturnType;
      /** Copies the whole note, whatever is selected. */
      copyNoteAs: (format: 'markdown' | 'rich') => ReturnType;
    };
  }
}

export const Clipboard = Extension.create<ClipboardOptions>({
  name: 'clipboard',
  // Ahead of the link extension (1000), so paste and match style is never turned into a link.
  priority: 1100,

  addOptions() {
    return {};
  },

  addCommands() {
    const run = (format: 'markdown' | 'rich', whole: boolean) => {
      const { view } = this.editor;
      const note = whole || view.state.selection.empty ? (this.options.note?.() ?? null) : null;
      void copyAs(view, format, note, whole).then((ok) => this.options.onCopy?.(format, ok));
    };
    return {
      copyAsMarkdown:
        () =>
        ({ dispatch }) => {
          if (dispatch) run('markdown', false);
          return true;
        },
      copyAsRichText:
        () =>
        ({ dispatch }) => {
          if (dispatch) run('rich', false);
          return true;
        },
      copyNoteAs:
        (format: 'markdown' | 'rich') =>
        ({ dispatch }) => {
          if (dispatch) run(format, true);
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    const shortcuts: Record<string, () => boolean> = {};
    for (const command of CLIPBOARD_COMMANDS) {
      const keys = defaultKeys(command);
      if (keys) shortcuts[keys] = () => command.run(this.editor);
    }
    return shortcuts;
  },

  addProseMirrorPlugins() {
    return [clipboardPlugin(this.editor.schema, { images: this.options.images })];
  },

  onFocus() {
    // Markdown on the clipboard needs the codec (a lazy chunk); fetch it before the first copy.
    void loadCodec().catch(() => undefined);
  },
});
