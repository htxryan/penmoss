/**
 * The slash menu (T14, FR-ED-3): typing `/` at the start of a line or after a
 * space opens a filterable list of blocks. Typing filters it, ↑/↓ move, Enter
 * or Tab inserts, Esc closes. The caret stays in the editor, which points at
 * the highlighted option with `aria-activedescendant` (WAI-ARIA combobox
 * pattern). TipTap's Suggestion utility tracks the query and positions the
 * menu; it never writes to the document. Only a `/` the user just typed
 * opens it: never a click, arrow, paste, undo or remote edit that leaves the
 * caret after an existing `/word`, and never in code or inline code.
 */
import { shift } from '@floating-ui/dom';
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
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

let menus = 0;

/**
 * How the slash and `[[` menus are placed beyond TipTap's offset and flip (T39): shifted along
 * the line to stay inside the window, so a menu opened near the right edge of a phone is
 * not cut off and does not scroll the page sideways.
 */
export const MENU_FLOATING_UI = { middleware: [shift({ padding: 8 })] };

/** The menu's DOM and keyboard handling; one per editor, shown while a `/query` is active. */
export class SlashMenu {
  readonly element: HTMLDivElement;
  private readonly heading: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly empty: HTMLParagraphElement;
  private readonly id: string;
  private items: readonly BlockItem[] = [];
  private index = 0;
  private query: string | null = null;
  private choose: ((item: BlockItem) => void) | null = null;
  private unmount: (() => void) | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly images: ImageServices | undefined,
    private readonly links: LinkServices | undefined = undefined,
    private readonly files: FileServices | undefined = undefined,
  ) {
    const doc = editor.view.dom.ownerDocument;
    this.id = `pm-slash-${(menus += 1)}`;
    this.element = doc.createElement('div');
    this.element.className = 'pm-slash-menu';
    this.element.dataset['testid'] = 'slash-menu';
    this.heading = doc.createElement('div');
    this.heading.className = 'pm-slash-heading';
    this.heading.id = `${this.id}-heading`;
    this.heading.setAttribute('aria-hidden', 'true');
    this.list = doc.createElement('div');
    this.list.id = this.id;
    this.list.className = 'pm-slash-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Insert block');
    this.empty = doc.createElement('p');
    this.empty.className = 'pm-slash-empty';
    this.empty.setAttribute('role', 'status');
    this.element.append(this.heading, this.list, this.empty);
    // Clicking an option must not take focus (and the selection) from the editor.
    this.element.addEventListener('mousedown', (event) => event.preventDefault());
    this.element.addEventListener('click', (event) => {
      const option = (event.target as Element | null)?.closest<HTMLElement>('[role="option"]');
      const index = Number(option?.dataset['index']);
      if (option && Number.isInteger(index)) this.pick(index);
    });
  }

  get isOpen(): boolean {
    return this.unmount !== null;
  }

  /** The options shown, in order (for tests and the editor's ARIA attributes). */
  get options(): readonly BlockItem[] {
    return this.items;
  }

  get selected(): BlockItem | undefined {
    return this.items[this.index];
  }

  open(props: SuggestionProps<BlockItem, BlockItem>): void {
    this.unmount ??= props.mount(this.element);
    const dom = this.editor.view.dom;
    dom.setAttribute('aria-haspopup', 'listbox');
    dom.setAttribute('aria-controls', this.id);
    dom.setAttribute('aria-autocomplete', 'list');
    this.update(props);
  }

  update(props: SuggestionProps<BlockItem, BlockItem>): void {
    this.choose = props.command;
    this.filter(props.query);
  }

  close(): void {
    this.unmount?.();
    this.unmount = null;
    this.choose = null;
    this.query = null;
    const dom = this.editor.view.dom;
    for (const name of [
      'aria-haspopup',
      'aria-controls',
      'aria-autocomplete',
      'aria-activedescendant',
    ]) {
      dom.removeAttribute(name);
    }
  }

  /** Handles a key while the menu is open; true when the menu used it. */
  keydown(event: KeyboardEvent): boolean {
    if (event.isComposing) return false;
    // Keys can arrive before Suggestion has reported the latest query: catch up first.
    const state = slashMenuKey.getState(this.editor.state) as { query: string | null } | undefined;
    if (state?.query != null) this.filter(state.query);
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (this.items.length === 0) return false;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.highlight((this.index + step + this.items.length) % this.items.length);
        return true;
      }
      case 'Enter':
      case 'Tab':
        if (event.shiftKey || this.items.length === 0) return false;
        this.pick(this.index);
        return true;
      case 'Escape':
        return true;
      default:
        return false;
    }
  }

  private pick(index: number) {
    const item = this.items[index];
    if (item) this.choose?.(item);
  }

  private filter(query: string) {
    if (query === this.query) return;
    this.query = query;
    this.items = filterBlockItems(
      availableBlockItems(this.editor, this.images, this.links, this.files),
      query,
    );
    this.index = 0;
    this.render();
  }

  private render() {
    const doc = this.element.ownerDocument;
    this.heading.textContent = this.query ? 'Blocks' : 'Insert block';
    this.empty.textContent = this.items.length ? '' : `No blocks match “${this.query ?? ''}”`;
    this.empty.hidden = this.items.length > 0;
    this.list.replaceChildren(
      ...this.items.map((item, index) => {
        const option = doc.createElement('div');
        option.id = `${this.id}-${item.id}`;
        option.className = 'pm-slash-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.dataset['index'] = String(index);
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
        return option;
      }),
    );
    this.highlight(this.index);
  }

  /** Marks option `index` as the active one; the options themselves stay as they are. */
  private highlight(index: number) {
    const options = this.list.children;
    options[this.index]?.setAttribute('aria-selected', 'false');
    this.index = index;
    const selected = options[index] as HTMLElement | undefined;
    const dom = this.editor.view.dom;
    if (selected) {
      selected.setAttribute('aria-selected', 'true');
      dom.setAttribute('aria-activedescendant', selected.id);
      selected.scrollIntoView?.({ block: 'nearest' });
    } else {
      dom.removeAttribute('aria-activedescendant');
    }
  }
}

export interface SlashMenuOptions {
  /** Image storage (T10); without it, the menu has no Image entry. */
  images?: ImageServices | undefined;
  /** The note registry (T16); without it, the menu has no Link to note entry. */
  links?: LinkServices | undefined;
  /** File storage (T13); without it, the menu has no File entry. */
  files?: FileServices | undefined;
}

export interface SlashMenuStorage {
  menu: SlashMenu | null;
}

export const SlashMenuExtension = Extension.create<SlashMenuOptions, SlashMenuStorage>({
  name: 'slashMenu',
  // Ahead of the keymaps (Enter, arrows in tables and lists) while the menu is open.
  priority: 1000,

  addOptions() {
    return { images: undefined, links: undefined, files: undefined };
  },

  addStorage() {
    return { menu: null };
  },

  addProseMirrorPlugins() {
    const { editor, options, storage } = this;
    /** Set while the transaction inserting a `/` the user just typed is applied. */
    let typedSlash = false;
    return [
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
          onStart: (props) => {
            storage.menu ??= new SlashMenu(editor, options.images, options.links, options.files);
            storage.menu.open(props);
          },
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
