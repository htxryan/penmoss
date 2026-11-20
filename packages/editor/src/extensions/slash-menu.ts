/**
 * The slash menu (T14, FR-ED-3): typing `/` at the start of a line or after a
 * space opens a filterable list of blocks. Typing filters it, ↑/↓ move, Enter
 * or Tab inserts, Esc closes. The caret stays in the editor, which points at
 * the highlighted option with `aria-activedescendant` (WAI-ARIA combobox
 * pattern). TipTap's Suggestion utility tracks the query and positions the
 * menu; it never writes to the document. Only a `/` the user just typed
 * opens it: never a click, arrow, paste, undo or remote edit that leaves the
 * caret after an existing `/word`, and never in code or inline code.
 *
 * Where the app asks for it (`contextMenu`: the Mac app and the web, not Android, where a
 * long-press selects), a right-click in the note with nothing selected, or the context-menu key
 * or Shift+F10 at the caret, opens the same menu there, with no `/` typed: the caret goes to the
 * click, the menu holds what is typed to filter it (shown as `/query` at its top), and the item
 * chosen goes in at that spot. A right-click with text selected, or on a link, a picture or
 * drawing, a table, code or a comment, keeps the page's own menu.
 */
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Extension, type Editor } from '@tiptap/core';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  Suggestion,
  findSuggestionMatch,
  type SuggestionProps,
  type Trigger,
} from '@tiptap/suggestion';
import { isBindingTransaction } from '../collab/binding';
import { availableBlockItems, filterBlockItems, type BlockItem } from './block-items';
import type { FileServices } from './attachment';
import type { ImageServices } from './image';
import { SuggestionListbox } from './suggestion-listbox';
import type { LinkServices } from './wikilink';

export const slashMenuKey = new PluginKey('penmossSlashMenu');

/** Longest query the menu follows; past it, the slash is taken to be text. */
const MAX_QUERY = 32;

/**
 * `/query` before the caret, where the query may hold single spaces
 * (`/math block`) but not start with one, hold two in a row, or run long:
 * then the slash was text, and the menu closes.
 */
export function findSlashQuery(trigger: Trigger) {
  const match = findSuggestionMatch({ ...trigger, allowSpaces: true });
  if (!match) return null;
  const { query } = match;
  if (/^\s|\s\s/.test(query) || query.length > MAX_QUERY) return null;
  return match;
}

/** Whether the caret is in code: a code block, or inline code (stored or at the caret). */
function inCode(state: EditorState): boolean {
  const { $from } = state.selection;
  if ($from.parent.type.spec.code) return true;
  return (state.storedMarks ?? $from.marks()).some((mark) => mark.type.spec.code);
}

/**
 * Whether the block menu may open at `pos` without a typed `/`: in a textblock that is not code,
 * outside tables, and not in a link or inline code.
 */
export function blockMenuAllowedAt(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return false;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.spec.tableRole) return false;
  }
  const marks = pos === state.selection.from ? (state.storedMarks ?? $pos.marks()) : $pos.marks();
  return !marks.some((mark) => mark.type.spec.code || mark.type.name === 'link');
}

/**
 * What under a right-click keeps the page's own menu: a link, a picture or drawing, a table, code,
 * a comment's passage or marker, and any widget the editor does not edit as text (a formula, an
 * embed, a file).
 */
const OWN_MENU =
  'a, img, table, pre, code, .pm-comment, .pm-comment-marker, [contenteditable="false"]';

let menus = 0;

/**
 * How the slash and `[[` menus are placed beyond TipTap's offset and flip (T39): shifted along
 * the line to stay inside the window, so a menu opened near the right edge of a phone is
 * not cut off and does not scroll the page sideways.
 */
export const MENU_FLOATING_UI = { middleware: [shift({ padding: 8 })] };

/** The menu's options and keyboard handling; one per editor, shown while a `/query` is active. */
export class SlashMenu {
  private readonly listbox: SuggestionListbox<BlockItem>;
  private readonly id: string;
  private query: string | null = null;
  private choose: ((item: BlockItem) => void) | null = null;
  private unmount: (() => void) | null = null;
  /** What is typed to filter the menu opened with no `/` (`/query` at its top). */
  private readonly filterLine: HTMLDivElement;
  /** Set while the menu is open with no `/` typed: where its block goes, and its filter. */
  private context: { pos: number; query: string } | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly images: ImageServices | undefined,
    private readonly links: LinkServices | undefined = undefined,
    private readonly files: FileServices | undefined = undefined,
  ) {
    const doc = editor.view.dom.ownerDocument;
    this.id = `pm-slash-${(menus += 1)}`;
    this.listbox = new SuggestionListbox(editor, {
      id: this.id,
      className: 'pm-slash-menu',
      testId: 'slash-menu',
      label: 'Insert block',
      event: 'editor.slash.pick',
      pick: (item) => this.choose?.(item),
    });
    this.listbox.heading.id = `${this.id}-heading`;
    this.filterLine = doc.createElement('div');
    this.filterLine.className = 'pm-slash-filter';
    this.filterLine.dataset['testid'] = 'slash-filter';
    this.filterLine.setAttribute('aria-hidden', 'true');
    this.filterLine.hidden = true;
    this.listbox.heading.after(this.filterLine);
  }

  get element(): HTMLDivElement {
    return this.listbox.element;
  }

  get isOpen(): boolean {
    return this.unmount !== null;
  }

  /** The options shown, in order (for tests and the editor's ARIA attributes). */
  get options(): readonly BlockItem[] {
    return this.listbox.items;
  }

  get selected(): BlockItem | undefined {
    return this.listbox.selected;
  }

  open(props: SuggestionProps<BlockItem, BlockItem>): void {
    this.unmount ??= props.mount(this.element);
    this.listbox.attach();
    this.update(props);
  }

  update(props: SuggestionProps<BlockItem, BlockItem>): void {
    this.choose = props.command;
    this.filter(props.query);
  }

  /** Whether the menu is open with no `/` typed (a right-click, the context-menu key). */
  get isContextMenu(): boolean {
    return this.context !== null;
  }

  /**
   * Opens the menu at `pos` with no `/` typed: the caret goes there, the menu below it, and the
   * block chosen goes in there. False when it is open already.
   */
  openAt(pos: number): boolean {
    if (this.isOpen) return false;
    const { editor } = this;
    const { view } = editor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    if (!view.hasFocus()) view.focus();
    const context = { pos, query: '' };
    this.context = context;
    this.query = null;
    this.choose = (item) => {
      const at = context.pos;
      this.close();
      const { state } = editor;
      if (!state.selection.empty || state.selection.from !== at) {
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)));
      }
      item.insert({
        editor,
        range: { from: at, to: at },
        images: this.images,
        links: this.links,
        files: this.files,
      });
    };
    this.unmount = this.mountAt(view, context);
    this.listbox.attach();
    this.filter('');
    return true;
  }

  /**
   * Places the menu under `context.pos` as Suggestion places the slash menu, and closes it on a
   * press outside it or when the note loses focus; the place follows every edit meanwhile.
   */
  private mountAt(view: EditorView, context: { pos: number }): () => void {
    const { editor, element } = this;
    const doc = view.dom.ownerDocument;
    const reference = {
      getBoundingClientRect: () => {
        try {
          const at = Math.min(context.pos, view.state.doc.content.size);
          const caret = view.coordsAtPos(at);
          return new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top);
        } catch {
          return view.dom.getBoundingClientRect();
        }
      },
      contextElement: view.dom,
    };
    doc.body.append(element);
    element.style.visibility = 'hidden';
    element.style.width = 'max-content';
    const update = () => {
      void computePosition(reference, element, {
        placement: 'bottom-start',
        strategy: 'absolute',
        middleware: [offset(4), flip(), ...MENU_FLOATING_UI.middleware],
      }).then(({ x, y, strategy }) => {
        Object.assign(element.style, {
          position: strategy,
          left: `${x}px`,
          top: `${y}px`,
          visibility: '',
        });
      });
    };
    const stopUpdates = autoUpdate(reference, element, update);
    const outside = (event: Event) => {
      if (!element.contains(event.target as globalThis.Node | null)) this.close();
    };
    doc.addEventListener('pointerdown', outside, true);
    const follow = ({ transaction }: { transaction: Transaction }) => {
      context.pos = transaction.mapping.map(context.pos);
    };
    const blur = () => this.close();
    editor.on('transaction', follow);
    editor.on('blur', blur);
    return () => {
      stopUpdates();
      doc.removeEventListener('pointerdown', outside, true);
      editor.off('transaction', follow);
      editor.off('blur', blur);
      element.remove();
    };
  }

  /**
   * A key while the menu is open with no `/` typed: letters and Backspace edit its filter (the
   * note is untouched), ↑/↓, Enter and Tab work as in the slash menu, Escape closes it, and any
   * other key closes it and does what it does.
   */
  contextKeydown(event: KeyboardEvent): boolean {
    const context = this.context;
    if (!context) return false;
    if (event.isComposing) {
      this.close();
      return false;
    }
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case 'Tab':
        if (event.shiftKey || this.listbox.items.length === 0) {
          if (event.key === 'Enter' || event.key === 'Tab') this.close();
          return false;
        }
        return this.keydown(event);
      case 'Escape':
        this.close();
        return true;
      case 'Backspace':
        if (context.query === '') {
          this.close();
          return true;
        }
        context.query = context.query.slice(0, -1);
        this.filter(context.query);
        return true;
      default:
        break;
    }
    const typed =
      event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
        ? context.query + event.key
        : null;
    if (typed === null || /^\s|\s\s/.test(typed) || typed.length > MAX_QUERY) {
      this.close();
      return false;
    }
    context.query = typed;
    this.filter(typed);
    return true;
  }

  close(): void {
    this.unmount?.();
    this.unmount = null;
    this.choose = null;
    this.query = null;
    this.context = null;
    this.filterLine.hidden = true;
    this.listbox.detach();
  }

  /** Handles a key while the menu is open; true when the menu used it. */
  keydown(event: KeyboardEvent): boolean {
    if (event.isComposing) return false;
    // Keys can arrive before Suggestion has reported the latest query: catch up first.
    const state = slashMenuKey.getState(this.editor.state) as { query: string | null } | undefined;
    if (state?.query != null) this.filter(state.query);
    return event.key === 'Escape' || this.listbox.keydown(event);
  }

  private filter(query: string) {
    if (query === this.query) return;
    this.query = query;
    const items = filterBlockItems(
      availableBlockItems(this.editor, this.images, this.links, this.files),
      query,
    );
    this.listbox.heading.textContent = query ? 'Blocks' : 'Insert block';
    // Opened with no `/` typed, the menu shows its own filter, as the note shows a typed `/query`.
    this.filterLine.hidden = this.context === null;
    this.filterLine.textContent = this.context ? `/${this.context.query}` : '';
    this.filterLine.classList.toggle('pm-slash-filter-empty', !this.context?.query);
    this.listbox.show(items, {
      index: 0,
      empty: `No blocks match “${query}”`,
      key: (item) => item.id,
      fill: (option, item, doc) => {
        const icon = doc.createElement('span');
        icon.className = 'pm-slash-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = item.icon;
        const label = doc.createElement('span');
        label.className = 'pm-slash-label';
        label.textContent = item.label;
        option.append(icon, label);
        if (item.hint) {
          const hint = doc.createElement('kbd');
          hint.className = 'pm-slash-hint';
          hint.setAttribute('aria-hidden', 'true');
          hint.textContent = item.hint.trim();
          option.append(hint);
        }
      },
    });
  }
}

export interface SlashMenuOptions {
  /** Image storage (T10); without it, the menu has no Image entry. */
  images?: ImageServices | undefined;
  /** The note registry (T16); without it, the menu has no Link to note entry. */
  links?: LinkServices | undefined;
  /** File storage (T13); without it, the menu has no File entry. */
  files?: FileServices | undefined;
  /**
   * A right-click with nothing selected, or the context-menu key or Shift+F10, opens the menu at
   * that spot with no `/` typed. The Mac app and the web; not Android, where a long-press selects.
   */
  contextMenu?: boolean;
}

export interface SlashMenuStorage {
  menu: SlashMenu | null;
}

export const SlashMenuExtension = Extension.create<SlashMenuOptions, SlashMenuStorage>({
  name: 'slashMenu',
  // Ahead of the keymaps (Enter, arrows in tables and lists) while the menu is open.
  priority: 1000,

  addOptions() {
    return { images: undefined, links: undefined, files: undefined, contextMenu: false };
  },

  addStorage() {
    return { menu: null };
  },

  addProseMirrorPlugins() {
    const { editor, options, storage } = this;
    /** Set while the transaction inserting a `/` the user just typed is applied. */
    let typedSlash = false;
    const menu = () =>
      (storage.menu ??= new SlashMenu(editor, options.images, options.links, options.files));
    /** Whether the menu may open at `pos` with no `/` typed, with nothing selected. */
    const allowed = (view: EditorView, pos: number): boolean =>
      view.editable &&
      view.state.selection.empty &&
      storage.menu?.isOpen !== true &&
      blockMenuAllowedAt(view.state, pos);
    /** The place under a right-click, where the block menu opens for it; else null. */
    const placeFor = (view: EditorView, event: MouseEvent): number | null => {
      const target = event.target as Element | null;
      const own = target?.closest?.(OWN_MENU);
      if (own && own !== view.dom && view.dom.contains(own)) return null;
      const found = view.posAtCoords({ left: event.clientX, top: event.clientY });
      return found && allowed(view, found.pos) ? found.pos : null;
    };
    /**
     * Where the last right-button press will open the menu, decided as it went down: a Mac
     * selects the word under a right-click before the contextmenu event, which would look like a
     * selection by then.
     */
    let pressed: number | null = null;
    const contextMenu = new Plugin({
      key: new PluginKey('penmossBlockContextMenu'),
      props: {
        handleKeyDown: (view, event) => {
          if (storage.menu?.isContextMenu) return storage.menu.contextKeydown(event);
          const key =
            event.key === 'ContextMenu' ||
            (event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.metaKey);
          const at = view.state.selection.from;
          return key && allowed(view, at) && menu().openAt(at);
        },
        handleDOMEvents: {
          mousedown: (view, event) => {
            pressed = event.button === 2 ? placeFor(view, event) : null;
            // No word selected under it: the menu opens at the caret's new place instead.
            if (pressed !== null) event.preventDefault();
            return pressed !== null;
          },
          contextmenu: (view, event) => {
            // The key's own contextmenu event, once the key has opened the menu.
            if (storage.menu?.isContextMenu) {
              event.preventDefault();
              return true;
            }
            const at = pressed ?? placeFor(view, event);
            pressed = null;
            if (at === null || !menu().openAt(at)) return false;
            event.preventDefault();
            return true;
          },
        },
      },
    });
    return [
      ...(options.contextMenu ? [contextMenu] : []),
      new Plugin({
        key: new PluginKey('penmossSlashTyped'),
        props: {
          handleTextInput: (_view, _from, _to, text) => {
            typedSlash = text.endsWith('/');
            return false;
          },
        },
        view: () => ({
          // Every transaction after the typed one (a click, an arrow, a paste) is not typing.
          update: () => {
            typedSlash = false;
          },
        }),
      }),
      Suggestion<BlockItem, BlockItem>({
        pluginKey: slashMenuKey,
        editor,
        floatingUi: MENU_FLOATING_UI,
        char: '/',
        allowSpaces: true,
        findSuggestionMatch: findSlashQuery,
        decorationClass: 'pm-slash-query',
        allow: ({ state }) => !inCode(state),
        // An open menu follows its query through any change; only a typed `/` opens it.
        shouldShow: ({ transaction }) =>
          storage.menu?.isOpen === true ||
          (typedSlash && !isBindingTransaction(transaction) && transaction.docChanged),
        command: ({ editor: target, range, props: item }) => {
          item.insert({
            editor: target,
            range,
            images: options.images,
            links: options.links,
            files: options.files,
          });
        },
        render: () => ({
          onStart: (props) => menu().open(props),
          onUpdate: (props) => storage.menu?.update(props),
          onKeyDown: ({ event }) => storage.menu?.keydown(event) ?? false,
          onExit: () => storage.menu?.close(),
        }),
      }),
    ];
  },

  onDestroy() {
    this.storage.menu?.close();
  },
});
