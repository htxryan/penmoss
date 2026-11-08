/**
 * The symbol picker (T44, A746): a small menu at the caret's line with every symbol, ticked
 * when every line in the selection has it, and "Edit symbols…" (Settings → Symbols). It opens
 * from `editor.symbolPicker`, the slash menu's Symbol, a click on a line's symbols, and the
 * palette. WAI-ARIA menu pattern: focus moves into the menu, ↑/↓/Home/End move, Enter or
 * Space toggles the symbol and closes, a digit toggles that slot, Esc and Tab close, and focus
 * goes back to the note. Nothing here writes to the note except the toggle it runs.
 */
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { symbolColourVar, type LineSymbol } from '@penmoss/core/line-symbols';
import type { Editor } from '@tiptap/core';

export interface SymbolPickerServices {
  readonly symbols: () => readonly LineSymbol[];
  /** The slots every selected line has. */
  readonly active: () => readonly number[];
  readonly toggle: (index: number) => void;
  readonly onEditSymbols: (() => void) | undefined;
  readonly shortcutOf: ((index: number) => string | null) | undefined;
}

let pickers = 0;

export class SymbolPicker {
  readonly element: HTMLDivElement;
  private readonly id: string;
  private items: HTMLElement[] = [];
  private index = 0;
  private opened = false;

  constructor(
    private readonly editor: Editor,
    private readonly services: SymbolPickerServices,
  ) {
    const doc = editor.view.dom.ownerDocument;
    this.id = `pm-symbols-${(pickers += 1)}`;
    this.element = doc.createElement('div');
    this.element.className = 'pm-symbol-picker';
    this.element.id = this.id;
    this.element.setAttribute('role', 'menu');
    this.element.setAttribute('aria-label', 'Symbols');
    this.element.dataset['testid'] = 'symbol-picker';
    this.element.hidden = true;
    this.element.addEventListener('keydown', this.onKeyDown);
    this.element.addEventListener('click', this.onClick);
    // A press on an item keeps focus where it is until the click acts.
    this.element.addEventListener('mousedown', (event) => event.preventDefault());
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** The items' labels, in order (for tests). */
  get labels(): string[] {
    return this.items.map((item) => item.dataset['label'] ?? '');
  }

  open(): void {
    const doc = this.element.ownerDocument;
    if (!this.element.isConnected) doc.body.append(this.element);
    this.render();
    this.element.hidden = false;
    this.opened = true;
    doc.addEventListener('pointerdown', this.onOutside, true);
    this.place();
    this.focusItem(0);
  }

  close(refocus = true): void {
    if (!this.opened) return;
    this.opened = false;
    this.element.hidden = true;
    this.element.ownerDocument.removeEventListener('pointerdown', this.onOutside, true);
    if (refocus && !this.editor.isDestroyed) this.editor.view.focus();
  }

  destroy(): void {
    this.close(false);
    this.element.remove();
  }

  private render() {
    const doc = this.element.ownerDocument;
    const symbols = this.services.symbols();
    const active = new Set(this.services.active());
    this.items = [];
    const rows: HTMLElement[] = symbols.map((symbol, index) => {
      const item = doc.createElement('div');
      item.className = 'pm-symbol-item';
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', String(active.has(index)));
      item.tabIndex = -1;
      item.dataset['slot'] = String(index);
      // Named by its glyph (T51 item 12, A940): the glyph is the item's text.
      item.dataset['label'] = symbol.glyph;
      const glyph = doc.createElement('span');
      glyph.className = 'pm-symbol-item-glyph';
      glyph.style.color = symbolColourVar(symbol.colour);
      glyph.textContent = symbol.glyph;
      const tick = doc.createElement('span');
      tick.className = 'pm-symbol-item-tick';
      tick.setAttribute('aria-hidden', 'true');
      tick.textContent = active.has(index) ? '✓' : '';
      item.append(tick, glyph);
      const keys = this.services.shortcutOf?.(index);
      if (keys) {
        const kbd = doc.createElement('kbd');
        kbd.className = 'pm-symbol-item-keys';
        kbd.textContent = keys;
        item.append(kbd);
        item.setAttribute('aria-keyshortcuts', keys);
      }
      this.items.push(item);
      return item;
    });
    if (symbols.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'pm-symbol-empty';
      empty.textContent = 'No symbols yet.';
      rows.push(empty);
    }
    if (this.services.onEditSymbols) {
      const separator = doc.createElement('div');
      separator.setAttribute('role', 'separator');
      separator.className = 'pm-symbol-separator';
      const edit = doc.createElement('div');
      edit.className = 'pm-symbol-item pm-symbol-edit';
      edit.setAttribute('role', 'menuitem');
      edit.tabIndex = -1;
      edit.dataset['edit'] = '';
      edit.dataset['label'] = 'Edit Symbols…';
      edit.textContent = 'Edit Symbols…';
      this.items.push(edit);
      rows.push(separator, edit);
    }
    this.element.replaceChildren(...rows);
  }

  /** Below the line's symbols in the margin, or below the caret. */
  private place() {
    const { view } = this.editor;
    const { head, $head } = view.state.selection;
    let rect: DOMRect | null = null;
    const line = $head.depth > 0 ? view.nodeDOM($head.before()) : null;
    const margin =
      line instanceof HTMLElement ? line.querySelector<HTMLElement>(':scope > .pm-symbols') : null;
    if (margin) rect = margin.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      try {
        const coords = view.coordsAtPos(head);
        rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
      } catch {
        rect = view.dom.getBoundingClientRect();
      }
    }
    const anchor = rect;
    const reference = { getBoundingClientRect: () => anchor };
    this.element.style.position = 'fixed';
    void computePosition(reference, this.element, {
      placement: 'bottom-start',
      strategy: 'fixed',
      middleware: [offset(4), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      this.element.style.left = `${x}px`;
      this.element.style.top = `${y}px`;
    });
  }

  private focusItem(index: number) {
    if (this.items.length === 0) {
      this.element.tabIndex = -1;
      this.element.focus();
      return;
    }
    this.index = (index + this.items.length) % this.items.length;
    this.items[this.index]!.focus();
  }

  private activate(item: HTMLElement) {
    if ('edit' in item.dataset) {
      this.close(false);
      this.services.onEditSymbols?.();
      return;
    }
    const slot = Number(item.dataset['slot']);
    this.close();
    this.services.toggle(slot);
  }

  private readonly onClick = (event: MouseEvent) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>('.pm-symbol-item');
    if (item) this.activate(item);
  };

  private readonly onOutside = (event: PointerEvent) => {
    if (event.target instanceof Node && this.element.contains(event.target)) return;
    this.close(false);
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const handled = this.key(event);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private key(event: KeyboardEvent): boolean {
    switch (event.key) {
      case 'ArrowDown':
        this.focusItem(this.index + 1);
        return true;
      case 'ArrowUp':
        this.focusItem(this.index - 1);
        return true;
      case 'Home':
        this.focusItem(0);
        return true;
      case 'End':
        this.focusItem(this.items.length - 1);
        return true;
      case 'Enter':
      case ' ': {
        const item = this.items[this.index];
        if (item) this.activate(item);
        return true;
      }
      case 'Escape':
        this.close();
        return true;
      case 'Tab':
        this.close();
        return true;
      default: {
        // By the key's place, not its character: AZERTY's top row types & é " without Shift.
        const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1];
        const slot = digit ? Number(digit) - 1 : -1;
        const item = this.items.find((entry) => entry.dataset['slot'] === String(slot));
        if (!item || event.metaKey || event.ctrlKey || event.altKey) return false;
        this.activate(item);
        return true;
      }
    }
  }
}
