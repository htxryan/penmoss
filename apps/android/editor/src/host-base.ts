/**
 * The editor host's base (PEN-186, split from `host.ts`): its state, the page's listeners set
 * up once, and what every layer uses to talk to the app. `EditorHost` (`host.ts`) is the
 * last of the layers `HostBase` → `HostServices` → `HostEditing` → `HostNotes` →
 * `HostNoteActions`, each a part of the one class, moved apart unchanged.
 */
import { fractionOf, realScrollClock, ScrollGate, type ScrollClock } from '@penmoss/core/analytics';
import { FuzzyMatcher } from '@penmoss/core/fuzzy';
import { DEFAULT_SYMBOLS, type LineSymbol } from '@penmoss/core/line-symbols';
import { type CollabEditor, type SymbolSource, openLightboxNow } from '@penmoss/editor';
import { oneLineTitle } from '@penmoss/model/title';
import type { CommentAuthor } from '@penmoss/model/comments';
import { bodyJson } from '@penmoss/model/yjs14';
import { type Theme } from '@penmoss/ui/theme';
import { installClickListener } from '@penmoss/ui/analytics/clicks';
import type { Editor } from '@tiptap/core';
import { LinkedNotes } from './linked';
import { PHONE_AUTHOR } from './comments';
import {
  BRIDGE_VERSION,
  clickMessage,
  parseToEditor,
  type DirectoryEntry,
  type FromEditor,
  type ToEditor,
  type WebPictureMode,
} from './protocol';
import { PageKeys } from './keys';
import {
  type Captured,
  EDIT_IDLE_MS,
  EDIT_MAX_WAIT_MS,
  type FileInfo,
  type HostElements,
  type HostOptions,
  type OpenNote,
  PREVIEW_NOTE_ID,
  supportsFieldSizing,
  TEXT_IDLE_MS,
} from './host-support';

export abstract class HostBase {
  protected current: OpenNote | null = null;
  /**
   * How far down the open note is, for usage data (PEN-175): core's gate on the page's own
   * scroll, sent as `scroll` once it settles; it starts from the top with each note opened.
   */
  protected readonly scrollGate: ScrollGate;
  protected readonly usageClock: ScrollClock | null;
  protected readonly idleMs: number;
  protected readonly maxWaitMs: number;
  protected readonly textIdleMs: number;
  protected readonly now: () => Date;
  protected readonly postBytes: (bytes: Uint8Array<ArrayBuffer>) => void;

  /** The phone's notes, newest first (A303), and who wants to hear when titles change. */
  protected notes: readonly DirectoryEntry[] = [];
  protected notesById = new Map<string, DirectoryEntry>();
  protected readonly matcher = new FuzzyMatcher();
  protected readonly linkListeners = new Set<() => void>();

  /** Pasted pictures and files waiting for the app to store them, by path (A311). */
  protected readonly storing = new Map<string, Array<(ok: boolean) => void>>();

  /** Chips waiting for the app to say their file's size and type, by path (ED12). */
  protected readonly asking = new Map<string, Array<(info: FileInfo | null) => void>>();

  /** How pictures from web addresses show, as the app said before the note opened (ED13). */
  protected webPictures: { noteId: string; mode: WebPictureMode } | null = null;
  /** Other notes' bodies for headings and embeds, over the bridge (T40 P7, A470, A471). */
  protected readonly linked: LinkedNotes;

  /** The heading the open note was last scrolled to, and the mark's timer. */
  protected headingMark: { element: HTMLElement; timer: ReturnType<typeof setTimeout> } | null =
    null;

  /** A note this page made (`create`): its title takes the focus when it opens, as on the web. */
  protected focusTitleOf: string | null = null;
  /** Whether the keyboard is up, as the app last said (review S8); null before it has. */
  protected imeVisible: boolean | null = null;

  /** The person's line symbols, as the app last sent them (T44, A747); the defaults until then. */
  protected symbols: readonly LineSymbol[] = DEFAULT_SYMBOLS;
  /** The theme the app last sent (A305), laid again under each change of the fonts. */
  protected theme: { readonly theme: Theme; readonly variant: 'light' | 'dark' } | null = null;
  /** The person's fonts as the app last sent them (T51, A944); the theme's own until then. */
  protected fonts: Readonly<Record<string, unknown>> | null = null;
  protected readonly symbolListeners = new Set<() => void>();
  /** What every editor on the page reads its symbols from, live. */
  protected readonly symbolSource: SymbolSource = {
    get: () => this.symbols,
    subscribe: (listener) => {
      this.symbolListeners.add(listener);
      return () => this.symbolListeners.delete(listener);
    },
  };

  /** Who this phone's comments are by (T48 review S5): the app's `commentAuthor`, else "You". */
  protected commentAuthor: CommentAuthor = PHONE_AUTHOR;

  /** The toggles the app keeps for a note (T40 P8, ED8), sent before it opens. */
  protected folds: { noteId: string; folds: Record<string, boolean> } | null = null;

  /**
   * What was selected, and where, when the selection menu opened (T40 P8
   * review B2): the menu's Copy as and Paste as plain text act on it, since
   * the WebView clears the selection as the menu closes.
   */
  protected captured: { noteId: string; at: Captured } | null = null;

  /** The last Delete block and its undo step, for the snackbar's Undo (re-review). */
  protected deletion: { noteId: string; step: object } | null = null;

  /** The counts last sent, so only changes are sent (NT24). */
  protected lastCounts = '';

  /** The last state sent for the bar, so only changes are sent. */
  protected lastState = '';
  protected stateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The viewport height last seen, to tell the keyboard opening (A307). */
  protected viewportHeight: number | null = null;
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
  protected readonly fitTitle: () => void = () => undefined;

  constructor(
    protected readonly elements: HostElements,
    protected readonly post: (message: FromEditor) => void,
    options: HostOptions = {},
  ) {
    this.idleMs = options.idleMs ?? EDIT_IDLE_MS;
    this.maxWaitMs = options.maxWaitMs ?? EDIT_MAX_WAIT_MS;
    this.textIdleMs = options.textIdleMs ?? TEXT_IDLE_MS;
    this.now = options.now ?? (() => new Date());
    this.postBytes = options.postBytes ?? (() => undefined);
    this.usageClock = options.usageClock ?? null;
    this.scrollGate = new ScrollGate((position) => {
      const open = this.current;
      // The theme preview's sample note is no note of the person's.
      if (!open || open.noteId === PREVIEW_NOTE_ID) return;
      this.post({ v: BRIDGE_VERSION, type: 'scroll', noteId: open.noteId, position });
    }, options.scrollClock ?? realScrollClock);
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
    // The title's typing, for session detail (PEN-177): how many characters went in and out,
    // read after the cleaning above; a title rewritten from elsewhere is no typing here.
    let titleBefore: string | null = null;
    titleElement.addEventListener('beforeinput', () => {
      titleBefore ??= elements.title.value;
    });
    titleElement.addEventListener('input', () => {
      const before = titleBefore;
      titleBefore = null;
      if (before !== null) this.current?.usage?.title(before, elements.title.value);
    });
    titleElement.addEventListener('focus', () => this.current?.usage?.titleFocused());
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
    // The note scrolls with the page: whatever moved it, the person or a link to a heading.
    view?.addEventListener(
      'scroll',
      () => {
        if (!this.current) return;
        const page = elements.root.ownerDocument.scrollingElement;
        if (!page) return;
        this.scrollGate.moved(fractionOf(page.scrollTop, page.scrollHeight, page.clientHeight));
      },
      { passive: true },
    );
    // The editor's tracked widgets (PEN-175): the Mac's page's own listener (@penmoss/ui), each
    // use posted for the app to record, never from the theme preview's sample note.
    installClickListener(elements.root.ownerDocument, (id, state) => {
      const open = this.current;
      if (open !== null && open.noteId !== PREVIEW_NOTE_ID) post(clickMessage(id, state));
    });
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
    this.current?.usage?.flush();
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

  protected notice(noteId: string | null, message: string): void {
    if (noteId !== null) this.post({ v: BRIDGE_VERSION, type: 'notice', noteId, message });
  }

  /** Reports an error; `request` names the tagged request it answers (T40 P9, N7). */
  protected fail(noteId: string | null, message: string, request?: string): void {
    this.post(
      request === undefined
        ? { v: BRIDGE_VERSION, type: 'error', noteId, message }
        : { v: BRIDGE_VERSION, type: 'error', noteId, message, request },
    );
  }

  // Defined by the layers above.
  abstract close(): void;
  protected abstract editableEditor(noteId: string): Editor | null;
  abstract handle(message: ToEditor): void;
  protected abstract prepareForTyping(open: OpenNote, editor: Editor): () => void;
  protected abstract scheduleState(): void;
  protected abstract showDescription(): void;
  protected abstract tagTaps(noteId: string, editor: Editor): () => void;
  protected abstract tappedBelow(event: MouseEvent): void;
}
