/**
 * Default shortcuts that differ by platform (A90): ⌘⌥ on a Mac; elsewhere
 * Ctrl+Alt is AltGr, so those defaults drop Ctrl. Playwright's browser runs on
 * the host's platform, so the host decides.
 */
const mac = process.platform === 'darwin';

export const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
export const NEW_FOLDER = mac ? 'Meta+Alt+Shift+KeyN' : 'Alt+Shift+KeyN';
export const VERSION_HISTORY = mac ? 'Meta+Alt+Shift+KeyH' : 'Alt+Shift+KeyH';
export const THIS_WEEK = mac ? 'Meta+Alt+KeyW' : 'Alt+KeyW';
/** T41: full-width notes, the Info panel, the sidebar rail. */
export const FULL_WIDTH = mac ? 'Meta+Alt+Shift+KeyW' : 'Alt+Shift+KeyW';
export const INFO_PANEL = mac ? 'Meta+Alt+Shift+KeyI' : 'Alt+Shift+KeyI';
export const SIDEBAR = 'ControlOrMeta+Backslash';

/**
 * Caret moves in text. On a Mac, Playwright sends the key's macOS editing command, so End and
 * Home scroll the page instead of moving the caret, Shift+Home selects to the top of the
 * document, and ⌘End does nothing. These keys do the same everywhere.
 */
export const LINE_START = mac ? 'Meta+ArrowLeft' : 'Home';
export const LINE_END = mac ? 'Meta+ArrowRight' : 'End';
export const SELECT_TO_LINE_START = mac ? 'Shift+Meta+ArrowLeft' : 'Shift+Home';
export const DOC_END = mac ? 'Meta+ArrowDown' : 'Control+End';
/** T45: the open note in a new window. */
export const NOTE_WINDOW = mac ? 'Meta+Alt+KeyO' : 'Alt+KeyO';
/** T44: a line symbol's slot (1–9), and the picker (0): ⌃digit on a Mac, Alt+Shift+digit elsewhere. */
export const SYMBOL = (slot: number) => (mac ? `Control+Digit${slot}` : `Alt+Shift+Digit${slot}`);
export const SYMBOL_PICKER = SYMBOL(0);
/** T48: Comment on the selection (or at the caret), and the Comments panel. */
export const COMMENT = mac ? 'Meta+Alt+Shift+KeyM' : 'Alt+Shift+KeyM';
export const COMMENTS_PANEL = mac ? 'Meta+Alt+Shift+KeyA' : 'Alt+Shift+KeyC';
