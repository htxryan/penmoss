// TipTap extensions, clipboard, slash menu and platform adapters (docs/architecture.md#packages).
export { createCollabEditor, UnsupportedContentError, type CollabEditor } from './collab';
export { noteExtensions } from './extensions';
export type { ImageServices } from './extensions/image';
// PEN-28: drawings, an SVG picture linked to its Excalidraw scene.
export { type DrawingFiles, type DrawingServices } from './extensions/drawing';
// T51 (A948): the image lightbox, opened from an image's tools or a double click.
export { openLightbox, openLightboxNow, setLightboxHooks } from './lightbox';
export { type FoldState } from './extensions/callout';
export { LINK_REFUSED, normaliseHref } from './extensions/bubble-toolbar';
export { copyText } from './clipboard/copy';
export { indentCode } from './extensions/code-block';
export {
  hasPendingUpdates,
  latestUndoStep,
  moveSelectedBlock,
  selectedTopLevelBlock,
} from './extensions/block-move';
export {
  availableBlockItems,
  canTurnInto,
  filterBlockItems,
  TURN_INTO_ITEMS,
  turnInto,
  type BlockItem,
} from './extensions/block-items';
export { pastePlainText, setNativeClipboard, type NativeClipboardPayload } from './clipboard';
export { type OpenWhere, type LinkServices, type NoteCandidate } from './extensions/wikilink';
export { type FileServices } from './extensions/attachment';
export { renderBlocks } from './extensions/embed';
export { EDITOR_COMMANDS } from './commands';
export {
  activeSymbols,
  canHaveSymbols,
  closeSymbolPicker,
  openSymbolPicker,
  symbolPickerOpen,
  toggleSymbolIn,
  type SymbolSource,
} from './extensions/line-symbols';

export {
  ARROW_UP_INTO_TITLE,
  BACKSPACE_INTO_TITLE,
  type BackspaceIntoTitleDetail,
} from './extensions/title-handoff';
export {
  COMMENT_ADD_EVENT,
  COMMENT_OPEN_EVENT,
  anchorRange,
  rangeRect,
  revealThread,
  selectionAnchor,
  showCommentThreads,
  showPendingComment,
  threadRange,
  type SelectionAnchor,
  type ShownThread,
} from './extensions/comments';
// PEN-177: session detail, a note's shape and typing by block position and length.
export { attachNoteUsage, NoteUsage } from './usage';
