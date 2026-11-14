// TipTap extensions, clipboard, slash menu and platform adapters (docs/architecture.md#packages).
export {
  createCollabEditor,
  UnsupportedContentError,
  type CollabEditor,
  type CollabEditorOptions,
} from './collab';
export { NOTE_MARKS, NOTE_NODES, noteExtensions, type NoteExtensionsOptions } from './extensions';
export type { ImageServices } from './extensions/image';
// T51 (A948): the image lightbox, opened from an image's tools or a double click.
export {
  openLightbox,
  openLightboxNow,
  setLightboxHooks,
  type Lightbox,
  type LightboxHooks,
  type LightboxImage,
  type LightboxOptions,
} from './lightbox';
export { calloutKey, memoryFoldState, type FoldState } from './extensions/callout';
export { CODE_LANGUAGES, resolveLanguage } from './extensions/highlight';
export { copyText } from './clipboard/copy';
export { indentCode } from './extensions/code-block';
export {
  deleteSelectedBlock,
  duplicateSelectedBlock,
  hasPendingUpdates,
  latestUndoStep,
  moveSelectedBlock,
  selectedTopLevelBlock,
} from './extensions/block-move';
export {
  availableBlockItems,
  BLOCK_ITEMS,
  canTurnInto,
  filterBlockItems,
  TURN_INTO_ITEMS,
  turnInto,
  type BlockItem,
} from './extensions/block-items';
export {
  CLIPBOARD_COMMANDS,
  defaultKeys,
  loadCodec,
  looksLikeMarkdown,
  sanitizeClipboardHTML,
  pastePlainText,
  setNativeClipboard,
  type ClipboardCommand,
  type NativeClipboardPayload,
  type NativeClipboardWriter,
  type ClipboardOptions,
  type NoteFields,
} from './clipboard';
export {
  followLink,
  notePath,
  openWhere,
  wikilinkExtension,
  type OpenWhere,
  type LinkServices,
  type NoteCandidate,
} from './extensions/wikilink';
export { insertLink, linkMenuOf, type LinkOption } from './extensions/link-menu';
export { attachmentExtension, insertFiles, type FileServices } from './extensions/attachment';
export {
  embedExtension,
  MAX_EMBED_DEPTH,
  renderBlocks,
  resolveEmbed,
  type EmbedResolution,
} from './extensions/embed';
export {
  EDITING_KEYS,
  EDITOR_COMMANDS,
  insertCommandId,
  SYMBOL_COMMANDS,
  type EditorCommand,
  type EditorCommandContext,
} from './commands';
export { AGENT_HIGHLIGHT_MS, highlightAgentEdit } from './extensions/agent-highlight';
export {
  activeSymbols,
  canHaveSymbols,
  closeSymbolPicker,
  fixedSymbols,
  lineSymbolsKey,
  lineSymbolsOf,
  openSymbolPicker,
  setLineSymbols,
  symbolPickerOpen,
  toggleLineSymbol,
  toggleSymbolIn,
  type SymbolSource,
} from './extensions/line-symbols';
export { NOTE_LAYOUT_EVENT, noteLayoutChanged } from './extensions/symbol-overflow';
export {
  ARROW_UP_INTO_TITLE,
  BACKSPACE_INTO_TITLE,
  type BackspaceIntoTitleDetail,
} from './extensions/title-handoff';
export {
  COMMENT_ADD_EVENT,
  COMMENT_OPEN_EVENT,
  anchorRange,
  commentsEnabled,
  rangeRect,
  revealThread,
  selectionAnchor,
  showCommentThreads,
  showPendingComment,
  threadRange,
  type SelectionAnchor,
  type ShownThread,
} from './extensions/comments';
