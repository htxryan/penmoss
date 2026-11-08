/**
 * The bridge between the Android app and the editor WebView (T32, A282; T33, A300).
 *
 * Every message is one JSON string on the `penmossNative` WebMessageListener,
 * which the app registers for the asset loader's origin only: the page posts
 * with `penmossNative.postMessage`, and the app answers through the listener's
 * reply proxy (`penmossNative.onmessage`). Yjs updates travel as base64 and
 * Kotlin never reads them (A11): it stores them, uploads them through
 * `/sync/batch` and hands them back. The WebView owns the open document.
 *
 * The app and the page ship in one APK, so version 1 grows by adding messages
 * (A300); a change to a message's meaning would be version 2.
 *
 * `apps/android/contract/bridge-v1.json` holds an example of every message;
 * this file's tests and the Kotlin `BridgeProtocol` tests both check it.
 */

import { MAX_SYMBOLS, readSymbolList, type LineSymbol } from '@penmoss/core/line-symbols';
import {
  fontSettingProblem,
  INTERFACE_FONT_SETTING,
  NOTE_FONT_SETTING,
  NOTE_FONT_SIZE_SETTING,
  type FontChoice,
} from '@penmoss/core/fonts';
import { COMMAND_ID_PATTERN } from '@penmoss/editor/keys';
import {
  COMMENT_TO_EDITOR_TYPES,
  parseCommentAuthor,
  parseCommentMessage,
  type CommentAuthorMessage,
  type CommentFromEditor,
  type CommentToEditor,
} from './comments-protocol';

export const BRIDGE_VERSION = 1;

/** Daily and weekly notes (T40 P5): the period kinds, as `@penmoss/core` names them. */
export const PERIOD_KINDS = ['daily', 'weekly'] as const;

export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** A calendar date (`2026-10-21`), as the page's day cells and labels use it. */
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** One stored update for a note, by the app's own id for it (a Room row). */
export interface StoredUpdate {
  readonly id: string;
  readonly update: string;
}

/**
 * What the native formatting bar can ask for (T33, A301): the editor
 * commands of `@penmoss/editor/commands` and indenting list items. `link`
 * carries the address (empty: remove the link).
 */
export const FORMAT_COMMANDS = [
  'bold',
  'italic',
  'strike',
  'code',
  'highlight',
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
  'indent',
  'outdent',
  'undo',
  'redo',
  'link',
  // T40 P8 (ED4, ED6): the rest of the text styles, and the table buttons.
  'heading4',
  'heading5',
  'heading6',
  'nextCell',
  'previousCell',
  'addRow',
  'addColumn',
] as const;

export type FormatCommand = (typeof FORMAT_COMMANDS)[number];

/** A note the page made for the app to store and upload (a wikilink's new note, a conflict copy). */
export interface NewNote {
  readonly id: string;
  readonly title: string;
  /** The whole note as one Yjs update. */
  readonly update: string;
}

/** One entry of the note registry, for wikilink titles and `[[` completion (T33, A303). */
export interface DirectoryEntry {
  readonly id: string;
  readonly title: string;
  /** The name of the folder it is filed in, shown beside it in completion. */
  readonly folder?: string;
}

/** Copy as Markdown or as rich text (T15; T40 P8, ED9). */
export const COPY_FORMATS = ['markdown', 'rich'] as const;
export type CopyFormat = (typeof COPY_FORMATS)[number];

/** What a copy takes: the whole note (the ⋮ menu) or the selection (the selection's menu). */
export const COPY_SCOPES = ['note', 'selection'] as const;
export type CopyScope = (typeof COPY_SCOPES)[number];

/** The Block menu's actions (T40 P8, ED5): the shared editor commands of the same names. */
export const BLOCK_ACTIONS = ['moveUp', 'moveDown', 'duplicate', 'delete'] as const;
export type BlockAction = (typeof BLOCK_ACTIONS)[number];

/** What the app asks the block catalogue for: the + sheet's inserts, or Turn into's kinds. */
export const BLOCK_PURPOSES = ['insert', 'turnInto'] as const;
export type BlockPurpose = (typeof BLOCK_PURPOSES)[number];

/** A block catalogue id (the slash menu's, `@penmoss/editor`'s BLOCK_ITEMS). */
export const BLOCK_ID = /^[A-Za-z0-9-]{1,40}$/;

/** The longest search the + sheet sends. */
export const MAX_BLOCK_QUERY = 100;

/** The most text a paste as plain text carries (a clipboard can hold more; the rest is not pasted). */
export const MAX_PLAIN_CHARS = 1_000_000;

/** Toggles remembered per note (T40 P8, ED8), as the web keeps them (`MAX_FOLDS_PER_NOTE`). */
export const MAX_FOLDS = 200;

/** The longest toggle key kept (`type|title|index`, `calloutKey`). */
export const MAX_FOLD_KEY = 2000;

/**
 * A file the note names (T40 P8, ED12): `attachments/<sha256>.<ext>`, any
 * extension core's `filePath` writes, pictures and PDFs included.
 */
export const FILE_PATH = /^attachments\/[0-9a-f]{64}\.[a-z0-9]{1,10}$/;

/** The longest file name carried (a chip's name; most file systems stop at 255). */
export const MAX_FILE_NAME = 255;

/** Files the document picker inserts at once (as the photo picker's 10, with room). */
export const MAX_INSERT_FILES = 20;

/** What a chip's buttons ask of the app: open the file, or save a copy (ED12). */
export const FILE_ACTIONS = ['open', 'save'] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

/**
 * How pictures from web addresses show (T40 P8, ED13): through the app, held
 * for a tap (Wi-Fi only, on mobile data), or not at all.
 */
export const WEB_PICTURE_MODES = ['on', 'wait', 'off'] as const;
export type WebPictureMode = (typeof WEB_PICTURE_MODES)[number];

/** A stored file's type, as the app reports it: `application/pdf`, `image/png`. */
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,80}$/;

/** A file the app stored, to insert: its path and the name its chip shows. */
export interface FileEntry {
  readonly path: string;
  readonly name: string;
}

/** One entry of the + sheet or Turn into (T40 P8, ED4): as the slash menu shows it. */
export interface BlockEntry {
  readonly id: string;
  readonly label: string;
  /** The slash menu's glyph (`H1`, `•`, `{}`). */
  readonly icon: string;
  /** The markdown shortcut for the same block, when there is one. */
  readonly hint?: string;
  /** For Turn into: the selection's block is already this kind. */
  readonly active?: boolean;
}

/** Counts of some text (T41, A505): as the web's status bar counts them. */
export interface TextCounts {
  readonly words: number;
  readonly characters: number;
}

/** Messages from the app to the editor. */
export type ToEditor =
  | {
      readonly v: 1;
      readonly type: 'open';
      readonly noteId: string;
      /** Updates the server already has, oldest first. */
      readonly synced: readonly StoredUpdate[];
      /** Edits this device made that the server has not confirmed yet, oldest first. */
      readonly pending: readonly StoredUpdate[];
      readonly editable: boolean;
      /**
       * The notebook the app sees the note in (T43, A766): a notebook's folder id, or
       * `default`. A link's new note made from it records it, as it is filed beside it.
       */
      readonly notebook?: string;
    }
  | { readonly v: 1; readonly type: 'remote'; readonly noteId: string; readonly update: string }
  /** Send the edits waiting for the batch timer now (the app is going to the background). */
  | { readonly v: 1; readonly type: 'flush'; readonly noteId: string }
  /** Close the note; the page sends its last edits, then `closed`. */
  | { readonly v: 1; readonly type: 'close'; readonly noteId: string }
  /** Merge these stored edits into one (A289); the page answers `compacted`. */
  | {
      readonly v: 1;
      readonly type: 'compact';
      readonly noteId: string;
      readonly updates: readonly StoredUpdate[];
    }
  /** A button of the formatting bar (A301); `href` with `link` only. */
  | {
      readonly v: 1;
      readonly type: 'format';
      readonly noteId: string;
      readonly command: FormatCommand;
      readonly href?: string;
    }
  /** Back was pressed while a menu of the editor's was open: close it (A302). */
  | { readonly v: 1; readonly type: 'dismiss'; readonly noteId: string }
  /** Give the note the focus again, where its selection was (after a native dialog). */
  | { readonly v: 1; readonly type: 'focus'; readonly noteId: string }
  /** Put the caret in the note's title, to rename it from a list (T40 P4, NT10). */
  | { readonly v: 1; readonly type: 'focusTitle'; readonly noteId: string }
  /** Pictures the app stored from the photo picker (A304): insert them at the selection. */
  | {
      readonly v: 1;
      readonly type: 'insertImages';
      readonly noteId: string;
      readonly paths: readonly string[];
    }
  /**
   * Edits kept apart from a note (A5, A291) and everything they may build on:
   * the page builds a conflict copy of them (A306), or merges them into
   * `into`, the copy already made of earlier edits of the same copy (A309),
   * and answers `conflictCopy`, or `copyFailed` when no copy can be made.
   */
  | {
      readonly v: 1;
      readonly type: 'copyConflicts';
      readonly noteId: string;
      readonly base: readonly StoredUpdate[];
      readonly edits: readonly StoredUpdate[];
      readonly into?: CopyInto;
      /** The original's notebook as the app sees it (T43, A766): the copy's when the note does not say. */
      readonly notebook?: string;
    }
  /** The answer to `attachment` and its bytes: the app stored them, or not (A311). */
  | {
      readonly v: 1;
      readonly type: 'attachmentStored';
      readonly noteId: string;
      readonly path: string;
      readonly ok: boolean;
    }
  /** The theme to show (A305): a resolved theme from `/sync/tree`, and the variant. */
  | {
      readonly v: 1;
      readonly type: 'theme';
      readonly theme: Readonly<Record<string, unknown>>;
      readonly variant: 'light' | 'dark';
    }
  /**
   * The note column's width (T40 P1, A413): the theme's (`full: false`), or the whole
   * screen, from the synced `note.fullWidth`, as the web shows it (A501).
   */
  | { readonly v: 1; readonly type: 'width'; readonly full: boolean }
  /**
   * The person's fonts (T51, A944): the synced `font.interface`, `font.note` and `font.noteSize`,
   * each by core `fonts.ts`'s rules, laid over the theme's own (`fontVariables`).
   */
  | {
      readonly v: 1;
      readonly type: 'fonts';
      readonly interface: FontChoice;
      readonly note: FontChoice;
      readonly noteSize: number;
    }
  /**
   * The person's line symbols (T44, A747): the synced `symbols.list`, or the defaults, as the
   * web reads it. Every open note redraws its margin; no note changes (A741).
   */
  | { readonly v: 1; readonly type: 'symbols'; readonly symbols: readonly LineSymbol[] }
  /**
   * Whether the keyboard is up (T40 P6 review S8): a tap on an inline `#tag` opens it while
   * the keyboard is down, even with the note still focused, as hiding it leaves it.
   */
  | { readonly v: 1; readonly type: 'ime'; readonly visible: boolean }
  /**
   * The theme editor's preview (T40 P1b, A418): a fixed sample note, read-only, with no Yjs
   * from the app and nothing sent back; `theme` re-themes it as each colour changes.
   */
  | { readonly v: 1; readonly type: 'preview' }
  /** Closes the image lightbox (T51, A948): the phone's back gesture while it is open. */
  | { readonly v: 1; readonly type: 'closeLightbox' }
  /** Every note the phone knows, for wikilinks (A303). Replaces the last one sent. */
  | { readonly v: 1; readonly type: 'directory'; readonly notes: readonly DirectoryEntry[] }
  /**
   * Make a new, empty note with this id, as the web's New note does (T38): the
   * page builds it and answers `created`, so a note made offline needs no server.
   */
  | {
      readonly v: 1;
      readonly type: 'create';
      readonly noteId: string;
      /** The notebook of the folder it is made in (T43, A766), recorded in the note itself. */
      readonly notebook?: string;
    }
  /**
   * Make the daily or weekly note for `day` (or today in `timeZone` when null)
   * from `template`, exactly as the web does (T40 P5): the page resolves the
   * period with core's functions (never the phone's zone), builds it with the
   * deterministic `periodicNote` and answers `createdPeriodic`, so a note
   * made offline needs no server. `at` is when the note is made (epoch ms);
   * the day is read in `timeZone`, the synced setting, not the phone's zone.
   */
  | {
      readonly v: 1;
      readonly type: 'createPeriodic';
      readonly kind: PeriodKind;
      readonly day: string | null;
      readonly at: number;
      readonly timeZone: string;
      readonly template: string;
      /**
       * The app's tag for this request (T40 P9, P5 review N7): an error from making it names
       * it, so a waiting screen fails on its own request's error only, never another's.
       */
      readonly request?: string;
    }
  /**
   * The user's key bindings and the app's own commands (T40 P9, PL9, A493): `bindings` is the
   * synced `keys.<id>` lists by command id, as stored (the page applies A90's rules itself);
   * `app` is the commands the app runs on the note's screen now. The page's dispatcher runs
   * editor commands and sends `command` for those.
   */
  | {
      readonly v: 1;
      readonly type: 'keys';
      readonly bindings: Readonly<Record<string, readonly string[]>>;
      readonly app: readonly string[];
    }
  /** What period the open note is, and what surrounds it (T40 P5, JR4). */
  | { readonly v: 1; readonly type: 'periodicNav'; readonly noteId: string }
  /** Add (`on`) or remove a frontmatter tag on the open note, as the web's tag chips do (T38). */
  | {
      readonly v: 1;
      readonly type: 'setTag';
      readonly noteId: string;
      readonly tag: string;
      readonly on: boolean;
    }
  /**
   * Copy as Markdown or as rich text (T40 P8, ED9): the whole note, or the
   * selection captured when the menu showed (never the whole note instead:
   * with nothing selected the page says so). The page answers `clipboard`
   * with what to put on the clipboard.
   */
  | {
      readonly v: 1;
      readonly type: 'copy';
      readonly noteId: string;
      readonly format: CopyFormat;
      readonly scope: CopyScope;
    }
  /** Paste and match style (T40 P8, ED11): text the app read from the clipboard, as ⌘⇧V pastes it. */
  | { readonly v: 1; readonly type: 'insertPlain'; readonly noteId: string; readonly text: string }
  /** Show the note's stored markdown, read-only (`on`), or the note again (T40 P8, ED17). */
  | { readonly v: 1; readonly type: 'source'; readonly noteId: string; readonly on: boolean }
  /**
   * The selection menu has opened (T40 P8 review B2): keep what is selected
   * now, and in which field (the title, a callout's title, the body or the
   * source), for the menu's Copy as and Paste as plain text. The WebView
   * clears the selection as the menu closes, before those messages arrive.
   */
  | { readonly v: 1; readonly type: 'captureSelection'; readonly noteId: string }
  /**
   * The Undo of the snackbar after Delete block (T40 P8 re-review): undoes
   * that delete only while it is still the newest edit, never typing since.
   */
  | { readonly v: 1; readonly type: 'undoDelete'; readonly noteId: string }
  /** The + sheet's or Turn into's entries for a search (T40 P8, ED4); answered by `blocks`. */
  | {
      readonly v: 1;
      readonly type: 'blocks';
      readonly noteId: string;
      readonly purpose: BlockPurpose;
      readonly query: string;
    }
  /** Insert a block of the catalogue at the caret, as its slash-menu item does (T40 P8, ED4). */
  | { readonly v: 1; readonly type: 'insert'; readonly noteId: string; readonly item: string }
  /** Turn the selected blocks into a kind of the catalogue (T40 P8, ED5). */
  | { readonly v: 1; readonly type: 'turnInto'; readonly noteId: string; readonly item: string }
  /** One of the Block menu's actions on the block holding the caret (T40 P8, ED5). */
  | {
      readonly v: 1;
      readonly type: 'block';
      readonly noteId: string;
      readonly action: BlockAction;
    }
  /**
   * The note's toggles as this phone last left them (T40 P8, ED8), by
   * `calloutKey`: sent before `open`, so toggles open as they were left.
   */
  | {
      readonly v: 1;
      readonly type: 'folds';
      readonly noteId: string;
      readonly folds: Readonly<Record<string, boolean>>;
    }
  /** The answer to `file` and its bytes: the app stored them, or not (T40 P8, ED12; A311). */
  | {
      readonly v: 1;
      readonly type: 'fileStored';
      readonly noteId: string;
      readonly path: string;
      readonly ok: boolean;
    }
  /**
   * Files the app stored from the document picker (ED12): inserted at the
   * selection, a picture as a picture and anything else as a chip.
   */
  | {
      readonly v: 1;
      readonly type: 'insertFiles';
      readonly noteId: string;
      readonly files: readonly FileEntry[];
    }
  /** The answer to `fileInfo`: the stored file's size and type, or null when unknown (ED12). */
  | {
      readonly v: 1;
      readonly type: 'fileInfo';
      readonly noteId: string;
      readonly path: string;
      readonly info: { readonly size: number; readonly type: string } | null;
    }
  /** How pictures from web addresses show in this note (ED13), sent before `open`. */
  | {
      readonly v: 1;
      readonly type: 'webPictures';
      readonly noteId: string;
      readonly mode: WebPictureMode;
    }
  /**
   * The answer to the page's `noteContent` (T40 P7, LK2, LK4, A470): another note's stored
   * updates, opaque to the app, for `[[Title#` headings and embeds. `missing` when the phone
   * does not hold it and could not fetch it; `tooLarge` past what the page reads in one go.
   * `updates` is empty unless `ok`.
   */
  | {
      readonly v: 1;
      readonly type: 'noteContent';
      readonly noteId: string;
      readonly state: ContentState;
      readonly updates: readonly StoredUpdate[];
    }
  /** A note the page watches (`watchNote`) changed on the phone: read it again (T40 P7, LK4, A471). */
  | { readonly v: 1; readonly type: 'noteChanged'; readonly noteId: string }
  /** Scroll the open note to a heading, as a link to `[[Note#Heading]]` does on the web (T40 P7, LK3). */
  | {
      readonly v: 1;
      readonly type: 'showHeading';
      readonly noteId: string;
      readonly heading: string;
    }
  /**
   * The bar's symbol sheet (T44, A747): toggle symbol `index` (its slot, 0–8) on every line in
   * the selection, as `editor.symbol1`–`9` do on the web (A740), as one undo step.
   */
  | { readonly v: 1; readonly type: 'symbol'; readonly noteId: string; readonly index: number }
  /** Comment threads (T48): `comments-protocol.ts`. */
  | CommentToEditor
  /** Who this phone's comments are by (T48 review S5): `comments-protocol.ts`. */
  | CommentAuthorMessage;

/** What the app has of another note the page asked for (T40 P7, A470). */
export const CONTENT_STATES = ['ok', 'missing', 'tooLarge'] as const;

export type ContentState = (typeof CONTENT_STATES)[number];

/** Longer than any heading a link names (the server keeps titles to 300 characters too). */
export const MAX_HEADING_CHARS = 300;

/** A note's outgoing links the page reports (`noteInfo`), at most this many (T40 P7, A473). */
export const MAX_REPORTED_LINKS = 1000;

/** One frontmatter field as the web's Info panel shows it (T40 P7, NT23): its key and value. */
export interface InfoField {
  readonly key: string;
  readonly value: string;
}

/** A conflict copy already made, with every update the phone holds of it (A309). */
export interface CopyInto {
  readonly noteId: string;
  readonly updates: readonly StoredUpdate[];
}

/** Why no copy was made of edits kept apart (A309). */
export type CopyFailure = 'incomplete' | 'unreadable' | 'empty';

/** One neighbour of a periodic note: an explicit day, what the row shows, and its full name. */
export interface NavTarget {
  /** A calendar day (`2026-10-21`): the `createPeriodic` day that opens it. */
  readonly date: string;
  /** What the row shows (`2026-10-20`, `Week 2026-W43`, `Wed 21`). */
  readonly label: string;
  /** The full name for screen readers (`Tuesday 20 October 2026`). */
  readonly full: string;
  /**
   * The period this target's note has (`2026-10-20`, `2026-W43`), opaque to the app, which
   * marks a target whose note it holds (T40 P9, P5 review N4), as the web marks it.
   */
  readonly period: string;
}

/** The open periodic note's period and neighbours, for the row under its top bar (T40 P5). */
export interface PeriodicNav {
  readonly kind: PeriodKind;
  /** The resolved period (`2026-10-21` or `2026-W43`), opaque to the app. */
  readonly period: string;
  /** The period's name (`Wednesday 21 October 2026`, `Week 2026-W43`), as the web names it. */
  readonly label: string;
  readonly prev: NavTarget;
  readonly next: NavTarget;
  /** The daily note's week (its Monday), or null on a weekly note. */
  readonly week: NavTarget | null;
  /** The weekly note's seven days, or null on a daily note. */
  readonly days: readonly NavTarget[] | null;
}

/** Stored updates merged into one, and the ids of those it replaces. */
export interface Compacted {
  readonly replaces: readonly string[];
  readonly update: string;
}

/** What the formatting bar shows (A301): sent whenever it changes. */
export interface EditorState {
  /** Formatting in effect at the selection: commands of FORMAT_COMMANDS. */
  readonly active: readonly FormatCommand[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canIndent: boolean;
  readonly canOutdent: boolean;
  /** The address of the link at the selection, or null. */
  readonly href: string | null;
  /** A menu of the editor's is open (slash, `[[`), which Back closes first (A302). */
  readonly menu: boolean;
  /** The caret is in a table: the bar shows its cell, row and column buttons (T40 P8, ED6). */
  readonly inTable: boolean;
  /** The caret is in a code block: Indent and Outdent indent its lines (T40 P8, ED7). */
  readonly inCode: boolean;
  /** The Block menu's Move up and Move down can move the block holding the caret (T40 P8, ED5). */
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  /** Turn into can act on the selection (not in a table). */
  readonly canTurnInto: boolean;
  /** The caret is in the note's title: the app hides the bar (T40 P9, T39 pass 3, A554). */
  readonly inTitle: boolean;
  /** The symbol slots every line in the selection has, which the symbol sheet ticks (T44, A747). */
  readonly symbols: readonly number[];
  /** A line in the selection may carry a symbol (not code, a table or a callout). */
  readonly canSymbol: boolean;
}

/** Messages from the editor to the app. */
export type FromEditor =
  | { readonly v: 1; readonly type: 'ready' }
  /**
   * The image lightbox opened or closed (T51, A948): while it is open the app's back gesture
   * closes it (`closeLightbox`) and the note's bars step aside for it.
   */
  | { readonly v: 1; readonly type: 'lightbox'; readonly open: boolean }
  | {
      readonly v: 1;
      readonly type: 'opened';
      readonly noteId: string;
      readonly title: string;
      /**
       * The synced updates merged into one, and the ids it replaces, when there
       * was more than one: the app swaps them in one transaction, so its store
       * stays small without Kotlin reading Yjs.
       */
      readonly compacted: Compacted | null;
      /** The same for this device's pending edits (kept apart: they still need uploading). */
      readonly compactedPending: Compacted | null;
    }
  | { readonly v: 1; readonly type: 'update'; readonly noteId: string; readonly update: string }
  | { readonly v: 1; readonly type: 'title'; readonly noteId: string; readonly title: string }
  | {
      readonly v: 1;
      readonly type: 'unsupported';
      readonly noteId: string;
      readonly nodeTypes: readonly string[];
    }
  /** A link was followed (A303); `heading` when it names one (`[[Note#Heading]]`, T40 P7, LK3). */
  | {
      readonly v: 1;
      readonly type: 'openNote';
      readonly noteId: string;
      readonly heading?: string;
    }
  /** After `close`: every edit has been sent, so the app may destroy the WebView. */
  | { readonly v: 1; readonly type: 'closed'; readonly noteId: string }
  /** The answer to `compact`. */
  | {
      readonly v: 1;
      readonly type: 'compacted';
      readonly noteId: string;
      readonly compacted: Compacted;
    }
  | ({ readonly v: 1; readonly type: 'state'; readonly noteId: string } & EditorState)
  /**
   * A picture pasted or dropped into the note (A304): the path the note now
   * holds (`attachments/<sha256>.<ext>`) and its size. Its bytes follow at once
   * as the next message, an ArrayBuffer (no base64 for Kotlin to decode, A11);
   * the app stores and uploads them, after checking them against the path.
   */
  | {
      readonly v: 1;
      readonly type: 'attachment';
      readonly noteId: string;
      readonly path: string;
      readonly size: number;
    }
  /** A note a wikilink created (A303), to be filed beside `noteId`. */
  | { readonly v: 1; readonly type: 'newNote'; readonly noteId: string; readonly note: NewNote }
  /**
   * The answer to `copyConflicts` (A306): the copy, and the edits it now holds.
   * With `merged`, `note` is an edit of the copy `into` named (A309).
   */
  | {
      readonly v: 1;
      readonly type: 'conflictCopy';
      readonly noteId: string;
      readonly note: NewNote;
      readonly replaces: readonly string[];
      readonly merged?: true;
    }
  /** The other answer to `copyConflicts`: no copy was made of these edits (A309). */
  | {
      readonly v: 1;
      readonly type: 'copyFailed';
      readonly noteId: string;
      readonly reason: CopyFailure;
      readonly replaces: readonly string[];
    }
  /** Something to tell the person, such as a picture that could not be added. */
  | { readonly v: 1; readonly type: 'notice'; readonly noteId: string; readonly message: string }
  /** The answer to `create`: the whole new note, for the app to store and upload (T38). */
  | { readonly v: 1; readonly type: 'created'; readonly noteId: string; readonly note: NewNote }
  /**
   * The answer to `createPeriodic`: the whole new note, for the app to store,
   * file through the daily intent and open (T40 P5). `period` is the resolved
   * period (`2026-10-21` or `2026-W43`), an opaque string to the app; `date`
   * is the calendar day it was made for (a week's Monday), which the daily
   * intent sends so a midnight between making and filing files the same note.
   */
  | {
      readonly v: 1;
      readonly type: 'createdPeriodic';
      readonly note: NewNote;
      readonly kind: PeriodKind;
      readonly period: string;
      readonly date: string;
    }
  /**
   * The answer to `periodicNav`: the open note's period and neighbours for
   * the row under its top bar, or null when it is no periodic note (T40 P5,
   * JR4). Every target names an explicit day: the app opens it through
   * `createPeriodic` again, so Kotlin never computes a period.
   */
  | {
      readonly v: 1;
      readonly type: 'periodicNav';
      readonly noteId: string;
      readonly nav: PeriodicNav | null;
    }
  /**
   * The open note's frontmatter tags, sorted (T38): sent when it opens and
   * whenever they change, here or on another device. Inline `#tags` stay in the
   * text, as on the web (A188).
   */
  | {
      readonly v: 1;
      readonly type: 'tags';
      readonly noteId: string;
      readonly tags: readonly string[];
    }
  /**
   * The answer to `copy`, and a code block's Copy button (T40 P8, ED9, ED7):
   * what to put on the clipboard. `html` with rich text only; `text` is the
   * markdown for Copy as Markdown, the readable text for rich text, and the
   * code for `format: 'text'`.
   */
  | {
      readonly v: 1;
      readonly type: 'clipboard';
      readonly noteId: string;
      readonly format: CopyFormat | 'text';
      readonly text: string;
      readonly html?: string;
    }
  /** The answer to `blocks`: the entries for that search, best first (T40 P8, ED4). */
  | {
      readonly v: 1;
      readonly type: 'blocks';
      readonly noteId: string;
      readonly purpose: BlockPurpose;
      readonly query: string;
      readonly items: readonly BlockEntry[];
    }
  /** A toggle was opened or closed: every toggle the note remembers, to keep (T40 P8, ED8). */
  | {
      readonly v: 1;
      readonly type: 'folds';
      readonly noteId: string;
      readonly folds: Readonly<Record<string, boolean>>;
    }
  /** What shows now: the Markdown source (`on`) or the note (T40 P8, ED17), after each change. */
  | { readonly v: 1; readonly type: 'source'; readonly noteId: string; readonly on: boolean }
  /** The Block menu's Delete block removed a block (ED5): what it was, for an Undo snackbar. */
  | {
      readonly v: 1;
      readonly type: 'blockDeleted';
      readonly noteId: string;
      readonly label: string;
    }
  /**
   * The note's counts once typing pauses (T41, A505; T40 P8, NT24), and the
   * selection's when text is selected: as the web's status bar counts them.
   */
  | {
      readonly v: 1;
      readonly type: 'counts';
      readonly noteId: string;
      readonly words: number;
      readonly characters: number;
      /** Whole minutes to read; 0 for no words. */
      readonly minutes: number;
      readonly selection: TextCounts | null;
    }
  /**
   * A file dropped or pasted into the note (T40 P8, ED12): the path the note
   * will hold, the file's name and size. Its bytes follow at once as an array
   * buffer, as a picture's do (A304); the app checks them against the path
   * and answers `fileStored`.
   */
  | {
      readonly v: 1;
      readonly type: 'file';
      readonly noteId: string;
      readonly path: string;
      readonly name: string;
      readonly size: number;
    }
  /** A chip asks for its file's size and type; the app answers `fileInfo` (ED12). */
  | {
      readonly v: 1;
      readonly type: 'fileInfo';
      readonly noteId: string;
      readonly path: string;
    }
  /** A chip's Open or Save a copy (ED12): the app reads the file and hands it on. */
  | {
      readonly v: 1;
      readonly type: 'openFile';
      readonly noteId: string;
      readonly path: string;
      readonly name: string;
      readonly action: FileAction;
    }
  /**
   * Another note's content, for `[[Title#` headings and embeds (T40 P7, LK2, LK4, A470): the
   * app answers `noteContent` with its stored updates, fetching the note first when the phone
   * does not hold it. `noteId` is the note wanted, not the open one.
   */
  | { readonly v: 1; readonly type: 'noteContent'; readonly noteId: string }
  /**
   * Follow (`on`) or stop following a note an embed shows (T40 P7, LK4, A471): while followed,
   * the app says `noteChanged` whenever the phone stores a change to it.
   */
  | { readonly v: 1; readonly type: 'watchNote'; readonly noteId: string; readonly on: boolean }
  /**
   * The open note's details for the Info sheet (T40 P7, NT23, A475), read from its own
   * document when it opens and at most every 300 ms while it changes, never per keystroke:
   * when it was made, its kind and period, its frontmatter as the web's Info panel shows it,
   * and the notes it links to or embeds (`links`, distinct, sorted), so the phone's backlinks
   * follow its own edits before the server has indexed them (A473).
   */
  | {
      readonly v: 1;
      readonly type: 'noteInfo';
      readonly noteId: string;
      readonly created: string | null;
      readonly kind: string;
      readonly period: string | null;
      readonly fields: readonly InfoField[];
      readonly links: readonly string[];
    }
  /**
   * The open note's plain text, capped as the server caps it (`capNoteText`), for the
   * phone's offline index (T40 P6, FD4): sent when typing here pauses for long, and as the
   * note closes or the app goes to the background, only after edits made here.
   */
  | {
      readonly v: 1;
      readonly type: 'text';
      readonly noteId: string;
      readonly text: string;
      /** Its headings, one per line, capped (`MAX_NOTE_HEADINGS_BYTES`). */
      readonly headings: string;
      /** Its tags, frontmatter and inline, canonical and sorted (`noteTags`). */
      readonly tags: readonly string[];
    }
  /**
   * A highlighted `#tag` was tapped while reading, or Ctrl-tapped (T40 P6, TG5): the app opens
   * its notes. `tag` is canonical, the decoration's `data-tag`.
   */
  | { readonly v: 1; readonly type: 'openTag'; readonly noteId: string; readonly tag: string }
  /**
   * A key the page's dispatcher took for one of the app's commands (T40 P9, PL9, A493): one of
   * `keys.app`, the note open or null.
   */
  | { readonly v: 1; readonly type: 'command'; readonly noteId: string | null; readonly id: string }
  | {
      readonly v: 1;
      readonly type: 'error';
      readonly noteId: string | null;
      readonly message: string;
      /** The `createPeriodic` request this error answers, when it answers one (T40 P9, N7). */
      readonly request?: string;
    }
  /** Comment threads (T48): `comments-protocol.ts`. */
  | CommentFromEditor;

const isString = (value: unknown): value is string => typeof value === 'string';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const NOTE_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** What `insertImages` may name: attachments only (A304). */
const ATTACHMENT_PATH = /^attachments\/[0-9a-f]{64}\.(png|jpg|gif|webp|avif)$/;
/**
 * Longer than any tag Ryan types, so one set on the web (which has no limit)
 * can still be removed from the phone (A361); the page normalises what it gets
 * with the shared rules. Checked against apps/android/contract/tags-v1.json.
 */
export const MAX_TAG_CHARS = 1000;

/** A note's remembered toggles, or null when malformed or too many (T40 P8, ED8). */
export function foldsOf(value: unknown): Record<string, boolean> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_FOLDS) return null;
  const out: Record<string, boolean> = {};
  for (const [key, open] of entries) {
    if (!key || key.length > MAX_FOLD_KEY || typeof open !== 'boolean') return null;
    out[key] = open;
  }
  return out;
}

/** Files to insert: 1 to `MAX_INSERT_FILES`, each a file path and a name; null if not. */
function fileEntries(value: unknown): FileEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INSERT_FILES) return null;
  const out: FileEntry[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return null;
    const { path, name } = entry;
    if (!isString(path) || !FILE_PATH.test(path)) return null;
    if (!isString(name) || name.length > MAX_FILE_NAME) return null;
    out.push({ path, name });
  }
  return out;
}

/** A request's tag (T40 P9): the app's own short id. */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** More commands than the registry will ever have: a `keys` message past it is refused. */
const MAX_KEYS_ENTRIES = 1000;

/**
 * The bindings of a `keys` message: lists of strings by command id. Their combinations are
 * checked where they are used (`usableBindings`, A90), as the web checks what sync brings.
 */
function bindingLists(value: unknown): Record<string, readonly string[]> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_KEYS_ENTRIES) return null;
  const out: Record<string, readonly string[]> = {};
  for (const [id, list] of entries) {
    if (!COMMAND_ID_PATTERN.test(id) || !Array.isArray(list)) return null;
    if (!list.every((combo) => isString(combo) && combo.length <= 64)) return null;
    out[id] = list as string[];
  }
  return out;
}

function storedUpdates(value: unknown): StoredUpdate[] | null {
  if (!Array.isArray(value)) return null;
  const out: StoredUpdate[] = [];
  for (const entry of value as unknown[]) {
    const { id, update } = (entry ?? {}) as Record<string, unknown>;
    if (!isString(id) || !isString(update) || !BASE64.test(update)) return null;
    out.push({ id, update });
  }
  return out;
}

function directory(value: unknown): DirectoryEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: DirectoryEntry[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return null;
    const { id, title, folder } = entry;
    if (!isString(id) || !NOTE_ID.test(id) || !isString(title)) return null;
    if (folder !== undefined && !isString(folder)) return null;
    out.push(folder === undefined ? { id, title } : { id, title, folder });
  }
  return out;
}

/**
 * Reads a message from the app; null for anything malformed or from another
 * protocol version (the page ignores it and reports an error).
 */
export function parseToEditor(raw: string): ToEditor | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!isRecord(value) || value['v'] !== BRIDGE_VERSION) return null;
  // Messages about no note in particular.
  switch (value['type']) {
    case 'theme': {
      const { theme, variant } = value;
      if (!isRecord(theme) || (variant !== 'light' && variant !== 'dark')) return null;
      return { v: 1, type: 'theme', theme, variant };
    }
    case 'width': {
      const { full } = value;
      return typeof full === 'boolean' ? { v: 1, type: 'width', full } : null;
    }
    case 'fonts': {
      // The server's rules (A944): a font it would not store is refused, as Kotlin refuses it.
      const { interface: ui, note, noteSize } = value;
      if (ui === undefined || note === undefined || noteSize === undefined) return null;
      if (ui === null || note === null || noteSize === null) return null;
      if (fontSettingProblem(INTERFACE_FONT_SETTING, ui) !== null) return null;
      if (fontSettingProblem(NOTE_FONT_SETTING, note) !== null) return null;
      if (fontSettingProblem(NOTE_FONT_SIZE_SETTING, noteSize) !== null) return null;
      return {
        v: 1,
        type: 'fonts',
        interface: ui as FontChoice,
        note: note as FontChoice,
        noteSize: noteSize as number,
      };
    }
    case 'symbols': {
      // The server's rules (A743): a list it would not store is refused, as on the web.
      const symbols = readSymbolList(value['symbols']);
      return symbols ? { v: 1, type: 'symbols', symbols } : null;
    }
    case 'ime': {
      const { visible } = value;
      return typeof visible === 'boolean' ? { v: 1, type: 'ime', visible } : null;
    }
    case 'preview':
      return { v: 1, type: 'preview' };
    case 'closeLightbox':
      return { v: 1, type: 'closeLightbox' };
    case 'directory': {
      const notes = directory(value['notes']);
      return notes ? { v: 1, type: 'directory', notes } : null;
    }
    case 'createPeriodic': {
      const { kind, day, at, timeZone, template } = value;
      if (kind !== 'daily' && kind !== 'weekly') return null;
      if (day !== null && (!isString(day) || !DAY_PATTERN.test(day))) return null;
      if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return null;
      if (!isString(timeZone) || !timeZone || timeZone.length > 256) return null;
      if (!isString(template)) return null;
      const request = value['request'];
      if (request === undefined)
        return { v: 1, type: 'createPeriodic', kind, day, at, timeZone, template };
      if (!isString(request) || !REQUEST_ID.test(request)) return null;
      return { v: 1, type: 'createPeriodic', kind, day, at, timeZone, template, request };
    }
    case 'keys': {
      const bindings = bindingLists(value['bindings']);
      const app = value['app'];
      if (!bindings || !Array.isArray(app) || app.length > MAX_KEYS_ENTRIES) return null;
      if (!app.every((id) => isString(id) && COMMAND_ID_PATTERN.test(id))) return null;
      return { v: 1, type: 'keys', bindings, app: app as string[] };
    }
    case 'commentAuthor':
      return parseCommentAuthor(value);
  }
  const noteId = value['noteId'];
  if (!isString(noteId) || !NOTE_ID.test(noteId)) return null;
  // An optional notebook (T43, A766): a notebook id when present, else the message is refused.
  const rawNotebook = value['notebook'];
  if (rawNotebook !== undefined && (!isString(rawNotebook) || !NOTE_ID.test(rawNotebook)))
    return null;
  const notebook = rawNotebook === undefined ? {} : { notebook: rawNotebook };
  switch (value['type']) {
    case 'open': {
      const synced = storedUpdates(value['synced']);
      const pending = storedUpdates(value['pending']);
      if (!synced || !pending || typeof value['editable'] !== 'boolean') return null;
      return {
        v: 1,
        type: 'open',
        noteId,
        synced,
        pending,
        editable: value['editable'],
        ...notebook,
      };
    }
    case 'remote': {
      const update = value['update'];
      if (!isString(update) || !BASE64.test(update)) return null;
      return { v: 1, type: 'remote', noteId, update };
    }
    case 'flush':
      return { v: 1, type: 'flush', noteId };
    case 'close':
      return { v: 1, type: 'close', noteId };
    case 'dismiss':
      return { v: 1, type: 'dismiss', noteId };
    case 'focus':
      return { v: 1, type: 'focus', noteId };
    case 'focusTitle':
      return { v: 1, type: 'focusTitle', noteId };
    case 'compact': {
      const updates = storedUpdates(value['updates']);
      return updates ? { v: 1, type: 'compact', noteId, updates } : null;
    }
    case 'format': {
      const command = value['command'];
      const href = value['href'];
      if (!FORMAT_COMMANDS.includes(command as FormatCommand)) return null;
      if (command === 'link') {
        return isString(href) ? { v: 1, type: 'format', noteId, command, href } : null;
      }
      return href === undefined
        ? { v: 1, type: 'format', noteId, command: command as FormatCommand }
        : null;
    }
    case 'insertImages': {
      const paths = value['paths'];
      if (!Array.isArray(paths) || paths.length === 0) return null;
      if (!paths.every((path) => isString(path) && ATTACHMENT_PATH.test(path))) return null;
      return { v: 1, type: 'insertImages', noteId, paths: paths as string[] };
    }
    case 'copyConflicts': {
      const base = storedUpdates(value['base']);
      const edits = storedUpdates(value['edits']);
      if (!base || !edits || edits.length === 0) return null;
      const raw = value['into'];
      if (raw === undefined)
        return { v: 1, type: 'copyConflicts', noteId, base, edits, ...notebook };
      if (!isRecord(raw)) return null;
      const target = raw['noteId'];
      const updates = storedUpdates(raw['updates']);
      if (!isString(target) || !NOTE_ID.test(target) || !updates) return null;
      return {
        v: 1,
        type: 'copyConflicts',
        noteId,
        base,
        edits,
        into: { noteId: target, updates },
        ...notebook,
      };
    }
    case 'attachmentStored': {
      const { path, ok } = value;
      if (!isString(path) || !ATTACHMENT_PATH.test(path) || typeof ok !== 'boolean') return null;
      return { v: 1, type: 'attachmentStored', noteId, path, ok };
    }
    case 'create':
      return { v: 1, type: 'create', noteId, ...notebook };
    case 'periodicNav':
      return { v: 1, type: 'periodicNav', noteId };
    case 'setTag': {
      const { tag, on } = value;
      if (!isString(tag) || !tag.trim() || tag.length > MAX_TAG_CHARS) return null;
      if (typeof on !== 'boolean') return null;
      return { v: 1, type: 'setTag', noteId, tag, on };
    }
    case 'copy': {
      const { format, scope } = value;
      if (!COPY_FORMATS.includes(format as CopyFormat)) return null;
      if (!COPY_SCOPES.includes(scope as CopyScope)) return null;
      return {
        v: 1,
        type: 'copy',
        noteId,
        format: format as CopyFormat,
        scope: scope as CopyScope,
      };
    }
    case 'insertPlain': {
      const { text } = value;
      if (!isString(text) || !text || text.length > MAX_PLAIN_CHARS) return null;
      return { v: 1, type: 'insertPlain', noteId, text };
    }
    case 'source': {
      const { on } = value;
      return typeof on === 'boolean' ? { v: 1, type: 'source', noteId, on } : null;
    }
    case 'captureSelection':
      return { v: 1, type: 'captureSelection', noteId };
    case 'undoDelete':
      return { v: 1, type: 'undoDelete', noteId };
    case 'blocks': {
      const { purpose, query } = value;
      if (!BLOCK_PURPOSES.includes(purpose as BlockPurpose)) return null;
      if (!isString(query) || query.length > MAX_BLOCK_QUERY) return null;
      return { v: 1, type: 'blocks', noteId, purpose: purpose as BlockPurpose, query };
    }
    case 'insert':
    case 'turnInto': {
      const { item } = value;
      if (!isString(item) || !BLOCK_ID.test(item)) return null;
      return value['type'] === 'insert'
        ? { v: 1, type: 'insert', noteId, item }
        : { v: 1, type: 'turnInto', noteId, item };
    }
    case 'block': {
      const { action } = value;
      if (!BLOCK_ACTIONS.includes(action as BlockAction)) return null;
      return { v: 1, type: 'block', noteId, action: action as BlockAction };
    }
    case 'folds': {
      const folds = foldsOf(value['folds']);
      return folds ? { v: 1, type: 'folds', noteId, folds } : null;
    }
    case 'fileStored': {
      const { path, ok } = value;
      if (!isString(path) || !FILE_PATH.test(path) || typeof ok !== 'boolean') return null;
      return { v: 1, type: 'fileStored', noteId, path, ok };
    }
    case 'insertFiles': {
      const files = fileEntries(value['files']);
      return files ? { v: 1, type: 'insertFiles', noteId, files } : null;
    }
    case 'fileInfo': {
      const { path, info } = value;
      if (!isString(path) || !FILE_PATH.test(path)) return null;
      if (info === null) return { v: 1, type: 'fileInfo', noteId, path, info: null };
      if (!isRecord(info)) return null;
      const { size, type } = info;
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;
      if (!isString(type) || !MEDIA_TYPE.test(type)) return null;
      return { v: 1, type: 'fileInfo', noteId, path, info: { size, type } };
    }
    case 'webPictures': {
      const { mode } = value;
      if (!WEB_PICTURE_MODES.includes(mode as WebPictureMode)) return null;
      return { v: 1, type: 'webPictures', noteId, mode: mode as WebPictureMode };
    }
    case 'noteContent': {
      const state = value['state'];
      const updates = storedUpdates(value['updates']);
      if (!CONTENT_STATES.includes(state as ContentState) || !updates) return null;
      if (state !== 'ok' && updates.length > 0) return null;
      return { v: 1, type: 'noteContent', noteId, state: state as ContentState, updates };
    }
    case 'noteChanged':
      return { v: 1, type: 'noteChanged', noteId };
    case 'showHeading': {
      const heading = value['heading'];
      if (!isString(heading) || !heading.trim() || heading.length > MAX_HEADING_CHARS) return null;
      return { v: 1, type: 'showHeading', noteId, heading };
    }
    case 'symbol': {
      const index = value['index'];
      if (typeof index !== 'number' || !Number.isInteger(index)) return null;
      if (index < 0 || index >= MAX_SYMBOLS) return null;
      return { v: 1, type: 'symbol', noteId, index };
    }
    default:
      // Comment threads (T48): read by their own module.
      return COMMENT_TO_EDITOR_TYPES.has(String(value['type']))
        ? parseCommentMessage(value, noteId)
        : null;
  }
}

export function encodeFromEditor(message: FromEditor): string {
  return JSON.stringify(message);
}
