/**
 * The listbox the slash menu (T14) and the `[[` menu (T16) share: the WAI-ARIA combobox pattern
 * with the caret kept in the editor. It owns the menu's DOM (a heading, the `role="listbox"` list
 * and an empty status), the editor's `aria-haspopup`, `aria-controls`, `aria-autocomplete` and
 * `aria-activedescendant`, the highlighted option, ↑/↓ (wrapping), Enter and Tab, and a click on
 * an option. Each menu builds its own options and fills each option's row.
 */
import type { Editor } from '@tiptap/core';

/** The attributes on the editor's DOM while a menu is open. */
const OPEN_ATTRIBUTES = ['aria-haspopup', 'aria-controls', 'aria-autocomplete'] as const;

export interface SuggestionListboxOptions<T> {
  /** The list's id, and the prefix of its options' ids. */
  readonly id: string;
  /** The menu element's classes. */
  readonly className: string;
  readonly testId: string;
  /** The list's accessible name. */
  readonly label: string;
  /** The click id every option records (usage analytics, PEN-175). */
  readonly event: string;
  /** An option chosen by Enter, Tab or a click. */
  readonly pick: (item: T, index: number) => void;
}

export class SuggestionListbox<T> {
  readonly element: HTMLDivElement;
  readonly heading: HTMLDivElement;
  readonly list: HTMLDivElement;
  private readonly empty: HTMLParagraphElement;
  private shown: readonly T[] = [];
  private active = 0;

  constructor(
    private readonly editor: Editor,
    private readonly options: SuggestionListboxOptions<T>,
  ) {
    const doc = editor.view.dom.ownerDocument;
    this.element = doc.createElement('div');
    this.element.className = options.className;
    this.element.dataset['testid'] = options.testId;
    this.heading = doc.createElement('div');
    this.heading.className = 'pm-slash-heading';
    this.heading.setAttribute('aria-hidden', 'true');
    this.list = doc.createElement('div');
    this.list.id = options.id;
    this.list.className = 'pm-slash-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', options.label);
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

  /** The options shown, in order. */
  get items(): readonly T[] {
    return this.shown;
  }

  /** The highlighted option's index. */
  get index(): number {
    return this.active;
  }

  get selected(): T | undefined {
    return this.shown[this.active];
  }

  /** Points the editor at the list, as the menu opens. */
  attach(): void {
    const dom = this.editor.view.dom;
    dom.setAttribute('aria-haspopup', 'listbox');
    dom.setAttribute('aria-controls', this.options.id);
    dom.setAttribute('aria-autocomplete', 'list');
  }

  /** Takes the menu's attributes off the editor, as the menu closes. */
  detach(): void {
    const dom = this.editor.view.dom;
    for (const name of [...OPEN_ATTRIBUTES, 'aria-activedescendant']) dom.removeAttribute(name);
  }

  /**
   * Shows `items`, each a `role="option"` row whose id is the list's id and `key`, filled in by
   * `fill`, and highlights `index` (kept inside the list). With no items, `empty` is the status.
   */
  show(
    items: readonly T[],
    {
      index,
      empty,
      key,
      fill,
    }: {
      index: number;
      empty: string;
      key: (item: T, index: number) => string;
      fill: (option: HTMLDivElement, item: T, doc: Document) => void;
    },
  ): void {
    const doc = this.element.ownerDocument;
    this.shown = items;
    this.active = index;
    this.empty.textContent = items.length ? '' : empty;
    this.empty.hidden = items.length > 0;
    this.list.replaceChildren(
      ...items.map((item, at) => {
        const option = doc.createElement('div');
        option.id = `${this.options.id}-${key(item, at)}`;
        option.className = 'pm-slash-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.dataset['index'] = String(at);
        option.dataset['event'] = this.options.event;
        fill(option, item, doc);
        return option;
      }),
    );
    this.highlight(Math.min(index, Math.max(0, items.length - 1)));
  }

  /** ↑/↓ move the highlight (wrapping), Enter and Tab pick it; true when the key was used. */
  keydown(event: KeyboardEvent): boolean {
    if (event.isComposing) return false;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (this.shown.length === 0) return false;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.highlight((this.active + step + this.shown.length) % this.shown.length);
        return true;
      }
      case 'Enter':
      case 'Tab':
        if (event.shiftKey || this.shown.length === 0) return false;
        this.pick(this.active);
        return true;
      default:
        return false;
    }
  }

  private pick(index: number): void {
    const item = this.shown[index];
    if (item !== undefined) this.options.pick(item, index);
  }

  /** Marks option `index` as the active one; the options themselves stay as they are. */
  private highlight(index: number): void {
    const options = this.list.children;
    options[this.active]?.setAttribute('aria-selected', 'false');
    this.active = index;
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
