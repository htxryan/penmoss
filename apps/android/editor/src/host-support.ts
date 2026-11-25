/**
 * The editor host's constants, helpers and types (PEN-186, split from `host.ts`): what its
 * layers (`host-base.ts` to `host.ts`) share. `host.ts` exports the constants the tests and the
 * page import.
 */
import { type ScrollClock } from '@penmoss/core/analytics';
import {
  type BlockItem,
  type CollabEditor,
  type FileServices,
  type ImageServices,
  type LinkServices,
  type NoteUsage,
} from '@penmoss/editor';
import { NOTE_ROOT } from '@penmoss/model/replica';
import { type Yjs14Replica } from '@penmoss/model/yjs14';
import type { Editor } from '@tiptap/core';
import * as Y from '@y/y';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { NoteComments } from './comments';
import {
  type BlockAction,
  type BlockEntry,
  type Compacted,
  type FormatCommand,
  type StoredUpdate,
} from './protocol';

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
export const BLOCK_COMMANDS: Record<BlockAction, string> = {
  moveUp: 'editor.moveBlockUp',
  moveDown: 'editor.moveBlockDown',
  duplicate: 'editor.duplicateBlock',
  delete: 'editor.deleteBlock',
};

/** What the + sheet and Turn into show of a block (the slash menu's label, glyph and hint). */
export const blockEntry = (item: BlockItem): BlockEntry => ({
  id: item.id,
  label: item.label,
  icon: item.icon,
  ...(item.hint ? { hint: item.hint } : {}),
});

/** The note's frontmatter fields, as the web writes them (shared, so the two cannot drift). */
export { noteFields } from '@penmoss/model/note-fields';

/**
 * The Info sheet's details are read at most this often while the note changes (T40 P7, NT23):
 * as the web's Info panel reads them, never per keystroke.
 */
export const INFO_EVERY_MS = 300;

/** How long a heading a link opened at stays marked (as the web's `pm-heading-target`). */
export const HEADING_MARK_MS = 2_000;

/** A frontmatter value as the web's Info panel shows it: a list in brackets. */
export const frontmatterValue = (value: unknown): string =>
  Array.isArray(value) ? `[${value.join(', ')}]` : String(value);

/** A doc of these updates, or null when any of them builds on something not among them (A309). */
export function completeDoc(updates: readonly StoredUpdate[]): Y.Doc | null {
  const doc = new Y.Doc();
  for (const stored of updates) Y.applyUpdate(doc, fromBase64(stored.update));
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
    doc.destroy();
    return null;
  }
  return doc;
}

/** A note's body, comparable as text. */
export const bodyOf = (doc: Y.Doc) => JSON.stringify(doc.get(NOTE_ROOT).toDeltaDeep());

/** Whether a note's body holds nothing: no blocks, or only empty paragraphs. */
export function holdsNothing(doc: Y.Doc): boolean {
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
export function compact(stored: readonly StoredUpdate[]): Compacted | null {
  if (stored.length < 2) return null;
  return {
    replaces: stored.map((entry) => entry.id),
    update: toBase64(Y.mergeUpdates(stored.map((entry) => fromBase64(entry.update)))),
  };
}

/** What the web's tag field says for a name that is not a tag (NoteTags). */
export const INVALID_TAG = 'A tag is letters, digits, - and _, with / for levels, and no spaces.';

/** Whether the WebView sizes a textarea to its text by itself (`field-sizing`, Chrome 123+). */
export function supportsFieldSizing(): boolean {
  return typeof CSS === 'undefined' || typeof CSS.supports !== 'function'
    ? true
    : CSS.supports('field-sizing', 'content');
}

/** The title notes show by: as the web app's lists do. */
export const displayTitle = (title: string) => title.trim() || 'Untitled';

/** The id of each bar command that is one of the shared editor commands (T20). */
export const SHARED_COMMANDS: Partial<Record<FormatCommand, string>> = {
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
export const ACTIVE_CHECKS: ReadonlyArray<
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

export function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A selection the menu acts on (B2): in the body (mapped through edits), a text field, or the source. */
export type SelectionBookmark = ReturnType<Editor['state']['selection']['getBookmark']>;
export type Captured =
  | { readonly kind: 'body'; bookmark: SelectionBookmark }
  | {
      readonly kind: 'field';
      readonly field: HTMLInputElement | HTMLTextAreaElement;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: 'source'; readonly text: string };

/** Block kinds by node type, as Delete block's Undo snackbar names them (ED5). */
export const BLOCK_NAMES: Readonly<Record<string, string>> = {
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
export type FileInfo = { readonly size: number; readonly type: string };

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
  /** The clock the note's scroll gate runs on (PEN-175); tests give a fake one. */
  readonly scrollClock?: ScrollClock;
  /** The clock session detail's gates run on (PEN-177); tests give a fake one. */
  readonly usageClock?: ScrollClock;
}

export interface OpenNote {
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
  /** Session detail (PEN-177): the note's shape, typing and cursor, by block, never a word. */
  usage?: NoteUsage;
}
