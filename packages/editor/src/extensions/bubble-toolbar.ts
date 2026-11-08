/**
 * The selection toolbar (T14): bold, italic, strikethrough, inline code,
 * highlight, link, "Turn into" and (T15) "Copy as", floating over a text selection. TipTap's
 * BubbleMenu plugin shows, hides and positions it; it never writes to the
 * document. From the keyboard, Alt-F10 moves focus into the toolbar (the
 * WAI-ARIA toolbar pattern: ←/→ between controls, Esc back to the text), and
 * Mod-K opens the link field.
 */
import { Extension, getMarkRange, type Editor } from '@tiptap/core';
import { BubbleMenuPlugin } from '@tiptap/extension-bubble-menu';
import { NodeSelection, PluginKey, TextSelection } from '@tiptap/pm/state';
import { CLIPBOARD_COMMANDS, defaultKeys } from '../clipboard/commands';
import { ariaKeyShortcuts, formatCombo } from '../keys';
import { isApple } from '../platform';
import { TURN_INTO_ITEMS, canTurnInto, turnInto, type BlockItem } from './block-items';
import { COMMENT_ADD_EVENT, commentsEnabled, requestComment } from './comments';

export const selectionToolbarKey = new PluginKey('penmossSelectionToolbar');

interface MarkButton {
  readonly mark: 'bold' | 'italic' | 'strike' | 'code' | 'highlight';
  readonly label: string;
  /** Its line icon's path (24 × 24). */
  readonly icon: string;
  /** ProseMirror key names; Mod is ⌘ on Apple platforms and Ctrl elsewhere. */
  readonly keys: string;
}

/**
 * The marks' buttons, each a line icon (Quanta feedback 3, item 7; A1131), its name in its label
 * and tooltip. Bold, Italic and Inline Code are the app's own icons (`packages/ui` Icon).
 */
const MARK_BUTTONS: readonly MarkButton[] = [
  {
    mark: 'bold',
    label: 'Bold',
    icon: 'M7.5 5h5.5a3.5 3.5 0 0 1 0 7H7.5zM7.5 12h6.5a3.5 3.5 0 0 1 0 7H7.5z',
    keys: 'Mod-b',
  },
  { mark: 'italic', label: 'Italic', icon: 'M10.5 5H18M6 19h7.5M14.5 5l-5 14', keys: 'Mod-i' },
  {
    mark: 'strike',
    label: 'Strikethrough',
    icon: 'M5 12h14M16 7.5C15.4 6 13.9 5 12 5c-2.2 0-4 1.2-4 3 0 1.4 1 2.3 2.6 2.9M8 16.5c.6 1.5 2.2 2.5 4.2 2.5 2.3 0 3.8-1.3 3.8-3 0-.6-.2-1.1-.5-1.5',
    keys: 'Mod-Shift-s',
  },
  // Mod-Shift-E, as in the prototype: Mod-E is the recent-notes switcher (T20).
  {
    mark: 'code',
    label: 'Inline Code',
    icon: 'm8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13',
    keys: 'Mod-Shift-e',
  },
  {
    mark: 'highlight',
    label: 'Highlight',
    icon: 'm14 4.5 5.5 5.5-8 8H6v-5.5zM9.5 9.5l5 5M4 20.5h16',
    keys: 'Mod-Shift-h',
  },
];

const ICON_LINK =
  'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1';
const ICON_COMMENT =
  'M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8.5a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5v-3.5h-1A1.5 1.5 0 0 1 4 15V6.5A1.5 1.5 0 0 1 5.5 5z';
const ICON_COPY =
  'M10.5 8.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5';
const ICON_MENU = 'm7 10 5 5 5-5';

/** `Mod-Shift-h` as `aria-keyshortcuts` wants it (`Control+Shift+H`, or `Meta+Shift+H`). */
export function ariaKeys(keys: string): string {
  return keys
    .split('-')
    .map((part) => {
      if (part === 'Mod') return isApple() ? 'Meta' : 'Control';
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join('+');
}

/** `Mod-Shift-c` as people read it: ⌘⇧C on Apple platforms, Ctrl+Shift+C elsewhere. */
export function shortcutLabel(keys: string): string {
  const apple = isApple();
  const symbols: Record<string, string> = apple
    ? { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' }
    : { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Ctrl: 'Ctrl' };
  const parts = keys.split('-').map((part) => symbols[part] ?? part.toUpperCase());
  return parts.join(apple ? '' : '+');
}

/** A web address for what was typed into the link field (`example.com` gets https). */
export function normaliseHref(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(value)) return `mailto:${value}`;
  if (/^[\w-]+(\.[\w-]+)+([/?#:]|$)/.test(value)) return `https://${value}`;
  return null;
}

/** The app's check and trash icons (`packages/ui` Icon), for the link form's buttons. */
const ICON_CHECK = 'm5 12.5 4.5 4.5L19 7.5';
const ICON_TRASH = 'M5 7h14M10 4h4M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7';

/** A line icon drawn as the app's are: decorative, its button is named. */
function lineIcon(doc: Document, path: string, size = 15): SVGSVGElement {
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(SVG, 'svg');
  for (const [name, value] of Object.entries({
    class: 'i',
    viewBox: '0 0 24 24',
    width: String(size),
    height: String(size),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  })) {
    svg.setAttribute(name, value);
  }
  const shape = doc.createElementNS(SVG, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

export class SelectionToolbar {
  readonly element: HTMLDivElement;
  private readonly controls: HTMLButtonElement[] = [];
  private readonly markButtons = new Map<MarkButton['mark'], HTMLButtonElement>();
  private readonly linkButton: HTMLButtonElement;
  private readonly turnButton: HTMLButtonElement;
  private readonly turnGlyph: HTMLSpanElement;
  private readonly turnMenu: HTMLDivElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly commentButton: HTMLButtonElement;
  private readonly copyMenu: HTMLDivElement;
  private readonly linkForm: HTMLDivElement;
  private readonly linkInput: HTMLInputElement;
  private readonly linkText: HTMLInputElement;
  private readonly linkError: HTMLSpanElement;
  private readonly separator: HTMLSpanElement;
  private current = 0;

  constructor(
    private readonly editor: Editor,
    doc: Document = document,
  ) {
    this.element = doc.createElement('div');
    this.element.className = 'pm-toolbar';
    this.element.setAttribute('role', 'toolbar');
    this.element.setAttribute('aria-label', 'Format selection');
    this.element.dataset['testid'] = 'selection-toolbar';

    // Every button an icon (A1131): its name is its label and tooltip; a menu's has a chevron.
    const button = (label: string, icon: string, className: string, menu = false) => {
      const element = doc.createElement('button');
      element.type = 'button';
      element.className = className;
      element.setAttribute('aria-label', label);
      element.title = label;
      element.append(lineIcon(doc, icon, 16));
      if (menu) element.append(lineIcon(doc, ICON_MENU, 10));
      element.tabIndex = -1;
      this.controls.push(element);
      return element;
    };

    const marks = doc.createElement('div');
    marks.className = 'pm-toolbar-buttons';
    for (const spec of MARK_BUTTONS) {
      const element = button(spec.label, spec.icon, `pm-toolbar-button pm-toolbar-${spec.mark}`);
      element.setAttribute('aria-keyshortcuts', ariaKeys(spec.keys));
      element.title = `${spec.label} (${ariaKeys(spec.keys).replaceAll('+', ' ')})`;
      element.dataset['command'] = `editor.${spec.mark}`;
      element.addEventListener('click', () => this.toggleMark(spec.mark));
      this.markButtons.set(spec.mark, element);
      marks.append(element);
    }
    this.linkButton = button('Link', ICON_LINK, 'pm-toolbar-button pm-toolbar-link');
    this.linkButton.setAttribute('aria-keyshortcuts', ariaKeys('Mod-k'));
    this.linkButton.dataset['command'] = 'editor.link';
    this.linkButton.addEventListener('click', () => this.openLink());
    marks.append(this.linkButton);

    // Before the separator: the roving order ends on Turn into, which table cells hide.
    // A thread on the selection (T48): the app opens the Comments panel with a new comment.
    this.commentButton = button('Comment', ICON_COMMENT, 'pm-toolbar-button pm-toolbar-comment');
    this.commentButton.dataset['command'] = 'editor.comment';
    this.commentButton.addEventListener('click', () => requestComment(this.editor));
    this.copyButton = button('Copy As', ICON_COPY, 'pm-toolbar-button pm-toolbar-copy', true);
    this.copyButton.setAttribute('aria-haspopup', 'menu');
    // Opens the menu of T15's copy commands (T20 coverage).
    this.copyButton.dataset['ui'] = 'menu';
    this.copyButton.setAttribute('aria-expanded', 'false');
    this.copyButton.addEventListener('click', () => this.toggleCopyMenu(!this.copyMenuOpen));
    this.copyButton.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.toggleCopyMenu(true);
      }
    });
    this.separator = doc.createElement('span');
    this.separator.className = 'pm-toolbar-separator';
    this.separator.setAttribute('role', 'separator');

    // The block's own glyph (as in the menu), then the chevron.
    this.turnButton = doc.createElement('button');
    this.turnButton.type = 'button';
    this.turnButton.className = 'pm-toolbar-button pm-toolbar-turn';
    this.turnButton.tabIndex = -1;
    this.turnGlyph = doc.createElement('span');
    this.turnGlyph.className = 'pm-toolbar-glyph';
    this.turnGlyph.setAttribute('aria-hidden', 'true');
    this.turnButton.append(this.turnGlyph, lineIcon(doc, ICON_MENU, 10));
    this.controls.push(this.turnButton);
    this.turnButton.setAttribute('aria-haspopup', 'menu');
    // Opens the menu below; each entry is an "Insert: …" command's block (T20 coverage).
    this.turnButton.dataset['ui'] = 'menu';
    this.turnButton.setAttribute('aria-expanded', 'false');
    this.turnButton.addEventListener('click', () => this.toggleTurnMenu(!this.turnMenuOpen));
    this.turnButton.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.toggleTurnMenu(true);
      }
    });

    this.turnMenu = doc.createElement('div');
    this.turnMenu.className = 'pm-toolbar-menu';
    this.turnMenu.setAttribute('role', 'menu');
    this.turnMenu.setAttribute('aria-label', 'Turn Into');
    this.turnMenu.hidden = true;
    for (const item of TURN_INTO_ITEMS) {
      const entry = doc.createElement('button');
      entry.type = 'button';
      entry.className = 'pm-toolbar-menuitem';
      entry.setAttribute('role', 'menuitemradio');
      entry.tabIndex = -1;
      entry.dataset['block'] = item.id;
      entry.dataset['ui'] = 'option';
      const icon = doc.createElement('span');
      icon.className = 'pm-slash-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = item.icon;
      const label = doc.createElement('span');
      label.textContent = item.label;
      entry.append(icon, label);
      entry.addEventListener('click', () => this.turnInto(item));
      this.turnMenu.append(entry);
    }
    this.turnMenu.addEventListener('keydown', (event) =>
      this.menuKeydown(event, this.turnMenu, this.turnButton),
    );

    this.copyMenu = doc.createElement('div');
    this.copyMenu.className = 'pm-toolbar-menu';
    this.copyMenu.setAttribute('role', 'menu');
    this.copyMenu.setAttribute('aria-label', 'Copy As');
    this.copyMenu.hidden = true;
    for (const item of CLIPBOARD_COMMANDS) {
      const entry = doc.createElement('button');
      entry.type = 'button';
      entry.className = 'pm-toolbar-menuitem';
      entry.setAttribute('role', 'menuitem');
      entry.tabIndex = -1;
      entry.dataset['command'] = item.id;
      const label = doc.createElement('span');
      label.textContent = item.label;
      entry.append(label);
      const shortcut = defaultKeys(item);
      const keys = doc.createElement('kbd');
      keys.className = 'pm-toolbar-keys';
      keys.hidden = !shortcut;
      if (shortcut) {
        entry.setAttribute('aria-keyshortcuts', ariaKeys(shortcut));
        keys.textContent = shortcutLabel(shortcut);
      }
      entry.append(keys);
      entry.addEventListener('click', () => this.copyAs(item.format));
      this.copyMenu.append(entry);
    }
    this.copyMenu.addEventListener('keydown', (event) =>
      this.menuKeydown(event, this.copyMenu, this.copyButton),
    );

    // The link form (T64 item 1): icon-and-text buttons above two fields, the link's text and
    // its address, so a link's words can change as well as where it goes.
    this.linkForm = doc.createElement('div');
    this.linkForm.className = 'pm-toolbar-link-form';
    this.linkForm.hidden = true;
    this.linkForm.addEventListener('pointermove', () => {
      this.linkForm.dataset['pointer'] = 'moved';
    });
    const formButton = (label: string, path: string, name = label) => {
      const element = doc.createElement('button');
      element.type = 'button';
      element.className = 'pm-toolbar-button pm-toolbar-link-action';
      element.setAttribute('aria-label', name);
      const text = doc.createElement('span');
      text.textContent = label;
      element.append(lineIcon(doc, path), text);
      // Apply and Remove finish the Link command's field (T20 coverage).
      element.dataset['ui'] = 'submit';
      return element;
    };
    const apply = formButton('Apply', ICON_CHECK);
    apply.addEventListener('click', () => this.applyLink());
    const remove = formButton('Remove', ICON_TRASH, 'Remove Link');
    remove.addEventListener('click', () => {
      this.backToNote();
      this.editor.chain().setTextSelection(this.linkRange()).unsetLink().run();
      this.closeLink(false);
    });
    const actions = doc.createElement('div');
    actions.className = 'pm-toolbar-link-actions';
    actions.append(apply, remove);
    const field = (label: string, input: HTMLInputElement) => {
      const row = doc.createElement('label');
      row.className = 'pm-toolbar-link-field';
      const name = doc.createElement('span');
      name.textContent = label;
      input.className = 'pm-toolbar-link-input';
      input.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          this.applyLink();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.closeLink(true);
        }
      });
      row.append(name, input);
      return row;
    };
    this.linkText = doc.createElement('input');
    this.linkText.type = 'text';
    this.linkText.setAttribute('aria-label', 'Link text');
    this.linkInput = doc.createElement('input');
    this.linkInput.type = 'url';
    this.linkInput.placeholder = 'Paste or type a link';
    this.linkInput.setAttribute('aria-label', 'Link address');
    this.linkError = doc.createElement('span');
    this.linkError.className = 'pm-toolbar-link-error';
    this.linkError.setAttribute('role', 'alert');
    this.linkForm.append(
      actions,
      field('Text', this.linkText),
      field('Link', this.linkInput),
      this.linkError,
    );

    this.element.append(
      marks,
      this.commentButton,
      this.copyButton,
      this.separator,
      this.turnButton,
      this.turnMenu,
      this.copyMenu,
      this.linkForm,
    );

    // Buttons act on the editor's selection: clicking must not move focus out of it.
    this.element.addEventListener('mousedown', (event) => {
      if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
    });
    this.element.addEventListener('keydown', (event) => this.toolbarKeydown(event));
    this.element.addEventListener('focusin', (event) => {
      const index = this.controls.indexOf(event.target as HTMLButtonElement);
      if (index >= 0) this.setCurrent(index);
    });
    this.setCurrent(0);
  }

  private get turnMenuOpen(): boolean {
    return !this.turnMenu.hidden;
  }

  private get copyMenuOpen(): boolean {
    return !this.copyMenu.hidden;
  }

  /** Whether the toolbar holds focus (it stays shown while it does). */
  get hasFocus(): boolean {
    return this.element.contains(this.element.ownerDocument.activeElement);
  }

  /**
   * The keys each command is bound to now (T20: the app's registry, where the user
   * may have rebound them), so titles and menus show those instead of the defaults.
   */
  keysFor: ((commandId: string) => readonly string[]) | null = null;

  /** Shows the current bindings on the controls that run a command. */
  private labelKeys(): void {
    if (!this.keysFor) return;
    for (const element of this.element.querySelectorAll<HTMLElement>('[data-command]')) {
      const combos = this.keysFor(element.dataset['command'] ?? '');
      if (combos.length > 0) element.setAttribute('aria-keyshortcuts', ariaKeyShortcuts(combos));
      else element.removeAttribute('aria-keyshortcuts');
      const shown = combos[0] ? formatCombo(combos[0]) : '';
      const keys = element.querySelector<HTMLElement>('.pm-toolbar-keys');
      if (keys) {
        keys.textContent = shown;
        keys.hidden = !shown;
      } else {
        const label = element.getAttribute('aria-label') ?? '';
        element.title = shown ? `${label} (${shown})` : label;
      }
    }
  }

  /** Brings the buttons' pressed states and the "Turn into" label up to date. */
  refresh(): void {
    const { editor } = this;
    this.labelKeys();
    for (const [mark, element] of this.markButtons) {
      element.setAttribute('aria-pressed', String(editor.isActive(mark)));
    }
    this.linkButton.setAttribute('aria-pressed', String(editor.isActive('link')));
    this.commentButton.hidden = !commentsEnabled(editor);
    const table = !canTurnInto(editor);
    this.turnButton.hidden = table;
    this.separator.hidden = table;
    if (table) this.toggleTurnMenu(false);
    const active = TURN_INTO_ITEMS.find((item) => item.isActive?.(editor));
    this.turnGlyph.textContent = active ? active.icon : '¶';
    this.turnButton.setAttribute(
      'aria-label',
      active ? `Turn into (Now ${active.label})` : 'Turn Into',
    );
    this.turnButton.title = active ? `Turn Into (Now ${active.label})` : 'Turn Into';
    for (const entry of this.turnMenu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) {
      entry.setAttribute('aria-checked', String(entry.dataset['block'] === active?.id));
    }
  }

  /** Moves focus to the toolbar's current control (Alt-F10). */
  focus(): void {
    this.refresh();
    const controls = this.visibleControls();
    const target = controls.includes(this.controls[this.current]!)
      ? this.controls[this.current]!
      : controls[0];
    target?.focus();
  }

  /** Shows the link field, filled with the selection's link if it has one. */
  openLink(): void {
    this.toggleTurnMenu(false);
    const href = this.editor.getAttributes('link')['href'] as string | undefined;
    this.linkInput.value = href ?? '';
    const { from, to } = this.linkRange();
    this.linkText.value = this.editor.state.doc.textBetween(from, to, ' ');
    this.linkError.textContent = '';
    this.linkForm.hidden = false;
    // A button under a pointer that has not moved since the form opened is not hovered yet
    // (#225): clicking Link leaves the pointer where Remove then appears.
    delete this.linkForm.dataset['pointer'];
    this.element.dataset['mode'] = 'link';
    this.linkInput.focus();
    this.linkInput.select();
  }

  /** Closes the link field and the menus (when the toolbar hides). */
  reset(): void {
    this.linkForm.hidden = true;
    delete this.element.dataset['mode'];
    this.toggleTurnMenu(false);
    this.toggleCopyMenu(false);
  }

  private visibleControls(): HTMLButtonElement[] {
    return this.controls.filter((control) => !control.hidden);
  }

  private setCurrent(index: number) {
    this.current = index;
    this.controls.forEach((control, i) => (control.tabIndex = i === index ? 0 : -1));
  }

  private toolbarKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || this.linkForm.contains(event.target as Node)) return;
    if (this.turnMenu.contains(event.target as Node)) return;
    if (this.copyMenu.contains(event.target as Node)) return;
    const controls = this.visibleControls();
    const at = controls.indexOf(event.target as HTMLButtonElement);
    const move = (index: number) => {
      const control = controls[(index + controls.length) % controls.length];
      if (!control) return;
      event.preventDefault();
      this.setCurrent(this.controls.indexOf(control));
      control.focus();
    };
    switch (event.key) {
      case 'ArrowRight':
        move(at + 1);
        break;
      case 'ArrowLeft':
        move(at - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(controls.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        this.reset();
        this.editor.view.focus();
        break;
    }
  }

  private toggleMark(mark: MarkButton['mark']) {
    this.editor.chain().toggleMark(mark).run();
    this.refresh();
  }

  /** The link around the selection's start when it has one, else the selection. */
  private linkRange(): { from: number; to: number } {
    const { state } = this.editor;
    const { from, to, $from } = state.selection;
    const type = state.schema.marks['link'];
    const range = type && this.editor.isActive('link') ? getMarkRange($from, type) : undefined;
    return range ?? { from, to };
  }

  private applyLink() {
    const raw = this.linkInput.value;
    const range = this.linkRange();
    if (!raw.trim()) {
      this.backToNote();
      this.editor.chain().setTextSelection(range).unsetLink().run();
      this.closeLink(false);
      return;
    }
    const href = normaliseHref(raw);
    if (!href) {
      this.linkError.textContent = 'Enter a web address (https://…) or an email address.';
      return;
    }
    this.backToNote();
    const { state } = this.editor;
    const text = this.linkText.value;
    const linkType = state.schema.marks['link'];
    if (text.trim() && text !== state.doc.textBetween(range.from, range.to, ' ') && linkType) {
      // New words: one text node in the link's place, keeping the first character's other
      // marks (bold, say), selected as the old text was.
      const kept = (state.doc.nodeAt(range.from)?.marks ?? []).filter(
        (mark) => mark.type !== linkType,
      );
      const node = state.schema.text(text, [...kept, linkType.create({ href })]);
      const tr = state.tr.replaceWith(range.from, range.to, node);
      tr.setSelection(TextSelection.create(tr.doc, range.from, range.from + text.length));
      this.editor.view.dispatch(tr);
    } else {
      this.editor.chain().setTextSelection(range).setLink({ href }).run();
    }
    this.closeLink(false);
  }

  /**
   * Focuses the note now, from the link field. Not TipTap's focus(): called while
   * the field has focus, it focuses a frame later and writes the editor's
   * selection back to the page then, undoing a key the browser handled in the
   * meantime (End right after Enter left the link text selected). Focus also
   * leaves the field before it hides, so it never falls to the page.
   */
  private backToNote() {
    if (!this.editor.view.hasFocus()) this.editor.view.focus();
  }

  private closeLink(returnToToolbar: boolean) {
    if (returnToToolbar) this.linkButton.focus();
    else this.backToNote();
    this.linkForm.hidden = true;
    delete this.element.dataset['mode'];
    this.refresh();
  }

  private toggleTurnMenu(open: boolean) {
    if (open) this.toggleCopyMenu(false);
    this.turnMenu.hidden = !open;
    this.turnButton.setAttribute('aria-expanded', String(open));
    if (!open) return;
    this.refresh();
    this.placeMenu(this.turnMenu);
    const items = [...this.turnMenu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  }

  private toggleCopyMenu(open: boolean) {
    if (open) this.toggleTurnMenu(false);
    this.copyMenu.hidden = !open;
    this.copyButton.setAttribute('aria-expanded', String(open));
    if (!open) return;
    this.placeMenu(this.copyMenu);
    this.copyMenu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }

  /** Opens a menu upwards when the window has no room for it below the toolbar. */
  private placeMenu(menu: HTMLElement) {
    const view = this.element.ownerDocument.defaultView;
    const rect = this.element.getBoundingClientRect();
    const below = (view?.innerHeight ?? 0) - rect.bottom;
    const up = below < menu.offsetHeight + 8 && rect.top > below;
    menu.dataset['placement'] = up ? 'top' : 'bottom';
  }

  private copyAs(format: 'markdown' | 'rich') {
    this.toggleCopyMenu(false);
    // Inside the click, so the copy counts as the user's gesture.
    if (format === 'markdown') this.editor.commands.copyAsMarkdown();
    else this.editor.commands.copyAsRichText();
    this.editor.view.focus();
  }

  private menuKeydown(event: KeyboardEvent, menu: HTMLElement, button: HTMLButtonElement) {
    const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    const at = items.indexOf(event.target as HTMLElement);
    const focus = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        focus(at + 1);
        break;
      case 'ArrowUp':
        focus(at - 1);
        break;
      case 'Home':
        focus(0);
        break;
      case 'End':
        focus(items.length - 1);
        break;
      case 'Escape':
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        if (menu === this.copyMenu) this.toggleCopyMenu(false);
        else this.toggleTurnMenu(false);
        button.focus();
        break;
    }
  }

  private turnInto(item: BlockItem) {
    this.toggleTurnMenu(false);
    turnInto(this.editor, item);
    this.refresh();
  }
}

/** Whether the toolbar belongs over this selection: text, outside code, in an editable note. */
export function wantsToolbar(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!editor.isEditable || selection.empty || selection instanceof NodeSelection) return false;
  if (selection.$from.parent.type.spec.code || selection.$to.parent.type.spec.code) return false;
  return state.doc.textBetween(selection.from, selection.to, ' ').trim().length > 0;
}

/** The document the editor is mounted in (an Electron or test window may not be the global one). */
function ownerDocumentOf(editor: Editor): Document {
  const element = editor.options.element as { ownerDocument?: Document } | null | undefined;
  return element?.ownerDocument ?? document;
}

export interface SelectionToolbarStorage {
  toolbar: SelectionToolbar | null;
}

export const SelectionToolbarExtension = Extension.create<object, SelectionToolbarStorage>({
  name: 'selectionToolbar',

  addStorage() {
    return { toolbar: null };
  },

  addProseMirrorPlugins() {
    const { editor, storage } = this;
    const toolbar = new SelectionToolbar(editor, ownerDocumentOf(editor));
    storage.toolbar = toolbar;
    return [
      BubbleMenuPlugin({
        pluginKey: selectionToolbarKey,
        editor,
        element: toolbar.element,
        updateDelay: 120,
        shouldShow: ({ view }) => (view.hasFocus() || toolbar.hasFocus) && wantsToolbar(editor),
        options: {
          placement: 'top',
          offset: 8,
          flip: {},
          shift: { padding: 8 },
          onShow: () => {
            // BubbleMenu makes the toolbar itself a tab stop; its controls are (roving tabindex).
            toolbar.element.tabIndex = -1;
            toolbar.refresh();
          },
          onUpdate: () => toolbar.refresh(),
          onHide: () => toolbar.reset(),
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const show = () => {
      if (!wantsToolbar(this.editor)) return false;
      this.editor.view.dispatch(this.editor.state.tr.setMeta(selectionToolbarKey, 'show'));
      return true;
    };
    return {
      'Alt-F10': () => {
        if (!show()) return false;
        this.storage.toolbar?.focus();
        return true;
      },
      'Mod-k': () => {
        if (!show()) return false;
        this.storage.toolbar?.openLink();
        return true;
      },
    };
  },

  onCreate() {
    const hide = () =>
      this.editor.view.dispatch(this.editor.state.tr.setMeta(selectionToolbarKey, 'hide'));
    // A comment on the selection (T52 item 5): its composer floats at the passage and takes
    // focus, so the toolbar goes rather than show through beside it. Clicking Comment keeps the
    // toolbar's BubbleMenu from hiding on the editor's blur, so it is hidden here.
    this.editor.view.dom.addEventListener(COMMENT_ADD_EVENT, hide);
    // Leaving the toolbar for somewhere other than the note hides it.
    const toolbar = this.storage.toolbar;
    toolbar?.element.addEventListener('focusout', (event) => {
      const next = event.relatedTarget as Node | null;
      if (next && (toolbar.element.contains(next) || this.editor.view.dom.contains(next))) return;
      if (!this.editor.view.hasFocus()) hide();
    });
  },
});
