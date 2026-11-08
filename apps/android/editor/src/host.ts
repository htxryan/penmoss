/**
 * The editor page's side of the Android bridge (T32, A282; T33): it owns the
 * open note's Yjs document, built from the update bytes the app stores, and
 * hands every local change back to the app as bytes. It never touches the
 * network or the device token; the app syncs through `/sync/batch` and passes
 * what the server sent with `remote`.
 *
 * T33 adds what long-form writing on the phone needs: the native formatting
 * bar's commands and the state it shows (A301), Back closing the editor's own
 * menus first (A302), wikilink titles and `[[` completion from the phone's
 * note list (A303), pictures pasted, picked or shown through the app (A304),
 * the chosen theme (A305), conflict copies built here for the app (A306), and
 * the IME and scrolling care the T2 spike found (A307).
 *
 * T38 adds New note made here, offline included (`create`), and the note's
 * frontmatter tags, read and set here as the web's tag chips do (`tags`,
 * `setTag`): tags live in the note's document, which only the page reads.
 *
 * T40 P8 adds the editor's parity with the web: Copy as Markdown and rich
 * text through the app's clipboard (`copy`, `clipboard`), paste and match
 * style (`insertPlain`), the Markdown source (`source`), the + sheet and the
 * Block menu (`blocks`, `insert`, `turnInto`, `block`), the table and code
 * buttons, toggles remembered per note (`folds`) and the counts (`counts`).
 * Files through the app (`file`, `fileStored`, `insertFiles`, `fileInfo`,
 * `openFile`) and pictures from web addresses on the page's own origin
 * (`webPictures`, `/remote`), ED12 and ED13.
 *
 * T40 P7 adds `[[Title#` headings and live embeds from other notes' stored
 * updates (`noteContent`, `watchNote`, `noteChanged`; `linked.ts`), links
 * followed to a heading (`openNote` with `heading`, `showHeading`), and the
 * note's details for the Info sheet (`noteInfo`).
 *
 * T48 adds comment threads (`comments.ts`, `comments-protocol.ts`): the note's threads for the
 * Comments sheet, drawn in the note, and written here as the sheet asks.
 */
import { FuzzyMatcher } from '@penmoss/core/fuzzy';
import { extractLinks } from '@penmoss/core/links';
import { normaliseTag } from '@penmoss/core/tags';
import { capNoteText, MAX_NOTE_HEADINGS_BYTES } from '@penmoss/core/note-text';
import { noteHeadings } from '@penmoss/core/search';
import {
  addDays,
  addWeeks,
  DEFAULT_TIME_ZONE,
  isoWeek,
  isTimeZone,
  longDate,
  parseIsoWeek,
  parsePlainDate,
  todayIn,
  weekDays,
  weekMonday,
} from '@penmoss/core/periodic';
import {
  attachmentPath,
  filePath,
  IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  parseAttachmentPath,
  SNIFF_BYTES,
  sniffFileType,
  sniffImageType,
} from '@penmoss/core/attachments';
import { ulid } from '@penmoss/core/ids';
import { DEFAULT_SYMBOLS, findHeading, type LineSymbol } from '@penmoss/core/line-symbols';
import {
  activeSymbols,
  availableBlockItems,
  canHaveSymbols,
  canTurnInto,
  closeSymbolPicker,
  createCollabEditor,
  EDITOR_COMMANDS,
  filterBlockItems,
  hasPendingUpdates,
  latestUndoStep,
  indentCode,
  moveSelectedBlock,
  selectedTopLevelBlock,
  noteExtensions,
  pastePlainText,
  setNativeClipboard,
  symbolPickerOpen,
  toggleSymbolIn,
  TURN_INTO_ITEMS,
  turnInto,
  UnsupportedContentError,
  type BlockItem,
  type CollabEditor,
  type FileServices,
  type FoldState,
  type ImageServices,
  type LinkServices,
  type NativeClipboardPayload,
  type NoteCandidate,
  type SymbolSource,
  openLightboxNow,
} from '@penmoss/editor';
import { formatCombo } from '@penmoss/editor/keys';
import { noteFields } from '@penmoss/editor/note-fields';
import { docText, textStats } from '@penmoss/editor/stats';
import { bindTitleField, oneLineTitle } from '@penmoss/editor/title';
import { NOTE_ROOT } from '@penmoss/sync-client';
import {
  initNote,
  isoWithOffset,
  readIdentity,
  readNoteNotebook,
  readTitle,
} from '@penmoss/sync-client/note';
import type { LinkResolver } from '@penmoss/core';
import type { CommentAuthor } from '@penmoss/sync-client/comments';
import { conflictCopy, notebookRecord } from '@penmoss/sync-client/records';
import { frontmatterTags, noteTags, setFrontmatterTag } from '@penmoss/sync-client/tags';
import { bodyJson, createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import {
  applyThemeTo,
  builtInTheme,
  fontVariables,
  parseTheme,
  type Theme,
} from '@penmoss/ui/theme';
import {
  INTERFACE_FONT_SETTING,
  NOTE_FONT_SETTING,
  NOTE_FONT_SIZE_SETTING,
} from '@penmoss/core/fonts';
import type { Editor } from '@tiptap/core';
import { redoCommand, undoCommand } from '@y/prosemirror';
import * as Y from '@y/y';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { LinkedNotes } from './linked';
import { NoteComments, PHONE_AUTHOR } from './comments';
import type { CommentToEditor } from './comments-protocol';
import {
  BRIDGE_VERSION,
  MAX_FOLD_KEY,
  MAX_FILE_NAME,
  MAX_FOLDS,
  MAX_HEADING_CHARS,
  MAX_REPORTED_LINKS,
  parseToEditor,
  type BlockAction,
  type BlockEntry,
  type BlockPurpose,
  type Compacted,
  type CopyFormat,
  type CopyScope,
  type CopyFailure,
  type CopyInto,
  type DirectoryEntry,
  type EditorState,
  type FileAction,
  type FileEntry,
  type FormatCommand,
  type FromEditor,
  type InfoField,
  type NavTarget,
  type NewNote,
  type PeriodicNav,
  type StoredUpdate,
  type TextCounts,
  type ToEditor,
  type WebPictureMode,
} from './protocol';
import { PageKeys } from './keys';

/** The theme editor's sample note (A418): what the web's editor preview shows, as a note. */
export const PREVIEW_NOTE_ID = 'theme-preview';
export const PREVIEW_TITLE = 'Garden plan';
export const PREVIEW_HTML = [
  '<p>Raised beds by the <a href="https://example.com/fence">fence</a>, with <mark>tomatoes</mark> and <code>basil</code>.</p>',
  '<h2>This week</h2>',
  '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Turn the compost</p></li>',
  '<li data-type="taskItem" data-checked="false"><p>! Plant the peppers</p></li></ul>',
  '<div data-callout="tip" data-callout-title="Tip"><p>Water in the morning.</p></div>',
  '<pre><code class="language-js">const beds = 4; // by the fence\nplant(\'tomato\');</code></pre>',
  '<blockquote><p>The best time to plant a tree was twenty years ago.</p></blockquote>',
].join('');

/** Origin of updates that came from the app (stored or from the server): never echoed back. */
export const FROM_APP = Symbol('penmoss-android-app');

/**
 * Local edits are merged and sent once typing pauses this long (A289), so a
 * burst of typing makes one stored row rather than one per keystroke.
 */
export const EDIT_IDLE_MS = 400;

/**
 * Typing that never pauses still sends its edits this often, so they are
 * stored and synced. The page also sends at once when the note closes or the
 * app goes to the background, and the app has stored edits merged (`compact`).
 */
export const EDIT_MAX_WAIT_MS = 2_000;

/**
 * Typing pauses this long before the open note's text goes to the phone's offline index
 * (T40 P6, FD4): rendering a long note's text on every short pause would cost typing.
 */
export const TEXT_IDLE_MS = 3_000;

/**
 * Room kept between the caret and the WebView's edges, in CSS pixels (A307):
 * the native formatting bar sits right below the WebView, above the keyboard.
 */
export const CARET_MARGIN = { top: 24, bottom: 48, left: 0, right: 0 } as const;

/** Where the app serves a note's pictures from (A304): its own origin, never the network. */
export const ATTACHMENT_URL_PREFIX = '/attachments/';

/**
 * Where the app serves pictures from web addresses (T40 P8, ED13): the page's
 * own origin, `?u=<address>`, and `now=1` once tapped. The app fetches them;
 * the page's CSP still reaches nothing else.
 */
export const REMOTE_PICTURE_PATH = '/remote';

/** The longest web address a picture is fetched from. */
export const MAX_REMOTE_URL = 4096;

/** How long a chip waits for the app to say a file's size and type. */
export const FILE_INFO_MS = 5_000;

/**
 * Updates from other devices wait at most this long for the keyboard to finish
 * a word (A307): a keyboard may keep a word composing for as long as Ryan pauses.
 */
export const HOLD_MAX_MS = 3_000;

/** How long a pasted picture may wait for the app to store it before it is given up (A311). */
export const STORE_PICTURE_MS = 30_000;

/** The note's counts are taken once typing pauses this long, as the web's (T41, A505). */
export const COUNT_DELAY_MS = 400;

/** The selection's counts follow a selection change after this long, as the web's. */
export const SELECTION_COUNT_MS = 150;

/** The Markdown source follows edits after this long, as the web's source view (T11). */
export const SOURCE_DELAY_MS = 50;

/** What the page says when the app's clipboard write fails, as the web says it. */
export const COPY_REFUSED = "Copying wasn't allowed here";

/** The Block menu's actions: the shared editor commands (T40 P8, ED5). */
const BLOCK_COMMANDS: Record<BlockAction, string> = {
  moveUp: 'editor.moveBlockUp',
  moveDown: 'editor.moveBlockDown',
  duplicate: 'editor.duplicateBlock',
  delete: 'editor.deleteBlock',
};

/** What the + sheet and Turn into show of a block (the slash menu's label, glyph and hint). */
const blockEntry = (item: BlockItem): BlockEntry => ({
  id: item.id,
  label: item.label,
  icon: item.icon,
  ...(item.hint ? { hint: item.hint } : {}),
});

/** The note's frontmatter fields, as the web writes them (shared, so the two cannot drift). */
export { noteFields } from '@penmoss/editor/note-fields';

/**
 * The Info sheet's details are read at most this often while the note changes (T40 P7, NT23):
 * as the web's Info panel reads them, never per keystroke.
 */
export const INFO_EVERY_MS = 300;

/** How long a heading a link opened at stays marked (as the web's `pm-heading-target`). */
export const HEADING_MARK_MS = 2_000;

/** A frontmatter value as the web's Info panel shows it: a list in brackets. */
const frontmatterValue = (value: unknown): string =>
  Array.isArray(value) ? `[${value.join(', ')}]` : String(value);

/** A doc of these updates, or null when any of them builds on something not among them (A309). */
function completeDoc(updates: readonly StoredUpdate[]): Y.Doc | null {
  const doc = new Y.Doc();
  for (const stored of updates) Y.applyUpdate(doc, fromBase64(stored.update));
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
    doc.destroy();
    return null;
  }
  return doc;
}

/** A note's body, comparable as text. */
const bodyOf = (doc: Y.Doc) => JSON.stringify(doc.get(NOTE_ROOT).toDeltaDeep());

/** Whether a note's body holds nothing: no blocks, or only empty paragraphs. */
function holdsNothing(doc: Y.Doc): boolean {
  // As JSON: the delta's own lists are not arrays.
  const delta = JSON.parse(bodyOf(doc)) as { children?: unknown[] };
  for (const op of delta.children ?? []) {
    const insert = (op as { insert?: unknown }).insert;
    if (!Array.isArray(insert)) return false;
    for (const node of insert as Array<{ name?: string; children?: unknown[] }>) {
      if (node.name !== 'paragraph' || (node.children?.length ?? 0) > 0) return false;
    }
  }
  return true;
}

/** Merges stored updates when there is more than one. */
function compact(stored: readonly StoredUpdate[]): Compacted | null {
  if (stored.length < 2) return null;
  return {
    replaces: stored.map((entry) => entry.id),
    update: toBase64(Y.mergeUpdates(stored.map((entry) => fromBase64(entry.update)))),
  };
}

/** What the web's tag field says for a name that is not a tag (NoteTags). */
export const INVALID_TAG = 'A tag is letters, digits, - and _, with / for levels, and no spaces.';

/** Whether the WebView sizes a textarea to its text by itself (`field-sizing`, Chrome 123+). */
function supportsFieldSizing(): boolean {
  return typeof CSS === 'undefined' || typeof CSS.supports !== 'function'
    ? true
    : CSS.supports('field-sizing', 'content');
}

/** The title notes show by: as the web app's lists do. */
const displayTitle = (title: string) => title.trim() || 'Untitled';

/** The id of each bar command that is one of the shared editor commands (T20). */
const SHARED_COMMANDS: Partial<Record<FormatCommand, string>> = {
  bold: 'editor.bold',
  italic: 'editor.italic',
  strike: 'editor.strike',
  code: 'editor.code',
  highlight: 'editor.highlight',
  paragraph: 'editor.paragraph',
  heading1: 'editor.heading1',
  heading2: 'editor.heading2',
  heading3: 'editor.heading3',
  heading4: 'editor.heading4',
  heading5: 'editor.heading5',
  heading6: 'editor.heading6',
  bulletList: 'editor.bulletList',
  orderedList: 'editor.orderedList',
  taskList: 'editor.taskList',
  blockquote: 'editor.blockquote',
  codeBlock: 'editor.codeBlock',
  undo: 'editor.undo',
  redo: 'editor.redo',
};

/** Formatting the bar shows as on: a mark, a block type, or a list at the selection. */
const ACTIVE_CHECKS: ReadonlyArray<
  readonly [FormatCommand, string, Record<string, unknown> | undefined]
> = [
  ['bold', 'bold', undefined],
  ['italic', 'italic', undefined],
  ['strike', 'strike', undefined],
  ['code', 'code', undefined],
  ['highlight', 'highlight', undefined],
  ['link', 'link', undefined],
  ['heading1', 'heading', { level: 1 }],
  ['heading2', 'heading', { level: 2 }],
  ['heading3', 'heading', { level: 3 }],
  ['heading4', 'heading', { level: 4 }],
  ['heading5', 'heading', { level: 5 }],
  ['heading6', 'heading', { level: 6 }],
  ['bulletList', 'bulletList', undefined],
  ['orderedList', 'orderedList', undefined],
  ['taskList', 'taskList', undefined],
  ['blockquote', 'blockquote', undefined],
  ['codeBlock', 'codeBlock', undefined],
];

/** Web, mail and phone links only; a bare host name is taken as https. */
export function normaliseHref(raw: string): string | null {
  const href = raw.trim();
  if (!href) return null;
  if (/^(https?:|mailto:|tel:)/i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  return `https://${href.replace(/^\/+/, '')}`;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A selection the menu acts on (B2): in the body (mapped through edits), a text field, or the source. */
type SelectionBookmark = ReturnType<Editor['state']['selection']['getBookmark']>;
type Captured =
  | { readonly kind: 'body'; bookmark: SelectionBookmark }
  | {
      readonly kind: 'field';
      readonly field: HTMLInputElement | HTMLTextAreaElement;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: 'source'; readonly text: string };

/** Block kinds by node type, as Delete block's Undo snackbar names them (ED5). */
const BLOCK_NAMES: Readonly<Record<string, string>> = {
  paragraph: 'Paragraph',
  heading: 'Heading',
  bulletList: 'List',
  orderedList: 'List',
  taskList: 'Checklist',
  blockquote: 'Quote',
  codeBlock: 'Code block',
  table: 'Table',
  callout: 'Callout',
  horizontalRule: 'Divider',
  mathBlock: 'Math',
  embed: 'Embed',
};

/** What the source view says when asked to paste (T40 P8 review S6). */
export const SOURCE_PASTE = 'Show the note to paste into it';

/** What a selection copy says with nothing selected: never the whole note instead (B2). */
export const NOTHING_SELECTED = 'Select some text to copy';

/** What the snackbar's Undo says when the note was edited after Delete block (re-review). */
export const EDITED_SINCE = 'The note changed after the delete: use Undo on the bar';

/** What Block menu actions say while an update from another device waits (S4). */
export const WAIT_FOR_SYNC = 'Wait until the note has finished syncing';

/** A stored file's size and type, as the app reports it (ED12). */
type FileInfo = { readonly size: number; readonly type: string };

export interface HostElements {
  /** Shown once a note is open. */
  readonly root: HTMLElement;
  /** A textarea on the phone, so a long title wraps (T39); kept to one line of text. */
  readonly title: HTMLInputElement | HTMLTextAreaElement;
  readonly body: HTMLElement;
  /** The note's text, read-only, when it holds content this editor cannot show (A158). */
  readonly unsupported: HTMLElement;
}

export interface HostOptions {
  /** Sends bytes to the app (an `attachment`'s picture, A304), right after its message. */
  readonly postBytes?: (bytes: Uint8Array<ArrayBuffer>) => void;
  readonly idleMs?: number;
  readonly maxWaitMs?: number;
  /** How long typing pauses before the open note's text is reported (FD4). */
  readonly textIdleMs?: number;
  /** The clock for new notes' ids and `created` stamps. */
  readonly now?: () => Date;
}

interface OpenNote {
  readonly noteId: string;
  readonly replica: Yjs14Replica;
  readonly teardown: () => void;
  /** Sends the local edits not yet sent, merged into one update. */
  readonly flush: () => void;
  /** Reports the note's text when edits here changed it since it was last reported (FD4). */
  readonly sendText: () => void;
  collab: CollabEditor | null;
  /** Updates from the app held while the keyboard composes a word (A307). */
  readonly held: string[];
  /** Applies the held updates even mid-word once they have waited [HOLD_MAX_MS]. */
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** The note's pictures, files and wikilinks, as its editor has them (the + sheet's catalogue). */
  readonly images?: ImageServices;
  readonly files?: FileServices;
  readonly links?: LinkServices;
  /** Hides the Markdown source and shows the note again; null while the note shows (ED17). */
  sourceOff: (() => void) | null;
  /** The note's comment threads (T48), once its editor is made. */
  comments?: NoteComments;
}

export class EditorHost {
  private current: OpenNote | null = null;
  /** The open note's notebook as the app sees it (T43, A766), from `open`; null when not said. */
  private openNotebook: string | null = null;
  private readonly idleMs: number;
  private readonly maxWaitMs: number;
  private readonly textIdleMs: number;
  private readonly now: () => Date;
  private readonly postBytes: (bytes: Uint8Array<ArrayBuffer>) => void;

  /** The phone's notes, newest first (A303), and who wants to hear when titles change. */
  private notes: readonly DirectoryEntry[] = [];
  private notesById = new Map<string, DirectoryEntry>();
  private readonly matcher = new FuzzyMatcher();
  private readonly linkListeners = new Set<() => void>();

  /** Pasted pictures and files waiting for the app to store them, by path (A311). */
  private readonly storing = new Map<string, Array<(ok: boolean) => void>>();

  /** Chips waiting for the app to say their file's size and type, by path (ED12). */
  private readonly asking = new Map<string, Array<(info: FileInfo | null) => void>>();

  /** How pictures from web addresses show, as the app said before the note opened (ED13). */
  private webPictures: { noteId: string; mode: WebPictureMode } | null = null;
  /** Other notes' bodies for headings and embeds, over the bridge (T40 P7, A470, A471). */
  private readonly linked: LinkedNotes;

  /** The heading the open note was last scrolled to, and the mark's timer. */
  private headingMark: { element: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;

  /** A note this page made (`create`): its title takes the focus when it opens, as on the web. */
  private focusTitleOf: string | null = null;
  /** Whether the keyboard is up, as the app last said (review S8); null before it has. */
  private imeVisible: boolean | null = null;

  /** The person's line symbols, as the app last sent them (T44, A747); the defaults until then. */
  private symbols: readonly LineSymbol[] = DEFAULT_SYMBOLS;
  /** The theme the app last sent (A305), laid again under each change of the fonts. */
  private theme: { readonly theme: Theme; readonly variant: 'light' | 'dark' } | null = null;
  /** The person's fonts as the app last sent them (T51, A944); the theme's own until then. */
  private fonts: Readonly<Record<string, unknown>> | null = null;
  private readonly symbolListeners = new Set<() => void>();
  /** What every editor on the page reads its symbols from, live. */
  private readonly symbolSource: SymbolSource = {
    get: () => this.symbols,
    subscribe: (listener) => {
      this.symbolListeners.add(listener);
      return () => this.symbolListeners.delete(listener);
    },
  };

  /** Who this phone's comments are by (T48 review S5): the app's `commentAuthor`, else "You". */
  private commentAuthor: CommentAuthor = PHONE_AUTHOR;

  /** The toggles the app keeps for a note (T40 P8, ED8), sent before it opens. */
  private folds: { noteId: string; folds: Record<string, boolean> } | null = null;

  /**
   * What was selected, and where, when the selection menu opened (T40 P8
   * review B2): the menu's Copy as and Paste as plain text act on it, since
   * the WebView clears the selection as the menu closes.
   */
  private captured: { noteId: string; at: Captured } | null = null;

  /** The last Delete block and its undo step, for the snackbar's Undo (re-review). */
  private deletion: { noteId: string; step: object } | null = null;

  /** The counts last sent, so only changes are sent (NT24). */
  private lastCounts = '';

  /** The last state sent for the bar, so only changes are sent. */
  private lastState = '';
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The viewport height last seen, to tell the keyboard opening (A307). */
  private viewportHeight: number | null = null;
  /** A hardware keyboard's shortcuts in the note (T40 P9, PL9, A493). */
  readonly keys = new PageKeys({
    editor: () => {
      const editor = this.current?.collab?.editor;
      return editor?.isEditable ? editor : null;
    },
    noteId: () => this.current?.noteId ?? null,
    command: (id) =>
      this.post({ v: BRIDGE_VERSION, type: 'command', noteId: this.current?.noteId ?? null, id }),
  });
  /** Sizes the title field to its text where CSS can't (`field-sizing`); otherwise nothing. */
  private readonly fitTitle: () => void = () => undefined;

  constructor(
    private readonly elements: HostElements,
    private readonly post: (message: FromEditor) => void,
    options: HostOptions = {},
  ) {
    this.idleMs = options.idleMs ?? EDIT_IDLE_MS;
    this.maxWaitMs = options.maxWaitMs ?? EDIT_MAX_WAIT_MS;
    this.textIdleMs = options.textIdleMs ?? TEXT_IDLE_MS;
    this.now = options.now ?? (() => new Date());
    this.postBytes = options.postBytes ?? (() => undefined);
    this.linked = new LinkedNotes(post, (noteId) => {
      const open = this.current;
      return open && open.noteId === noteId && open.noteId !== PREVIEW_NOTE_ID
        ? bodyJson(open.replica.doc)
        : null;
    });
    // Enter in the title goes on to the note, as a phone keyboard's "next" key says.
    elements.title.enterKeyHint = 'next';
    elements.title.setAttribute('autocapitalize', 'sentences');
    // A title is one line of text (A16): a line break pasted or dictated into the wrapping field
    // becomes a space and control characters are dropped, by the same rule as the web's title
    // (`oneLineTitle`, A372), before the title is stored. Registered first, so the binding
    // stores the cleaned text; the caret stays on the same characters.
    elements.title.addEventListener('input', () => {
      const field = elements.title;
      const typed = field.value;
      const clean = oneLineTitle(typed);
      if (clean === typed) return;
      const { selectionStart, selectionEnd } = field;
      field.value = clean;
      if (selectionStart === null || selectionEnd === null) return;
      field.setSelectionRange(
        oneLineTitle(typed.slice(0, selectionStart)).length,
        oneLineTitle(typed.slice(0, selectionEnd)).length,
      );
    });
    // Through HTMLElement: the input/textarea union loses addEventListener's typed events.
    const titleElement: HTMLElement = elements.title;
    // The bar goes while the caret is in the title, and comes back when it leaves (A554).
    titleElement.addEventListener('focus', () => this.scheduleState());
    titleElement.addEventListener('blur', () => this.scheduleState());
    titleElement.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      // Never a line break in the title, whether or not the note can take the caret (T39 review).
      event.preventDefault();
      const editor = this.current?.collab?.editor;
      if (!editor?.isEditable) return;
      editor.chain().focus('start').scrollIntoView().run();
    });
    // A tap under the note's text puts the caret at its end, with the keyboard (T39 pass 2,
    // A527). On a phone a short note leaves most of the screen empty below it, and a tap there
    // did nothing: the note seemed not to take typing.
    elements.root.ownerDocument.addEventListener('click', (event) => this.tappedBelow(event));
    // Ahead of ProseMirror's keymaps, as the web's dispatcher listens (A70, A493).
    const view = elements.root.ownerDocument.defaultView;
    view?.addEventListener('keydown', this.keys.handleKeyDown, true);
    view?.addEventListener('keyup', this.keys.handleKeyUp, true);
    view?.addEventListener('blur', this.keys.handleBlur);
    // The image lightbox (T51, A948) opens over the page from an image's tools or a double tap;
    // the app hears of it, so the back gesture closes it and the note's bars step aside.
    const doc = elements.root.ownerDocument;
    let lightbox = false;
    new MutationObserver(() => {
      const open = openLightboxNow()?.open === true;
      if (open === lightbox) return;
      lightbox = open;
      this.post({ v: BRIDGE_VERSION, type: 'lightbox', open });
    }).observe(doc.body, { childList: true });
    // Chrome before 123 has no `field-sizing` (T39 review): there the field is given its text's
    // height here, as it is typed, set, rewritten from elsewhere, or the screen turns.
    const field = elements.title;
    if (field instanceof HTMLTextAreaElement && !supportsFieldSizing()) {
      this.fitTitle = () => {
        field.style.height = 'auto';
        field.style.height = `${field.scrollHeight}px`;
      };
      field.addEventListener('input', this.fitTitle);
      window.addEventListener('resize', this.fitTitle);
    }
  }

  /** Sends any edits still waiting for the batch timer (the app is going to the background). */
  flush(): void {
    this.current?.flush();
    this.current?.sendText();
  }

  /** The open note's editor, for tests and diagnostics. */
  get editor(): CollabEditor | null {
    return this.current?.collab ?? null;
  }

  get openNoteId(): string | null {
    return this.current?.noteId ?? null;
  }

  /** Says the page is loaded; the app sends `open` after this. */
  start(): void {
    this.post({ v: BRIDGE_VERSION, type: 'ready' });
  }

  /** Handles one raw message from the app. */
  receive(raw: string): void {
    const message = parseToEditor(raw);
    if (!message) {
      this.fail(null, 'The app sent a message this editor cannot read');
      return;
    }
    this.handle(message);
  }

  handle(message: ToEditor): void {
    switch (message.type) {
      case 'open':
        this.open(message);
        return;
      case 'remote':
        this.remote(message.noteId, message.update);
        return;
      case 'flush':
        if (this.current?.noteId === message.noteId) this.flush();
        return;
      case 'close':
        if (this.current?.noteId === message.noteId) this.close();
        // Said even when that note was not open, so the app never waits in vain.
        this.post({ v: BRIDGE_VERSION, type: 'closed', noteId: message.noteId });
        return;
      case 'compact': {
        // Merging needs no open document: Yjs merges the bytes as they are.
        let compacted: Compacted | null;
        try {
          compacted = compact(message.updates);
        } catch (error) {
          this.fail(message.noteId, `Stored edits could not be merged: ${String(error)}`);
          return;
        }
        if (compacted) {
          this.post({ v: BRIDGE_VERSION, type: 'compacted', noteId: message.noteId, compacted });
        }
        return;
      }
      case 'format':
        if (this.current?.noteId === message.noteId) this.format(message.command, message.href);
        return;
      case 'dismiss':
        if (this.current?.noteId === message.noteId) this.dismiss();
        return;
      case 'focus': {
        const editor = this.editableEditor(message.noteId);
        editor?.commands.focus(undefined, { scrollIntoView: true });
        return;
      }
      case 'focusTitle': {
        // Rename from a list (T40 P4, NT10): the caret goes in the title, as for a new note.
        if (this.current?.noteId !== message.noteId) return;
        const field = this.elements.title;
        if (!field.readOnly) field.focus();
        return;
      }
      case 'insertImages':
        this.insertImages(message.noteId, message.paths);
        return;
      case 'copyConflicts':
        this.copyConflicts(
          message.noteId,
          message.base,
          message.edits,
          message.into,
          message.notebook,
        );
        return;
      case 'attachmentStored': {
        const waiting = this.storing.get(message.path);
        this.storing.delete(message.path);
        for (const done of waiting ?? []) done(message.ok);
        return;
      }
      case 'theme':
        this.applyTheme(message.theme, message.variant);
        return;
      case 'fonts':
        // The person's fonts over the theme's (T51, A944), as the web lays them.
        this.fonts = {
          [INTERFACE_FONT_SETTING]: message.interface,
          [NOTE_FONT_SETTING]: message.note,
          [NOTE_FONT_SIZE_SETTING]: message.noteSize,
        };
        this.applyAppearance();
        return;
      case 'preview':
        this.preview();
        return;
      case 'closeLightbox':
        // The phone's back gesture (T51, A948): the lightbox goes, the note stays.
        openLightboxNow()?.close();
        return;
      case 'ime':
        // Whether the keyboard is up (T40 P6 review S8): hiding it does not blur the note.
        this.imeVisible = message.visible;
        return;
      case 'width':
        // Full width lifts only the theme's cap, as on the web (A501); the gutters stay.
        if (message.full) this.elements.root.dataset['width'] = 'full';
        else delete this.elements.root.dataset['width'];
        return;
      case 'symbols':
        // A change in Settings → Symbols, here or synced: open notes redraw (A741).
        if (JSON.stringify(message.symbols) === JSON.stringify(this.symbols)) return;
        this.symbols = message.symbols;
        for (const listener of [...this.symbolListeners]) listener();
        this.scheduleState();
        return;
      case 'commentAuthor':
        // This phone's device actor, as the server names it: new comments are written as it.
        this.commentAuthor = { id: message.id, kind: 'device', label: message.label };
        return;
      case 'symbol':
        this.toggleSymbol(message.noteId, message.index);
        return;
      case 'directory':
        this.setDirectory(message.notes);
        return;
      case 'create':
        this.create(message.noteId, message.notebook);
        return;
      case 'createPeriodic':
        this.createPeriodic(message);
        return;
      case 'periodicNav':
        this.periodicNav(message.noteId);
        return;
      case 'keys':
        this.keys.set(message.bindings, message.app);
        return;
      case 'setTag':
        this.setTag(message.noteId, message.tag, message.on);
        return;
      case 'copy':
        this.copy(message.noteId, message.format, message.scope);
        return;
      case 'insertPlain':
        this.insertPlain(message.noteId, message.text);
        return;
      case 'captureSelection':
        this.capture(message.noteId);
        return;
      case 'undoDelete':
        this.undoDelete(message.noteId);
        return;
      case 'source':
        this.showSource(message.noteId, message.on);
        return;
      case 'blocks':
        this.blocks(message.noteId, message.purpose, message.query);
        return;
      case 'insert':
        this.insertBlock(message.noteId, message.item);
        return;
      case 'turnInto':
        this.turnInto(message.noteId, message.item);
        return;
      case 'block':
        this.blockAction(message.noteId, message.action);
        return;
      case 'folds':
        this.folds = { noteId: message.noteId, folds: { ...message.folds } };
        return;
      case 'fileStored': {
        const waiting = this.storing.get(message.path);
        this.storing.delete(message.path);
        for (const done of waiting ?? []) done(message.ok);
        return;
      }
      case 'insertFiles':
        this.insertFileEntries(message.noteId, message.files);
        return;
      case 'fileInfo': {
        const waiting = this.asking.get(message.path);
        this.asking.delete(message.path);
        for (const done of waiting ?? []) done(message.info);
        return;
      }
      case 'webPictures':
        this.webPictures = { noteId: message.noteId, mode: message.mode };
        return;
      case 'noteContent':
        this.linked.received(message);
        return;
      case 'noteChanged':
        this.linked.changed(message.noteId);
        return;
      case 'showHeading':
        this.showHeading(message.noteId, message.heading);
        return;
      case 'commentDraft':
      case 'commentCreate':
      case 'commentReply':
      case 'commentEdit':
      case 'commentDelete':
      case 'commentDeleteThread':
      case 'commentStatus':
      case 'commentTarget':
      case 'commentActive':
      case 'commentSessions':
        this.comment(message);
        return;
    }
  }

  /** A change the Comments sheet asks for (T48): written in the open note's own document. */
  private comment(message: CommentToEditor): void {
    const open = this.current;
    if (!open || open.noteId !== message.noteId) return;
    if (!open.comments) {
      // The app's list of sessions (T60) is no request of Ryan's: nothing to say.
      if (message.type === 'commentSessions') return;
      this.notice(message.noteId, "This note can't take comments here.");
      return;
    }
    open.comments.handle(message);
  }

  /** Other notes' bodies and watches, for tests. */
  get linkedNotes(): LinkedNotes {
    return this.linked;
  }

  /**
   * Scrolls the open note to a heading, as the web does for `[[Note#Heading]]` (T40 P7, LK3):
   * the first top-level heading with that text (ignoring case and spaces at the ends), marked
   * for a moment. A heading the note no longer has leaves it where it is.
   */
  private showHeading(noteId: string, heading: string): void {
    const editor = this.current?.noteId === noteId ? this.current.collab?.editor : null;
    if (!editor || editor.isDestroyed) return;
    // The exact heading, else one that differs only by its line symbols (T44, A748).
    const headings: Array<{ text: string; offset: number }> = [];
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === 'heading') headings.push({ text: node.textContent, offset });
    });
    const index = findHeading(
      headings.map((each) => each.text),
      heading,
    );
    if (index < 0) return;
    const dom = editor.view.nodeDOM(headings[index]!.offset);
    if (!(dom instanceof HTMLElement)) return;
    dom.scrollIntoView({ block: 'start' });
    this.clearHeadingMark();
    dom.classList.add('pm-heading-target');
    this.headingMark = {
      element: dom,
      timer: setTimeout(() => this.clearHeadingMark(), HEADING_MARK_MS),
    };
  }

  private clearHeadingMark(): void {
    const mark = this.headingMark;
    if (!mark) return;
    clearTimeout(mark.timer);
    mark.element.classList.remove('pm-heading-target');
    this.headingMark = null;
  }

  /**
   * The open note's details for the Info sheet (T40 P7, NT23): when it was made, its kind and
   * period, its frontmatter as the web's Info panel shows it (`noteFields`), and the notes it
   * links to or embeds, which the app keeps for backlinks (A473).
   */
  private noteInfo(
    noteId: string,
    replica: Yjs14Replica,
    editor: Editor | null,
  ): Extract<FromEditor, { type: 'noteInfo' }> {
    const doc = replica.doc;
    const identity = readIdentity(doc);
    const title = readTitle(doc);
    const tags = frontmatterTags(doc);
    const kind = identity.kind ?? 'note';
    const values: Record<string, unknown> = {
      id: noteId,
      ...(title ? { title } : {}),
      ...(identity.created ? { created: identity.created } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(kind !== 'note' ? { type: kind } : {}),
    };
    const fields: InfoField[] = Object.entries(values).map(([key, value]) => ({
      key,
      value: frontmatterValue(value),
    }));
    let links: string[];
    try {
      const targets = new Set<string>();
      const add = (target: unknown) => {
        if (typeof target === 'string' && target && target !== noteId) targets.add(target);
      };
      if (editor && !editor.isDestroyed) {
        // The editor's own tree, already built: no second copy of the note per read (A307).
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'wikilink' || node.type.name === 'embed')
            add(node.attrs['noteId']);
          return true;
        });
      } else {
        for (const link of extractLinks(bodyJson(doc))) add(link.noteId);
      }
      links = [...targets].sort().slice(0, MAX_REPORTED_LINKS);
    } catch {
      links = [];
    }
    return {
      v: BRIDGE_VERSION,
      type: 'noteInfo',
      noteId,
      created: identity.created ?? null,
      kind,
      period: identity.period ?? null,
      fields,
      links,
    };
  }

  close(): void {
    const open = this.current;
    this.current = null;
    // A selection or a delete belongs to the note as it was shown (re-review).
    this.captured = null;
    this.deletion = null;
    if (!open) return;
    open.flush();
    open.sendText();
    open.teardown();
    this.elements.root.hidden = true;
    delete this.elements.root.dataset['preview'];
    if (this.stateTimer !== null) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.lastState = '';
    this.lastCounts = '';
  }

  /**
   * The WebView's height changed (A307). When it shrank, the keyboard opened
   * or grew over the note: bring the caret back above the formatting bar.
   */
  viewportChanged(height: number): void {
    const before = this.viewportHeight;
    this.viewportHeight = height;
    const editor = this.current?.collab?.editor;
    if (before === null || height >= before || !editor?.isFocused) return;
    editor.commands.scrollIntoView();
  }

  private open(message: Extract<ToEditor, { type: 'open' }>): void {
    this.close();
    const { noteId } = message;
    // Where the app sees it (T43, A766): a link's new note made from it records this notebook.
    this.openNotebook = message.notebook ?? null;
    const replica = createYjs14Replica();
    let compacted: Compacted | null;
    let compactedPending: Compacted | null;
    try {
      for (const stored of [...message.synced, ...message.pending]) {
        replica.applyUpdate(fromBase64(stored.update), FROM_APP);
      }
      compacted = compact(message.synced);
      compactedPending = compact(message.pending);
    } catch (error) {
      replica.destroy();
      this.fail(noteId, `The note's stored data could not be read: ${String(error)}`);
      return;
    }

    const { title, body, unsupported, root } = this.elements;
    let lastTitle = readTitle(replica.doc);
    // Frontmatter tags are attributes: cheap to read on every change, as the web's chips do.
    let lastTags = frontmatterTags(replica.doc);
    // The Info sheet's details (T40 P7): sent when they change, read at most every 300 ms.
    let lastInfo = '';
    let infoTimer: ReturnType<typeof setTimeout> | null = null;
    const sendInfo = () => {
      infoTimer = null;
      if (this.current?.replica !== replica) return;
      const info = this.noteInfo(noteId, replica, this.current.collab?.editor ?? null);
      const key = JSON.stringify(info);
      if (key === lastInfo) return;
      lastInfo = key;
      this.post(info);
    };
    let unsent: Uint8Array<ArrayBuffer>[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    // When the oldest unsent edit was made: typing that never pauses is sent this long after.
    let firstUnsentAt: number | null = null;
    const flush = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      firstUnsentAt = null;
      if (unsent.length === 0) return;
      const update = unsent.length === 1 ? unsent[0]! : Y.mergeUpdates(unsent);
      unsent = [];
      this.post({ v: BRIDGE_VERSION, type: 'update', noteId, update: toBase64(update) });
    };
    // The offline index (T40 P6, FD4): once typing pauses for long, and as the note closes,
    // the text this phone's own edits made, so the phone finds them before the server has them.
    let textChanged = false;
    let textTimer: ReturnType<typeof setTimeout> | null = null;
    const sendText = () => {
      if (textTimer !== null) clearTimeout(textTimer);
      textTimer = null;
      if (!textChanged) return;
      textChanged = false;
      this.post({
        v: BRIDGE_VERSION,
        type: 'text',
        noteId,
        text: capNoteText(replica.plainText()),
        // The index's headings column (review S6) and the note's tags as this phone has them,
        // frontmatter and inline, for the tag browser before the server indexes them (S5).
        headings: capNoteText(noteHeadings(bodyJson(replica.doc)), MAX_NOTE_HEADINGS_BYTES),
        tags: noteTags(replica.doc),
      });
    };
    const offUpdate = replica.onUpdate((update, origin, info) => {
      const commentsOnly = info?.commentsOnly === true;
      // The Comments sheet's list follows its threads, here or from elsewhere (T48).
      if (this.current?.replica === replica) this.current.comments?.changed(commentsOnly);
      // Local edits (typing, the title field) go to the app to store and upload.
      if (origin !== FROM_APP) {
        // A comment is no edit (A770): the offline index's text stays as it is.
        if (!commentsOnly) {
          textChanged = true;
          if (textTimer !== null) clearTimeout(textTimer);
          textTimer = setTimeout(sendText, this.textIdleMs);
        }
        // A copy: Yjs may reuse the buffer it hands listeners.
        unsent.push(new Uint8Array(update));
        const now = Date.now();
        firstUnsentAt ??= now;
        if (timer !== null) clearTimeout(timer);
        // Sent once typing pauses, or when the oldest waiting edit is EDIT_MAX_WAIT_MS old.
        const wait = Math.min(this.idleMs, firstUnsentAt + this.maxWaitMs - now);
        timer = setTimeout(flush, Math.max(0, wait));
      }
      const next = readTitle(replica.doc);
      if (next !== lastTitle) {
        lastTitle = next;
        this.post({ v: BRIDGE_VERSION, type: 'title', noteId, title: next });
        // Once the title binding, which listens after this, has rewritten the field.
        queueMicrotask(this.fitTitle);
      }
      // Here or on another device: the app's tag sheet follows either.
      const tags = frontmatterTags(replica.doc);
      if (tags.join('\n') !== lastTags.join('\n')) {
        lastTags = tags;
        this.post({ v: BRIDGE_VERSION, type: 'tags', noteId, tags });
      }
      // The Info sheet's details, at most every INFO_EVERY_MS (T40 P7, NT23).
      infoTimer ??= setTimeout(sendInfo, INFO_EVERY_MS);
    });
    title.value = '';
    const unbindTitle = bindTitleField(title, replica);
    title.readOnly = !message.editable;
    this.fitTitle();

    const cleanups: Array<() => void> = [];
    const files = this.files(noteId);
    const images = files;
    const links = this.links(noteId);
    const open: OpenNote = {
      noteId,
      replica,
      collab: null,
      flush,
      sendText,
      held: [],
      holdTimer: null,
      images,
      files,
      links,
      sourceOff: null,
      teardown: () => {
        if (open.holdTimer !== null) clearTimeout(open.holdTimer);
        open.sourceOff?.();
        if (infoTimer !== null) clearTimeout(infoTimer);
        this.clearHeadingMark();
        if (textTimer !== null) clearTimeout(textTimer);
        for (const cleanup of cleanups.splice(0)) cleanup();
        offUpdate();
        unbindTitle();
        open.collab?.destroy();
        body.replaceChildren();
        unsupported.hidden = true;
        unsupported.textContent = '';
        replica.destroy();
      },
    };
    this.current = open;

    try {
      open.collab = createCollabEditor({
        element: body,
        extensions: noteExtensions({
          links,
          images,
          files,
          // Toggles open as this phone left them (T40 P8, ED8), kept by the app per note.
          foldState: this.foldState(noteId),
          // Line symbols (T44, A747): the synced list, the picker's Edit symbols… opening
          // Settings → Symbols, and a hardware keyboard's shortcut for each.
          symbols: this.symbolSource,
          onEditSymbols: () =>
            this.post({ v: BRIDGE_VERSION, type: 'command', noteId, id: 'app.symbols' }),
          symbolShortcut: (index) => {
            const combo = this.keys.keysOf(`editor.symbol${index + 1}`)[0];
            return combo ? formatCombo(combo) : null;
          },
          // Comment threads (T48): their highlights, and the editor's Comment command.
          comments: true,
          // Copy as Markdown of a whole note carries its frontmatter, as on the web (T15).
          clipboard: {
            note: () => noteFields(noteId, replica),
            onCopy: (_format, ok) => {
              if (!ok) this.notice(noteId, COPY_REFUSED);
            },
          },
        }),
        replica,
        // A later version's content arrived while open: show it read-only from now on (A158).
        onUnsupported: (nodeTypes) => this.showUnsupported(open, nodeTypes),
      });
      const { editor } = open.collab;
      editor.view.dom.setAttribute('aria-label', 'Note body');
      editor.setEditable(message.editable);
      cleanups.push(this.prepareForTyping(open, editor));
      cleanups.push(this.countWords(open, editor));
      // A body selection kept for the selection menu follows edits made meanwhile (B2).
      const follow = ({
        transaction,
      }: {
        transaction: { mapping: Parameters<SelectionBookmark['map']>[0] };
      }) => {
        const at = this.captured?.noteId === noteId ? this.captured.at : null;
        if (at?.kind === 'body') at.bookmark = at.bookmark.map(transaction.mapping);
      };
      editor.on('transaction', follow);
      cleanups.push(() => editor.off('transaction', follow));
      // Copies (and a code block's Copy button) go to the app's clipboard (T40 P8, ED9, ED7).
      setNativeClipboard((payload) => Promise.resolve(this.toClipboard(open, payload)));
      cleanups.push(() => setNativeClipboard(null));
      cleanups.push(this.tagTaps(noteId, editor));
      // The note's threads (T48): listed for the Comments sheet and drawn in the note.
      open.comments = new NoteComments(noteId, replica, editor, {
        post: (message) => this.post(message),
        notice: (text) => this.notice(noteId, text),
        editable: () => this.current === open && !editor.isDestroyed && editor.isEditable,
        restoreCaptured: () => {
          const captured = this.take(noteId);
          return captured?.kind === 'body' && this.restore(editor, captured.bookmark) !== null;
        },
        now: () => this.now().getTime(),
        author: () => this.commentAuthor,
        // Send to… (T60, A1078): the target and `waiting` reach the app before `commentSent`.
        flush: () => open.flush(),
      });
      cleanups.push(() => open.comments?.destroy());
    } catch (error) {
      if (!(error instanceof UnsupportedContentError)) {
        this.close();
        this.fail(noteId, `The note could not be opened: ${String(error)}`);
        return;
      }
      this.showUnsupported(open, error.nodeTypes);
    }
    root.hidden = false;
    this.post({
      v: BRIDGE_VERSION,
      type: 'opened',
      noteId,
      title: lastTitle,
      compacted,
      compactedPending,
    });
    this.post({ v: BRIDGE_VERSION, type: 'tags', noteId, tags: lastTags });
    sendInfo();
    // And its comment threads (T48), drawn in the note and listed for the Comments sheet.
    open.comments?.start();
    if (this.focusTitleOf === noteId) {
      this.focusTitleOf = null;
      if (message.editable && !title.readOnly) title.focus();
    }
  }

  /**
   * A daily or weekly note (T40 P5), as the web makes one: the period comes
   * from `day`, or from today in the synced time zone when null (never the
   * phone's zone), and the note is built with the deterministic
   * `periodicNote`, so a note made offline merges with one copy of the
   * template. The app stores it as one pending edit and files it through the
   * daily intent. A note already held is just opened: building it again
   * writes the same bytes under the same id.
   */
  private createPeriodic(message: Extract<ToEditor, { type: 'createPeriodic' }>): void {
    void this.makePeriodic(message);
  }

  /**
   * [createPeriodic]'s work. The period resolves with core's small periodic module; the note's
   * codec and template filler load only now, as the web loads them (`ensurePeriodic`), so a
   * note's page never parses all of core at startup (T40 P5 review S5).
   */
  private async makePeriodic(
    message: Extract<ToEditor, { type: 'createPeriodic' }>,
  ): Promise<void> {
    const { kind, day, at, timeZone, template, request } = message;
    try {
      const zone = isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
      let atDay;
      if (day !== null) {
        atDay = parsePlainDate(day);
        if (!atDay) throw new RangeError(`Not a day: ${day}`);
      } else {
        atDay = todayIn(zone, new Date(at));
      }
      const period = kind === 'daily' ? atDay.toString() : isoWeek(atDay).toString();
      const date = kind === 'daily' ? atDay.toString() : weekMonday(isoWeek(atDay)).toString();
      const [{ periodicNote }, codec] = await Promise.all([
        import('@penmoss/editor/periodic'),
        import('@penmoss/core'),
      ]);
      const note = periodicNote(codec, kind, period, template);
      const made: NewNote = { id: note.id, title: note.period, update: toBase64(note.update) };
      this.post({ v: BRIDGE_VERSION, type: 'createdPeriodic', note: made, kind, period, date });
    } catch (error) {
      this.fail(null, `The ${kind} note could not be made: ${String(error)}`, request);
    }
  }

  /**
   * What period the open note is, and what surrounds it (T40 P5, JR4): read
   * from its own document, with core's functions only. Null when it is no
   * periodic note, or nothing is open.
   */
  private periodicNav(noteId: string): void {
    const open = this.current;
    if (!open || open.noteId !== noteId) {
      this.post({ v: BRIDGE_VERSION, type: 'periodicNav', noteId, nav: null });
      return;
    }
    const { kind, period } = readIdentity(open.replica.doc);
    let nav: PeriodicNav | null = null;
    try {
      if (kind === 'daily' && period) {
        const date = parsePlainDate(period);
        if (date) {
          const day = (step: number): NavTarget => {
            const at = addDays(date, step);
            return {
              date: at.toString(),
              label: at.toString(),
              full: longDate(at),
              period: at.toString(),
            };
          };
          const monday = weekMonday(isoWeek(date));
          nav = {
            kind,
            period,
            label: longDate(date),
            prev: day(-1),
            next: day(1),
            week: {
              date: monday.toString(),
              label: `Week ${isoWeek(date).toString()}`,
              full: `Week of ${longDate(monday)}`,
              period: isoWeek(date).toString(),
            },
            days: null,
          };
        }
      } else if (kind === 'weekly' && period) {
        const week = parseIsoWeek(period);
        if (week) {
          const at = (step: number): NavTarget => {
            const target = addWeeks(week, step);
            const monday = weekMonday(target);
            return {
              date: monday.toString(),
              label: target.toString(),
              full: `Week of ${longDate(monday)}`,
              period: target.toString(),
            };
          };
          nav = {
            kind,
            period,
            label: `Week ${period}`,
            prev: at(-1),
            next: at(1),
            week: null,
            days: weekDays(week).map((date) => ({
              date: date.toString(),
              label: `${longDate(date).slice(0, 3)} ${date.day}`,
              full: longDate(date),
              period: date.toString(),
            })),
          };
        }
      }
    } catch {
      nav = null;
    }
    this.post({ v: BRIDGE_VERSION, type: 'periodicNav', noteId, nav });
  }

  /**
   * New note (T38), as the web makes one: an empty note with this id, built
   * here because only the page writes Yjs. The app stores it as one pending
   * edit, so it uploads when it can and opens offline at once.
   */
  private create(noteId: string, notebook: string | undefined): void {
    const now = this.now();
    const replica = createYjs14Replica();
    let note: NewNote;
    try {
      // Its notebook recorded with its identity, in the same transaction (T43, A766).
      initNote(replica.doc, {
        id: noteId,
        created: isoWithOffset(now),
        kind: 'note',
        ...(notebook ? { notebook } : {}),
      });
      note = { id: noteId, title: '', update: toBase64(replica.encodeStateAsUpdate()) };
    } finally {
      replica.destroy();
    }
    this.focusTitleOf = noteId;
    this.post({ v: BRIDGE_VERSION, type: 'created', noteId, note });
  }

  /**
   * Adds or removes one frontmatter tag on the open note (T38), exactly as the
   * web's tag chips do (`setFrontmatterTag`): an attribute per tag, so two
   * devices tagging at once keep both. The change goes to the app as any edit
   * does, and the new list follows as `tags`. A read-only note is left alone.
   */
  private setTag(noteId: string, raw: string, on: boolean): void {
    const open = this.current;
    // Opened read-only, or holding content this editor cannot show (A158).
    const editable = this.editableEditor(noteId) !== null && !this.elements.title.readOnly;
    if (!open || open.noteId !== noteId || !editable) {
      this.notice(noteId, 'This note cannot be changed here');
      return;
    }
    const tag = normaliseTag(raw);
    if (!tag) {
      this.notice(noteId, INVALID_TAG);
      return;
    }
    setFrontmatterTag(open.replica.doc, tag, on);
  }

  /**
   * What the T2 spike found typing on a phone needs (A307): the keyboard's own
   * corrections, room for the caret above the bar, updates from other devices
   * held while a word is being composed, and the bar's state kept current.
   */
  private prepareForTyping(open: OpenNote, editor: Editor): () => void {
    const dom = editor.view.dom;
    dom.setAttribute('autocapitalize', 'sentences');
    dom.setAttribute('autocorrect', 'on');
    dom.setAttribute('spellcheck', 'true');
    editor.view.setProps({ scrollThreshold: CARET_MARGIN, scrollMargin: CARET_MARGIN });
    // Other devices' changes land between words, never inside the keyboard's composition.
    const release = () => setTimeout(() => this.releaseHeld(open), 0);
    dom.addEventListener('compositionend', release);
    dom.addEventListener('blur', release);
    const changed = () => this.scheduleState();
    editor.on('transaction', changed);
    editor.on('focus', changed);
    editor.on('blur', changed);
    this.scheduleState();
    return () => {
      dom.removeEventListener('compositionend', release);
      dom.removeEventListener('blur', release);
      editor.off('transaction', changed);
      editor.off('focus', changed);
      editor.off('blur', changed);
    };
  }

  /**
   * Inline `#tags` open their notes (T40 P6, TG5, A469): a tap while reading (the keyboard down,
   * or the note read-only), or a Ctrl-tap from a hardware keyboard as the web's ⌘-click. While
   * typing, a tap on a tag places the caret in it, as anywhere else in the text. The reading tap
   * is kept from focusing the note, so the keyboard does not rise as the app leaves the note.
   */
  private tagTaps(noteId: string, editor: Editor): () => void {
    const dom = editor.view.dom;
    const tagAt = (event: MouseEvent): string | null => {
      if (event.button !== 0 || !(event.target instanceof Element)) return null;
      const tag = event.target.closest<HTMLElement>('.pm-tag')?.dataset['tag'];
      return tag && normaliseTag(tag) === tag ? tag : null;
    };
    // Reading: the keyboard is down (the app says so; hiding it leaves the note focused), or,
    // before the app has said, the note has no focus. Read-only notes are always read.
    const opens = (event: MouseEvent) =>
      event.ctrlKey ||
      event.metaKey ||
      !editor.isEditable ||
      !editor.view.hasFocus() ||
      this.imeVisible === false;
    let chosen: string | null = null;
    const down = (event: MouseEvent) => {
      const tag = tagAt(event);
      chosen = tag && opens(event) ? tag : null;
      // ProseMirror skips an event already handled, and the browser then neither focuses nor
      // moves the caret.
      if (chosen) event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      const tag = tagAt(event);
      if (!tag || tag !== chosen) return;
      chosen = null;
      event.preventDefault();
      this.post({ v: BRIDGE_VERSION, type: 'openTag', noteId, tag });
    };
    dom.addEventListener('mousedown', down, true);
    dom.addEventListener('click', click);
    return () => {
      dom.removeEventListener('mousedown', down, true);
      dom.removeEventListener('click', click);
    };
  }

  private remote(noteId: string, update: string): void {
    const open = this.current;
    // A late reply for a note that has since closed: the app has stored it already.
    if (!open || open.noteId !== noteId) return;
    if (open.collab?.editor.view.composing) {
      open.held.push(update);
      open.holdTimer ??= setTimeout(() => this.releaseHeld(open, true), HOLD_MAX_MS);
      return;
    }
    this.releaseHeld(open);
    this.applyFromApp(open, update);
  }

  /**
   * Applies the updates held while the keyboard was composing, oldest first;
   * `force` once they have waited too long for the word to end.
   */
  private releaseHeld(open: OpenNote, force = false): void {
    if (this.current !== open || (!force && open.collab?.editor.view.composing)) return;
    if (open.holdTimer !== null) clearTimeout(open.holdTimer);
    open.holdTimer = null;
    for (const update of open.held.splice(0)) this.applyFromApp(open, update);
  }

  private applyFromApp(open: OpenNote, update: string): void {
    try {
      open.replica.applyUpdate(fromBase64(update), FROM_APP);
    } catch (error) {
      this.fail(open.noteId, `An update from the server could not be applied: ${String(error)}`);
    }
  }

  /**
   * A tap on the blank page below the note's text: the caret goes to the note's end (A527).
   * Only a tap on the page itself counts; anything drawn on it (the slash and `[[` menus, which
   * sit on the page's body and close as they apply a choice, a link, a field) keeps its tap.
   */
  private tappedBelow(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0) return;
    const { root, body } = this.elements;
    const page = root.ownerDocument;
    const target = event.target;
    if (target !== page.documentElement && target !== page.body && target !== root) return;
    const open = this.current;
    const editor = open ? this.editableEditor(open.noteId) : null;
    if (!editor || event.clientY < body.getBoundingClientRect().bottom) return;
    editor.chain().focus('end').scrollIntoView().run();
  }

  private editableEditor(noteId: string): Editor | null {
    const editor = this.current?.noteId === noteId ? this.current.collab?.editor : null;
    return editor && !editor.isDestroyed && editor.isEditable ? editor : null;
  }

  /** A button of the native formatting bar (A301). */
  private format(command: FormatCommand, href: string | undefined): void {
    const open = this.current;
    const editor = open ? this.editableEditor(open.noteId) : null;
    if (!editor) return;
    const shared = SHARED_COMMANDS[command];
    if (shared) {
      EDITOR_COMMANDS.find((each) => each.id === shared)?.run({ editor });
    } else if ((command === 'indent' || command === 'outdent') && editor.isActive('codeBlock')) {
      // In code, Tab and Shift+Tab: the soft keyboard has neither (T40 P8, ED7).
      editor.commands.focus();
      indentCode(command === 'indent' ? 'in' : 'out')(editor.state, editor.view.dispatch);
    } else if (command === 'nextCell' || command === 'previousCell') {
      // Tab and Shift+Tab between cells (T40 P8, ED6); Next cell in the last cell adds a row.
      const chain = editor.chain().focus();
      if (command === 'previousCell') chain.goToPreviousCell().run();
      else if (!editor.can().goToNextCell()) chain.addRowAfter().goToNextCell().run();
      else chain.goToNextCell().run();
    } else if (command === 'addRow') {
      editor.chain().focus().addRowAfter().run();
    } else if (command === 'addColumn') {
      editor.chain().focus().addColumnAfter().run();
    } else if (command === 'indent' || command === 'outdent') {
      const chain = () => editor.chain().focus();
      const ok =
        command === 'indent'
          ? chain().sinkListItem('listItem').run() || chain().sinkListItem('taskItem').run()
          : chain().liftListItem('listItem').run() || chain().liftListItem('taskItem').run();
      if (!ok) editor.commands.focus();
    } else if (command === 'link') {
      this.setLink(editor, href ?? '');
    }
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /** Links the selection (or the link the caret is in) to `raw`; empty removes the link. */
  private setLink(editor: Editor, raw: string): void {
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!raw.trim()) {
      chain.unsetLink().run();
      return;
    }
    const href = normaliseHref(raw);
    if (!href) {
      this.notice(this.current?.noteId ?? null, 'Only web, mail and phone links can be added');
      return;
    }
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive('link')) {
      // Nothing selected: the address itself becomes the linked text.
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: raw.trim(),
          marks: [{ type: 'link', attrs: { href } }],
        })
        .unsetMark('link')
        .run();
      return;
    }
    chain.setLink({ href }).run();
  }

  /** The bar's symbol sheet (T44, A747): one toggle on the selection's lines, its own undo step. */
  private toggleSymbol(noteId: string, index: number): void {
    const editor = this.editableEditor(noteId);
    if (!editor) return;
    toggleSymbolIn(editor.view, index);
    editor.commands.focus();
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /** Back while a menu is open closes the menu, as Escape does (A302). */
  private dismiss(): void {
    const editor = this.current?.collab?.editor;
    if (editor && closeSymbolPicker(editor)) {
      this.scheduleState();
      return;
    }
    if (!editor || !this.menuOpen()) return;
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    this.scheduleState();
  }

  private menuOpen(): boolean {
    const editor = this.current?.collab?.editor;
    if (editor && !editor.isDestroyed && symbolPickerOpen(editor)) return true;
    return this.elements.root.ownerDocument.querySelector('.pm-slash-menu') !== null;
  }

  private scheduleState(): void {
    if (this.stateTimer !== null) return;
    // After the transaction, once the menus' views have updated.
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.sendState();
    }, 0);
  }

  /** What the formatting bar shows, sent when it changed (A301). */
  private sendState(): void {
    const open = this.current;
    const editor = open?.collab?.editor;
    if (!open || !editor || editor.isDestroyed) return;
    const { state } = editor;
    const inCode = editor.isActive('codeBlock');
    const can = (run: () => boolean) => {
      try {
        return editor.isEditable && run();
      } catch {
        return false;
      }
    };
    const current: EditorState = {
      active: ACTIVE_CHECKS.filter(([, name, attrs]) => editor.isActive(name, attrs)).map(
        ([command]) => command,
      ),
      canUndo: can(() => undoCommand(state)),
      canRedo: can(() => redoCommand(state)),
      canIndent: can(
        () =>
          inCode || editor.can().sinkListItem('listItem') || editor.can().sinkListItem('taskItem'),
      ),
      canOutdent: can(
        () =>
          (inCode && indentCode('out')(state)) ||
          editor.can().liftListItem('listItem') ||
          editor.can().liftListItem('taskItem'),
      ),
      href: editor.isActive('link')
        ? ((editor.getAttributes('link')['href'] as string | undefined) ?? null)
        : null,
      menu: this.menuOpen(),
      inTable: editor.isActive('table'),
      inCode,
      canMoveUp: can(() => moveSelectedBlock(-1)(state)),
      canMoveDown: can(() => moveSelectedBlock(1)(state)),
      canTurnInto: can(() => canTurnInto(editor)),
      inTitle: this.elements.root.ownerDocument.activeElement === this.elements.title,
      symbols: activeSymbols(state),
      canSymbol: can(() => canHaveSymbols(state)),
    };
    const text = JSON.stringify(current);
    if (text === this.lastState) return;
    this.lastState = text;
    this.post({ v: BRIDGE_VERSION, type: 'state', noteId: open.noteId, ...current });
  }

  /**
   * Copy as Markdown or rich text (T40 P8, ED9): the editor's own commands,
   * so the payload is exactly the web's (`clipboardPayload`), handed to the
   * app through the native clipboard writer. A read-only note copies too.
   */
  private copy(noteId: string, format: CopyFormat, scope: CopyScope): void {
    const editor = this.current?.noteId === noteId ? this.current.collab?.editor : null;
    const captured = this.take(noteId);
    if (!editor || editor.isDestroyed) {
      this.notice(noteId, 'This note cannot be copied here');
      return;
    }
    if (scope === 'note') {
      editor.commands.copyNoteAs(format);
      return;
    }
    // The selection the menu was opened on: a field's or the source's text as it is.
    if (captured && captured.kind !== 'body') {
      const text =
        captured.kind === 'source'
          ? captured.text
          : captured.field.value.slice(captured.start, captured.end);
      if (!text) this.notice(noteId, NOTHING_SELECTED);
      else this.post({ v: BRIDGE_VERSION, type: 'clipboard', noteId, format: 'text', text });
      return;
    }
    // The body's, put back if the WebView cleared it, and never the whole note instead.
    const selection = captured ? this.restore(editor, captured.bookmark) : editor.state.selection;
    if (!selection || selection.empty) {
      this.notice(noteId, NOTHING_SELECTED);
      return;
    }
    if (format === 'markdown') editor.commands.copyAsMarkdown();
    else editor.commands.copyAsRichText();
  }

  /**
   * Keeps what is selected now and where (B2): the selection menu has opened,
   * and the WebView clears the selection as it closes, before the menu's
   * message arrives. The body's is a bookmark, mapped through edits meanwhile.
   */
  private capture(noteId: string): void {
    const open = this.current;
    if (!open || open.noteId !== noteId) return;
    const doc = this.elements.root.ownerDocument;
    const active = doc.activeElement;
    const editor = open.collab?.editor;
    let at: Captured | null = null;
    if (open.sourceOff) {
      at = { kind: 'source', text: doc.getSelection()?.toString() ?? '' };
    } else if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
      (active === this.elements.title || this.elements.body.contains(active))
    ) {
      at = {
        kind: 'field',
        field: active,
        start: active.selectionStart ?? active.value.length,
        end: active.selectionEnd ?? active.value.length,
      };
    } else if (editor && !editor.isDestroyed) {
      at = { kind: 'body', bookmark: editor.state.selection.getBookmark() };
    }
    this.captured = at ? { noteId, at } : null;
  }

  /** The capture for this note, used once. */
  private take(noteId: string): Captured | null {
    const captured = this.captured?.noteId === noteId ? this.captured.at : null;
    this.captured = null;
    return captured;
  }

  /** Puts a captured body selection back (mapped through edits since), or null if it no longer fits. */
  private restore(editor: Editor, bookmark: SelectionBookmark) {
    try {
      const selection = bookmark.resolve(editor.state.doc);
      if (!selection.eq(editor.state.selection)) {
        editor.view.dispatch(editor.state.tr.setSelection(selection));
      }
      return selection;
    } catch {
      return null;
    }
  }

  /**
   * Paste and match style (ED11) where the menu was opened (B2): into the
   * title or a callout's title as typed text, over the body's selection as
   * ⌘⇧V pastes, and never into the source view.
   */
  private insertPlain(noteId: string, text: string): void {
    const captured = this.take(noteId);
    const open = this.current?.noteId === noteId ? this.current : null;
    if (open?.sourceOff || captured?.kind === 'source') {
      this.notice(noteId, SOURCE_PASTE);
      return;
    }
    if (captured?.kind === 'field') {
      const { field, start, end } = captured;
      if (!field.isConnected || field.readOnly || field.disabled) {
        this.notice(noteId, 'This note cannot be changed here');
        return;
      }
      field.focus();
      field.setRangeText(text, start, end, 'end');
      // As typing does: the title's binding stores it on input, a callout's title on change.
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const editor = this.editableEditor(noteId);
    if (!editor) {
      this.notice(noteId, 'This note cannot be changed here');
      return;
    }
    if (captured) this.restore(editor, captured.bookmark);
    pastePlainText(editor.view, text);
    editor.commands.focus(undefined, { scrollIntoView: true });
    this.scheduleState();
  }

  /** A clipboard write from the editor (a copy, a code block's Copy): the app writes it. */
  private toClipboard(open: OpenNote, payload: NativeClipboardPayload): boolean {
    if (this.current !== open) return false;
    const format =
      payload.html !== undefined ? 'rich' : payload.markdown !== undefined ? 'markdown' : 'text';
    this.post({
      v: BRIDGE_VERSION,
      type: 'clipboard',
      noteId: open.noteId,
      format,
      text: payload.text,
      ...(payload.html !== undefined ? { html: payload.html } : {}),
    });
    return true;
  }

  /**
   * The note's stored markdown, read-only, in place of the editor (T40 P8,
   * ED17), as the web's source view shows it: the frontmatter, then the body
   * by the core codec, following edits from elsewhere. `on: false` shows the
   * note again.
   */
  private showSource(noteId: string, on: boolean): void {
    const open = this.current;
    if (!open || open.noteId !== noteId) return;
    if (!on) {
      open.sourceOff?.();
      this.post({ v: BRIDGE_VERSION, type: 'source', noteId, on: false });
      return;
    }
    const editor = open.collab?.editor;
    if (open.sourceOff || !editor) {
      if (!editor) this.notice(noteId, 'This note has no Markdown source to show here');
      // What shows, so the app's menu and bar follow it (S6).
      this.post({ v: BRIDGE_VERSION, type: 'source', noteId, on: open.sourceOff !== null });
      return;
    }
    const { root, body } = this.elements;
    const page = root.ownerDocument;
    const frame = page.createElement('div');
    frame.className = 'doc note-source';
    const pre = page.createElement('pre');
    pre.setAttribute('aria-label', 'Markdown source');
    pre.tabIndex = 0;
    frame.append(pre);
    body.after(frame);
    body.hidden = true;
    editor.commands.blur();
    // The codec loads on first use, as for daily notes (it is not in the first paint).
    let codec: typeof import('@penmoss/core') | null = null;
    const render = () => {
      timer = null;
      if (!codec) return;
      try {
        const frontmatter = codec.createFrontmatter(noteFields(noteId, open.replica));
        const doc = codec.schema.nodeFromJSON(editor.getJSON());
        pre.textContent = codec.serializeMarkdown(
          { frontmatter, doc },
          { links: this.linkResolver() },
        );
      } catch (error) {
        pre.textContent = `Could not render markdown: ${String(error)}`;
      }
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      timer ??= setTimeout(render, SOURCE_DELAY_MS);
    };
    const off = open.replica.onUpdate(schedule);
    const stop = () => {
      open.sourceOff = null;
      if (timer !== null) clearTimeout(timer);
      off();
      frame.remove();
      body.hidden = false;
    };
    open.sourceOff = stop;
    pre.textContent = 'Loading…';
    import('@penmoss/core').then(
      (loaded) => {
        codec = loaded;
        if (open.sourceOff === stop) render();
      },
      (error: unknown) => {
        if (open.sourceOff === stop)
          pre.textContent = `Could not render markdown: ${String(error)}`;
      },
    );
    this.post({ v: BRIDGE_VERSION, type: 'source', noteId, on: true });
  }

  /** How the codec writes wikilinks in the source view: each target's current title (T16). */
  private linkResolver(): LinkResolver {
    const title = (noteId: string) => this.notesById.get(noteId)?.title.trim() || null;
    return {
      resolve: (target) => {
        const wanted = target.trim().toLowerCase();
        return wanted
          ? (this.notes.find((entry) => entry.title.trim().toLowerCase() === wanted)?.id ?? null)
          : null;
      },
      linkText: title,
      title,
    };
  }

  /**
   * The + sheet's entries (the slash menu's, for the caret's place and this
   * note's services) or Turn into's, filtered and ranked as the slash menu
   * filters (T40 P8, ED4, ED5). Empty when the note cannot be changed here.
   */
  private blocks(noteId: string, purpose: BlockPurpose, query: string): void {
    const open = this.current;
    const editor = open && !open.sourceOff ? this.editableEditor(noteId) : null;
    let items: BlockEntry[] = [];
    if (open && editor) {
      if (purpose === 'insert') {
        items = filterBlockItems(
          availableBlockItems(editor, open.images, open.links, open.files),
          query,
        ).map(blockEntry);
      } else if (canTurnInto(editor)) {
        items = filterBlockItems(TURN_INTO_ITEMS, query).map((item) => ({
          ...blockEntry(item),
          active: item.isActive?.(editor) ?? false,
        }));
      }
    }
    this.post({ v: BRIDGE_VERSION, type: 'blocks', noteId, purpose, query, items });
  }

  /** Inserts a catalogue block at the caret, as its slash-menu item and `Insert:` command do. */
  private insertBlock(noteId: string, id: string): void {
    const open = this.current;
    const editor = open && !open.sourceOff ? this.editableEditor(noteId) : null;
    if (!open || !editor) return;
    const item = availableBlockItems(editor, open.images, open.links, open.files).find(
      (each) => each.id === id,
    );
    if (!item) {
      this.notice(noteId, 'That block cannot go here');
      return;
    }
    const { from } = editor.state.selection;
    item.insert({
      editor,
      range: { from, to: from },
      images: open.images,
      links: open.links,
      files: open.files,
    });
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /** Turns the selected blocks into a kind, as the web's selection toolbar does (ED5). */
  private turnInto(noteId: string, id: string): void {
    const open = this.current;
    const editor = open && !open.sourceOff ? this.editableEditor(noteId) : null;
    const item = TURN_INTO_ITEMS.find((each) => each.id === id);
    if (!editor || !item) return;
    if (!turnInto(editor, item)) this.notice(noteId, 'That block cannot be turned into this');
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /** One of the Block menu's actions, by the shared editor command of its name (ED5). */
  private blockAction(noteId: string, action: BlockAction): void {
    const open = this.current;
    const editor = open && !open.sourceOff ? this.editableEditor(noteId) : null;
    if (!editor) return;
    if (!editor.view.hasFocus()) editor.view.focus();
    // Refused while another device's update waits for what it builds on: say so (S4).
    if (hasPendingUpdates(editor.state)) {
      this.notice(noteId, WAIT_FOR_SYNC);
      return;
    }
    const at = selectedTopLevelBlock(editor.state);
    const node = at === null ? null : editor.state.doc.nodeAt(at);
    const before = editor.state.doc;
    EDITOR_COMMANDS.find((each) => each.id === BLOCK_COMMANDS[action])?.run({ editor });
    if (action === 'delete' && node && editor.state.doc !== before) {
      // A tap removes a whole list or table: the app offers Undo, naming what went (S4).
      const kind = node.type.name;
      const label =
        kind === 'callout' && node.attrs['foldable'] ? 'Toggle' : (BLOCK_NAMES[kind] ?? 'Block');
      const step = latestUndoStep(editor.state);
      this.deletion = step ? { noteId, step } : null;
      this.post({ v: BRIDGE_VERSION, type: 'blockDeleted', noteId, label });
    }
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /**
   * The snackbar's Undo after Delete block: undoes that delete while it is
   * still this editor's newest undo step; after typing (or another undo), it
   * says so instead of undoing something else.
   */
  private undoDelete(noteId: string): void {
    const deletion = this.deletion?.noteId === noteId ? this.deletion : null;
    this.deletion = null;
    const open = this.current;
    const editor = open && !open.sourceOff ? this.editableEditor(noteId) : null;
    if (!editor || !deletion) return;
    if (latestUndoStep(editor.state) !== deletion.step) {
      this.notice(noteId, EDITED_SINCE);
      return;
    }
    EDITOR_COMMANDS.find((each) => each.id === 'editor.undo')?.run({ editor });
    editor.commands.scrollIntoView();
    this.scheduleState();
  }

  /**
   * Where the note's toggles remember being open (T40 P8, ED8): what the app
   * sent before the note opened, and each change sent back for the app to
   * keep in Room. The same rules as the web's `localFoldState`: the newest
   * MAX_FOLDS toggles per note are kept.
   */
  private foldState(noteId: string): FoldState {
    let folds: Record<string, boolean> =
      this.folds?.noteId === noteId ? { ...this.folds.folds } : {};
    const unkept: Record<string, boolean> = {};
    return {
      isOpen: (key) => (key.length > MAX_FOLD_KEY ? unkept[key] : folds[key]),
      setOpen: (key, open) => {
        // A key longer than the app keeps (a toggle with a very long title) is kept while the
        // note is open only: sending it would have the app refuse every toggle of the note.
        if (key.length > MAX_FOLD_KEY) {
          unkept[key] = open;
          return;
        }
        const merged = { ...folds };
        delete merged[key];
        const entries = Object.entries(merged).slice(-(MAX_FOLDS - 1));
        folds = { ...Object.fromEntries(entries), [key]: open };
        this.folds = { noteId, folds: { ...folds } };
        this.post({ v: BRIDGE_VERSION, type: 'folds', noteId, folds: { ...folds } });
      },
    };
  }

  /**
   * The note's counts (T40 P8, NT24), as the web's status bar takes them
   * (T41, A505): after typing pauses, the selection's shortly after it
   * changes, and sent only when they changed.
   */
  private countWords(open: OpenNote, editor: Editor): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const count = () => {
      timer = null;
      if (this.current !== open || editor.isDestroyed) return;
      const doc = textStats(docText(editor.state.doc));
      const { from, to } = editor.state.selection;
      const picked = from === to ? null : textStats(docText(editor.state.doc, from, to));
      const selection: TextCounts | null =
        picked && picked.characters > 0
          ? { words: picked.words, characters: picked.characters }
          : null;
      const message: FromEditor = {
        v: BRIDGE_VERSION,
        type: 'counts',
        noteId: open.noteId,
        words: doc.words,
        characters: doc.characters,
        minutes: doc.minutes,
        selection,
      };
      const text = JSON.stringify(message);
      if (text === this.lastCounts) return;
      this.lastCounts = text;
      this.post(message);
    };
    const later = (ms: number) => () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(count, ms);
    };
    const onUpdate = later(COUNT_DELAY_MS);
    const onSelection = later(SELECTION_COUNT_MS);
    timer = setTimeout(count, 0);
    editor.on('update', onUpdate);
    editor.on('selectionUpdate', onSelection);
    return () => {
      editor.off('update', onUpdate);
      editor.off('selectionUpdate', onSelection);
      if (timer !== null) clearTimeout(timer);
    };
  }

  /** Pictures the app stored from the photo picker, at the selection (A304). */
  private insertImages(noteId: string, paths: readonly string[]): void {
    const editor = this.editableEditor(noteId);
    if (!editor) return;
    const type = editor.schema.nodes['image'];
    if (!type) return;
    const { view } = editor;
    for (const path of paths) {
      const image = type.create({ src: path, alt: '' });
      view.dispatch(view.state.tr.replaceSelectionWith(image).scrollIntoView());
    }
    view.focus();
  }

  /**
   * Files the app stored from the document picker (ED12), at the selection:
   * a picture as a picture, anything else as a chip with its name, as the
   * web's `insertFiles` does.
   */
  private insertFileEntries(noteId: string, files: readonly FileEntry[]): void {
    const editor = this.editableEditor(noteId);
    if (!editor || this.current?.sourceOff) return;
    const { image, attachment } = editor.schema.nodes;
    if (!image || !attachment) return;
    const pictures = new Set<string>(Object.values(IMAGE_TYPES));
    const { view } = editor;
    for (const file of files) {
      const ext = parseAttachmentPath(file.path)?.ext ?? '';
      const node = pictures.has(ext)
        ? image.create({ src: file.path, alt: '' })
        : attachment.create({ href: file.path, name: file.name || 'File' });
      view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
    }
    view.focus();
  }

  /**
   * Edits kept apart from a note become a copy of it (A5, A306): what they
   * were made on with the edits applied, as a new note with fresh Yjs items,
   * exactly as the web app saves one. It fails closed (A309): edits that build
   * on something they were not sent are never copied without it, since the
   * copy would silently lack them; the app keeps them instead. Edits that
   * change nothing a copy would show make no copy. And when a copy of earlier
   * edits of the same copy exists and still shows exactly those, the new ones
   * are merged into it rather than making another.
   */
  private copyConflicts(
    noteId: string,
    base: readonly StoredUpdate[],
    edits: readonly StoredUpdate[],
    into: CopyInto | undefined,
    notebook?: string,
  ): void {
    const replaces = edits.map((stored) => stored.id);
    const failed = (reason: CopyFailure) =>
      this.post({ v: BRIDGE_VERSION, type: 'copyFailed', noteId, reason, replaces });
    let full: Y.Doc | null = null;
    let before: Y.Doc | null = null;
    try {
      full = completeDoc([...base, ...edits]);
      if (!full) return failed('incomplete');
      before = completeDoc(base);
      const unchanged =
        before !== null && bodyOf(before) === bodyOf(full) && readTitle(before) === readTitle(full);
      if (holdsNothing(full) || unchanged) return failed('empty');
      const merged = into && before ? this.mergeIntoCopy(into, before, full) : null;
      if (merged) {
        this.post({
          v: BRIDGE_VERSION,
          type: 'conflictCopy',
          noteId,
          note: merged,
          replaces,
          merged: true,
        });
        return;
      }
      // In the original's notebook (T43, A766): the note's own record, else where the app sees it.
      const made = conflictCopy(Y.encodeStateAsUpdate(full), { now: this.now() });
      const record = notebook && !readNoteNotebook(full) ? notebookRecord(made, notebook) : made;
      this.post({
        v: BRIDGE_VERSION,
        type: 'conflictCopy',
        noteId,
        note: { id: record.noteId, title: record.title ?? '', update: toBase64(record.update) },
        replaces,
      });
    } catch {
      failed('unreadable');
    } finally {
      full?.destroy();
      before?.destroy();
    }
  }

  /**
   * The edit that brings an existing conflict copy up to `full`, when the copy
   * still shows exactly what it was made from (`before`); null otherwise. The
   * body is replaced in one transaction on the copy's own items, so it merges
   * with anything the server has of the copy.
   */
  private mergeIntoCopy(into: CopyInto, before: Y.Doc, full: Y.Doc): NewNote | null {
    const copy = completeDoc(into.updates);
    if (!copy) return null;
    try {
      if (bodyOf(copy) !== bodyOf(before)) return null;
      const known = Y.encodeStateVector(copy);
      copy.transact(() => {
        const body = copy.get(NOTE_ROOT);
        body.delete(0, body.length);
        body.applyDelta(full.get(NOTE_ROOT).toDeltaDeep());
      });
      return {
        id: into.noteId,
        title: readTitle(copy),
        update: toBase64(Y.encodeStateAsUpdate(copy, known)),
      };
    } finally {
      copy.destroy();
    }
  }

  /**
   * The theme editor's preview (T40 P1b, A418): the sample note in the real editor, so the
   * preview is the note's own stylesheet. Its document is made here and never leaves: no
   * update, title or state is sent to the app, and nothing can be typed.
   */
  private preview(): void {
    this.close();
    const replica = createYjs14Replica();
    initNote(replica.doc, {
      id: PREVIEW_NOTE_ID,
      created: isoWithOffset(this.now()),
      kind: 'note',
    });
    const { title, body, root } = this.elements;
    title.value = PREVIEW_TITLE;
    title.readOnly = true;
    this.fitTitle();
    const open: OpenNote = {
      noteId: PREVIEW_NOTE_ID,
      replica,
      collab: null,
      flush: () => undefined,
      sendText: () => undefined,
      held: [],
      holdTimer: null,
      sourceOff: null,
      teardown: () => {
        open.collab?.destroy();
        body.replaceChildren();
        replica.destroy();
      },
    };
    this.current = open;
    open.collab = createCollabEditor({
      element: body,
      extensions: noteExtensions({
        links: this.links(PREVIEW_NOTE_ID),
        images: this.images(PREVIEW_NOTE_ID),
        symbols: this.symbolSource,
      }),
      replica,
    });
    const { editor } = open.collab;
    editor.commands.setContent(PREVIEW_HTML);
    editor.setEditable(false);
    editor.view.dom.setAttribute('aria-label', 'Theme preview');
    root.dataset['preview'] = 'true';
    root.hidden = false;
  }

  /** Shows the theme the app resolved (A305); a built-in comes from this build's own copy. */
  private applyTheme(raw: Readonly<Record<string, unknown>>, variant: 'light' | 'dark'): void {
    const theme: Theme | null = builtInTheme(raw['id']) ?? parseTheme(raw)?.theme ?? null;
    if (!theme) {
      this.fail(null, 'The app sent a theme this editor cannot read');
      return;
    }
    this.theme = { theme, variant };
    this.applyAppearance();
  }

  /**
   * The theme, then the person's fonts over it (T51, A944): the theme's own fonts come back
   * when a font goes back to Theme Default, so each change lays both again.
   */
  private applyAppearance(): void {
    const root = this.elements.root.ownerDocument.documentElement;
    if (this.theme) applyThemeTo(root, this.theme.theme, this.theme.variant);
    if (!this.fonts) return;
    for (const [name, value] of Object.entries(fontVariables(this.fonts)))
      root.style.setProperty(name, value);
  }

  /** The phone's notes for wikilinks (A303): titles change in every open link at once. */
  private setDirectory(notes: readonly DirectoryEntry[]): void {
    this.notes = notes;
    this.notesById = new Map(notes.map((entry) => [entry.id, entry]));
    for (const listener of [...this.linkListeners]) listener();
  }

  /**
   * Wikilinks (T16) from the phone's note list (A303). A note made from a
   * link is created here, like the web app does, and handed to the app to
   * store, upload and file beside this one.
   */
  private links(noteId: string): LinkServices {
    return {
      noteId,
      title: (id) => {
        const entry = this.notesById.get(id);
        return entry ? displayTitle(entry.title) : null;
      },
      search: (query, limit): readonly NoteCandidate[] =>
        this.matcher
          .filter(
            this.notes.filter((entry) => entry.id !== noteId),
            query,
            (entry) => displayTitle(entry.title),
            limit,
          )
          .map((entry) => ({
            id: entry.id,
            title: displayTitle(entry.title),
            ...(entry.folder ? { detail: entry.folder } : {}),
          })),
      resolve: (title) => {
        const wanted = title.trim().toLowerCase();
        if (!wanted) return null;
        return this.notes.find((entry) => entry.title.trim().toLowerCase() === wanted)?.id ?? null;
      },
      create: (title) => this.createNote(noteId, title),
      // At a heading when the link names one (T40 P7, LK3): the app opens the note there.
      open: (target, heading) =>
        this.post({
          v: BRIDGE_VERSION,
          type: 'openNote',
          noteId: target,
          ...(heading?.trim() ? { heading: heading.trim().slice(0, MAX_HEADING_CHARS) } : {}),
        }),
      // `[[Title#` headings and embeds from the other note's stored updates (T40 P7, A470).
      headings: (target) => this.linked.headings(target),
      body: (target) => this.linked.body(target),
      watch: (target, listener) => this.linked.watch(target, listener),
      subscribe: (listener) => {
        this.linkListeners.add(listener);
        return () => this.linkListeners.delete(listener);
      },
    };
  }

  private createNote(from: string, raw: string): string | null {
    const title = raw.replace(/[\r\n]+/g, ' ').trim();
    if (!title) return null;
    const now = this.now();
    const id = ulid(now.getTime());
    const replica = createYjs14Replica();
    let note: NewNote;
    try {
      // In the notebook of the note it was made from, beside which it is filed (T43, A766).
      const notebook = from === this.current?.noteId ? this.openNotebook : null;
      initNote(
        replica.doc,
        { id, created: isoWithOffset(now), kind: 'note', ...(notebook ? { notebook } : {}) },
        title,
      );
      note = { id, title, update: toBase64(replica.encodeStateAsUpdate()) };
    } finally {
      replica.destroy();
    }
    // Known at once, so the new link shows its title before the app's list catches up.
    this.setDirectory([{ id, title }, ...this.notes]);
    this.post({ v: BRIDGE_VERSION, type: 'newNote', noteId: from, note });
    return id;
  }

  /**
   * Pictures in the note (T10) through the app (A304). A pasted or dropped
   * picture is checked and hashed here and handed to the app, which stores it
   * and uploads it when it can; the note shows pictures from the app's origin,
   * where the app serves them from the phone or fetches them with its token.
   * Pictures from web addresses come through the app too (ED13; A293).
   */
  private images(noteId: string): ImageServices {
    return {
      add: async (bytes) => {
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          throw new Error('Pictures over 50 MB cannot be added');
        }
        const type = sniffImageType(bytes);
        if (!type) throw new Error('Only PNG, JPEG, GIF, WebP and AVIF pictures can be added');
        const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
        const path = attachmentPath(sha256, type);
        // Inserted only once the phone has it (A311): a picture the phone could not store is
        // never named by the note, and the WebView finds the file when it asks for it.
        const stored = this.waitForStore(path);
        // The message, then its bytes as the very next one (the app pairs them, A304).
        this.post({ v: BRIDGE_VERSION, type: 'attachment', noteId, path, size: bytes.byteLength });
        this.postBytes(bytes);
        if (!(await stored)) throw new Error('The picture could not be stored on this phone');
        return { path };
      },
      resolve: (src) => {
        const parsed = parseAttachmentPath(src);
        return Promise.resolve(
          parsed ? `${ATTACHMENT_URL_PREFIX}${parsed.sha256}.${parsed.ext}` : null,
        );
      },
      onError: (message) => this.notice(noteId, message),
      web: (src, now) => this.webPicture(noteId, src, now),
    };
  }

  /**
   * Files in the note (T13) through the app (T40 P8, ED12): a dropped or
   * pasted file is hashed and sniffed here and handed to the app, which checks
   * it against its path, stores it and uploads it with the pictures; it goes
   * into the note only once stored (A311). A chip's size and type come from the
   * app, and Open and Save a copy are the app's: the page never holds a file's
   * URL, and a PDF never renders in it (A293).
   */
  private files(noteId: string): FileServices {
    const images = this.images(noteId);
    const path = (src: string) => {
      const parsed = parseAttachmentPath(src);
      return parsed ? `attachments/${parsed.sha256}.${parsed.ext}` : null;
    };
    return {
      ...images,
      addFile: async (file) => {
        const name = file.name.slice(0, MAX_FILE_NAME);
        if (file.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`“${name}” is over 50 MB, the largest file Penmoss stores`);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const type = sniffFileType(bytes.subarray(0, SNIFF_BYTES));
        const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
        const stored = filePath(sha256, type, name);
        const done = this.waitForStore(stored);
        // The message, then its bytes as the very next one, as for a picture (A304).
        this.post({
          v: BRIDGE_VERSION,
          type: 'file',
          noteId,
          path: stored,
          name,
          size: bytes.byteLength,
        });
        this.postBytes(bytes);
        if (!(await done)) throw new Error(`“${name}” could not be stored on this phone`);
        return { path: stored };
      },
      info: (src) => {
        const asked = path(src);
        if (!asked) return Promise.resolve(null);
        return new Promise<FileInfo | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), FILE_INFO_MS);
          const waiting = this.asking.get(asked) ?? [];
          waiting.push((info) => {
            clearTimeout(timer);
            resolve(info);
          });
          this.asking.set(asked, waiting);
          if (waiting.length === 1) {
            this.post({ v: BRIDGE_VERSION, type: 'fileInfo', noteId, path: asked });
          }
        });
      },
      openFile: (src: string, name: string, action: FileAction) => {
        const asked = path(src);
        if (!asked) {
          this.notice(noteId, 'This file is not one Penmoss stores');
          return;
        }
        this.post({
          v: BRIDGE_VERSION,
          type: 'openFile',
          noteId,
          path: asked,
          name: name.slice(0, MAX_FILE_NAME),
          action,
        });
      },
    };
  }

  /** Resolves once the app answers for `path` (true: stored), or false after a while (A311). */
  private waitForStore(path: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), STORE_PICTURE_MS);
      const waiting = this.storing.get(path) ?? [];
      waiting.push((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      this.storing.set(path, waiting);
    });
  }

  /**
   * A picture from a web address (T40 P8, ED13), fetched by the app on the
   * page's own origin: `https` only, and as the app's setting says: shown,
   * held for a tap, or not at all.
   */
  private webPicture(
    noteId: string,
    src: string,
    now: boolean,
  ): { readonly url: string } | 'wait' | null {
    if (!/^https:\/\//i.test(src) || src.length > MAX_REMOTE_URL) return null;
    const mode = this.webPictures?.noteId === noteId ? this.webPictures.mode : 'off';
    if (mode === 'off') return null;
    if (mode === 'wait' && !now) return 'wait';
    return { url: `${REMOTE_PICTURE_PATH}?${now ? 'now=1&' : ''}u=${encodeURIComponent(src)}` };
  }

  private showUnsupported(open: OpenNote, nodeTypes: readonly string[]): void {
    const { title, unsupported } = this.elements;
    title.readOnly = true;
    unsupported.textContent = open.replica.plainText();
    unsupported.hidden = false;
    this.post({ v: BRIDGE_VERSION, type: 'unsupported', noteId: open.noteId, nodeTypes });
  }

  private notice(noteId: string | null, message: string): void {
    if (noteId !== null) this.post({ v: BRIDGE_VERSION, type: 'notice', noteId, message });
  }

  /** Reports an error; `request` names the tagged request it answers (T40 P9, N7). */
  private fail(noteId: string | null, message: string, request?: string): void {
    this.post(
      request === undefined
        ? { v: BRIDGE_VERSION, type: 'error', noteId, message }
        : { v: BRIDGE_VERSION, type: 'error', noteId, message, request },
    );
  }
}
