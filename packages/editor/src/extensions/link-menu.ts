/**
 * Note completion for `[[` (T16), and `![[` for embeds (T13). The menu lists
 * notes from the local registry (fuzzy, so it works offline), offers to
 * create a note with the typed title, and after `#` lists the chosen note's
 * headings. `|alias` is kept as typed. Picking an option replaces the typed
 * text with a link node in one transaction. Like the slash menu (T14) the
 * editor keeps focus and points at the active option, and only a local edit
 * opens it, never a remote one.
 */
import { headingKey } from '@penmoss/core/line-symbols';
import { parseWikiReference } from '@penmoss/core/wikilinks';
import type { Editor, Range } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import { PluginKey, TextSelection, type EditorState, type Plugin } from '@tiptap/pm/state';
import { Suggestion, type SuggestionMatch, type SuggestionProps } from '@tiptap/suggestion';
import { isBindingTransaction } from '../collab/binding';
import { MENU_FLOATING_UI } from './slash-menu';
import type { LinkServices } from './wikilink';

export const linkMenuKey = new PluginKey('penmossLinkMenu');

const MAX_QUERY = 120;
const MAX_NOTES = 8;
/** Stands for an atom (another link, an image) in the text before the caret. */
const LEAF = String.fromCharCode(0xfffc);

export type LinkOption =
  | { readonly kind: 'note'; readonly id: string; readonly title: string; readonly detail?: string }
  | { readonly kind: 'create'; readonly title: string }
  | {
      readonly kind: 'heading';
      readonly id: string;
      readonly title: string;
      readonly heading: string;
    }
  | { readonly kind: 'loading' };

/** What was typed after `[[`, and whether `!` made it an embed. */
export interface LinkQuery {
  readonly embed: boolean;
  readonly target: string;
  readonly heading: string | null;
  readonly alias: string | null;
}

export function parseLinkQuery(text: string): LinkQuery {
  const embed = text.startsWith('!');
  const ref = parseWikiReference(text.replace(/^!?\[\[/, ''));
  return {
    embed,
    target: ref.target,
    heading: ref.heading,
    alias: ref.alias?.trim() ? ref.alias.trim() : null,
  };
}

/**
 * `[[query` (or `![[query`) before the caret in this textblock, with no `]]`
 * after it: the range to replace and the query. Null when there is none.
 */
export function findLinkQuery({ $position }: { $position: ResolvedPos }): SuggestionMatch {
  const text = $position.parent.textBetween(0, $position.parentOffset, undefined, LEAF);
  const open = text.lastIndexOf('[[');
  if (open === -1) return null;
  const query = text.slice(open + 2);
  if (query.includes(']]') || query.includes(LEAF) || query.length > MAX_QUERY) return null;
  if (/^\s/.test(query)) return null;
  const start = text[open - 1] === '!' ? open - 1 : open;
  const from = $position.start() + start;
  return { range: { from, to: $position.pos }, query, text: text.slice(start) };
}

function inCode(state: EditorState): boolean {
  const { $from } = state.selection;
  if ($from.parent.type.spec.code) return true;
  return (state.storedMarks ?? $from.marks()).some((mark) => mark.type.spec.code);
}

/** The options for `query`; headings come later (they are read from the note), so `refresh` re-asks. */
export function linkOptions(
  query: LinkQuery,
  services: LinkServices,
  headings: ReadonlyMap<string, readonly string[] | 'loading'>,
): LinkOption[] {
  const target = query.target.trim();
  if (query.heading !== null) {
    const id = services.resolve(target) ?? services.search(target, 1)[0]?.id ?? null;
    if (!id) return [];
    const title = services.title(id) ?? target;
    const known = headings.get(id);
    if (known === undefined || known === 'loading') return [{ kind: 'loading' }];
    const wanted = query.heading.trim().toLowerCase();
    const matching = known.filter((heading) => heading.toLowerCase().includes(wanted));
    const options: LinkOption[] = matching.map((heading) => ({
      kind: 'heading',
      id,
      title,
      heading,
    }));
    // A heading is the same with or without its leading symbols (T44, A748).
    if (wanted && !known.some((heading) => headingKey(heading) === headingKey(wanted))) {
      options.push({ kind: 'heading', id, title, heading: query.heading.trim() });
    }
    return options;
  }
  const options: LinkOption[] = services.search(target, MAX_NOTES).map((note) => ({
    kind: 'note',
    id: note.id,
    title: note.title,
    ...(note.detail ? { detail: note.detail } : {}),
  }));
  const exact = options.some(
    (option) => option.kind === 'note' && option.title.toLowerCase() === target.toLowerCase(),
  );
  if (target && !exact && !query.embed) options.push({ kind: 'create', title: target });
  return options;
}

let menus = 0;
const menusByEditor = new WeakMap<Editor, LinkMenu>();

/** The menu's DOM and keyboard handling; one per editor. */
export class LinkMenu {
  readonly element: HTMLDivElement;
  private readonly heading: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly empty: HTMLParagraphElement;
  private readonly id: string;
  private options: LinkOption[] = [];
  private index = 0;
  private query: LinkQuery | null = null;
  private range: Range | null = null;
  private unmount: (() => void) | null = null;
  private readonly headings = new Map<string, readonly string[] | 'loading'>();
  private readonly offTitles: () => void;

  constructor(
    private readonly editor: Editor,
    private readonly services: LinkServices,
  ) {
    const doc = editor.view.dom.ownerDocument;
    this.id = `pm-link-${(menus += 1)}`;
    this.element = doc.createElement('div');
    this.element.className = 'pm-slash-menu pm-link-menu';
    this.element.dataset['testid'] = 'link-menu';
    this.heading = doc.createElement('div');
    this.heading.className = 'pm-slash-heading';
    this.heading.setAttribute('aria-hidden', 'true');
    this.list = doc.createElement('div');
    this.list.id = this.id;
    this.list.className = 'pm-slash-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Link to note');
    this.empty = doc.createElement('p');
    this.empty.className = 'pm-slash-empty';
    this.empty.setAttribute('role', 'status');
    this.element.append(this.heading, this.list, this.empty);
    this.element.addEventListener('mousedown', (event) => event.preventDefault());
    this.element.addEventListener('click', (event) => {
      const option = (event.target as Element | null)?.closest<HTMLElement>('[role="option"]');
      const index = Number(option?.dataset['index']);
      if (option && Number.isInteger(index)) this.pick(index);
    });
    // A note renamed or synced while the menu is open shows at once.
    this.offTitles = services.subscribe(() => {
      if (this.isOpen) this.refresh();
    });
  }

  get isOpen(): boolean {
    return this.unmount !== null;
  }

  /** The options shown (tests). */
  get shown(): readonly LinkOption[] {
    return this.options;
  }

  open(props: SuggestionProps<LinkOption, LinkOption>): void {
    this.unmount ??= props.mount(this.element);
    const dom = this.editor.view.dom;
    dom.setAttribute('aria-haspopup', 'listbox');
    dom.setAttribute('aria-controls', this.id);
    dom.setAttribute('aria-autocomplete', 'list');
    this.update(props);
  }

  update(props: SuggestionProps<LinkOption, LinkOption>): void {
    this.range = props.range;
    this.query = parseLinkQuery(props.text);
    this.refresh();
  }

  close(): void {
    this.unmount?.();
    this.unmount = null;
    this.query = null;
    this.range = null;
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

  destroy(): void {
    this.close();
    this.offTitles();
  }

  keydown(event: KeyboardEvent): boolean {
    if (event.isComposing) return false;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (this.options.length === 0) return false;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.highlight((this.index + step + this.options.length) % this.options.length);
        return true;
      }
      case 'Enter':
      case 'Tab':
        if (event.shiftKey || this.options.length === 0) return false;
        this.pick(this.index);
        return true;
      default:
        return false;
    }
  }

  private refresh(): void {
    const query = this.query;
    if (!query) return;
    const previous = this.options[this.index];
    this.options = linkOptions(query, this.services, this.headings);
    if (query.heading !== null) this.loadHeadings(query);
    const same = previous
      ? this.options.findIndex((option) => JSON.stringify(option) === JSON.stringify(previous))
      : -1;
    this.index = same === -1 ? 0 : same;
    this.render(query);
  }

  private loadHeadings(query: LinkQuery): void {
    const target = query.target.trim();
    const id = this.services.resolve(target) ?? this.services.search(target, 1)[0]?.id;
    if (!id || this.headings.has(id)) return;
    if (!this.services.headings) {
      this.headings.set(id, []);
      this.refresh();
      return;
    }
    this.headings.set(id, 'loading');
    this.services.headings(id).then(
      (found) => {
        this.headings.set(id, found);
        if (this.isOpen) this.refresh();
      },
      () => {
        this.headings.set(id, []);
        if (this.isOpen) this.refresh();
      },
    );
  }

  private pick(index: number): void {
    const option = this.options[index];
    const query = this.query;
    const range = this.range;
    if (!option || !query || !range || option.kind === 'loading') return;
    let noteId: string | null;
    let title: string;
    let heading = query.heading?.trim() || null;
    if (option.kind === 'create') {
      noteId = this.services.create(option.title);
      title = option.title;
      if (!noteId) return;
    } else {
      noteId = option.id;
      title = option.title;
      if (option.kind === 'heading') heading = option.heading;
    }
    insertLink(this.editor, range, {
      noteId,
      target: title,
      heading,
      alias: query.alias,
      embed: query.embed,
    });
  }

  private render(query: LinkQuery): void {
    const doc = this.element.ownerDocument;
    this.heading.textContent = query.embed
      ? 'Embed note'
      : query.heading !== null
        ? 'Link to heading'
        : 'Link to note';
    const none = this.options.length === 0;
    this.empty.hidden = !none;
    this.empty.textContent = none
      ? query.heading !== null
        ? 'No matching note'
        : query.target.trim()
          ? `No notes match “${query.target.trim()}”`
          : 'No notes yet'
      : '';
    this.list.replaceChildren(
      ...this.options.map((option, index) => {
        const element = doc.createElement('div');
        element.id = `${this.id}-${index}`;
        element.className = 'pm-slash-option';
        element.setAttribute('role', 'option');
        element.setAttribute('aria-selected', 'false');
        element.dataset['index'] = String(index);
        const icon = doc.createElement('span');
        icon.className = 'pm-slash-icon';
        icon.setAttribute('aria-hidden', 'true');
        const label = doc.createElement('span');
        label.className = 'pm-slash-label';
        element.append(icon, label);
        switch (option.kind) {
          case 'note':
            icon.textContent = query.embed ? '⧉' : '↗';
            label.textContent = option.title;
            if (option.detail) element.append(hint(doc, option.detail));
            break;
          case 'create':
            icon.textContent = '+';
            label.textContent = `Create “${option.title}”`;
            element.append(hint(doc, 'New Note'));
            break;
          case 'heading':
            icon.textContent = '#';
            label.textContent = option.heading;
            element.append(hint(doc, option.title));
            break;
          case 'loading':
            icon.textContent = '…';
            label.textContent = 'Reading headings…';
            element.setAttribute('aria-disabled', 'true');
            break;
        }
        return element;
      }),
    );
    this.highlight(Math.min(this.index, Math.max(0, this.options.length - 1)));
  }

  private highlight(index: number): void {
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

function hint(doc: Document, text: string): HTMLElement {
  const element = doc.createElement('span');
  element.className = 'pm-slash-hint pm-link-detail';
  element.textContent = text;
  return element;
}

/**
 * Replaces the typed `[[query` with a link (one transaction, one undo step).
 * An embed is a block: it takes the place of an otherwise empty paragraph, or
 * goes after the caret's block.
 */
export function insertLink(
  editor: Editor,
  range: Range,
  link: {
    noteId: string | null;
    target: string;
    heading: string | null;
    alias: string | null;
    embed: boolean;
  },
): boolean {
  const { state } = editor.view;
  const attrs = {
    noteId: link.noteId,
    target: link.target,
    heading: link.heading,
    alias: link.alias,
  };
  const embedType = state.schema.nodes['embed'];
  const tr = state.tr;
  if (link.embed && embedType) {
    tr.delete(range.from, range.to);
    const $from = tr.selection.$from;
    const block = $from.parent;
    const node = embedType.create({ ...attrs, alias: null });
    // The embed replaces an empty paragraph, or goes after the caret's top-level block.
    const start =
      block.isTextblock && block.content.size === 0 && $from.depth === 1 ? $from.before() : null;
    if (start !== null) tr.replaceWith(start, $from.after(), node);
    else tr.insert($from.depth > 0 ? $from.after(1) : $from.pos, node);
    const after = (start ?? ($from.depth > 0 ? $from.after(1) : $from.pos)) + node.nodeSize;
    // Typing goes on below it: in the next block, or a new paragraph at the end.
    if (after >= tr.doc.content.size) tr.insert(after, state.schema.nodes['paragraph']!.create());
    tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
  } else {
    const node = state.schema.nodes['wikilink']!.create(attrs);
    tr.replaceWith(range.from, range.to, node);
    // A space after the link, so typing goes on as text (Obsidian does the same).
    const after = range.from + node.nodeSize;
    if (tr.doc.textBetween(after, Math.min(after + 1, tr.doc.content.size)) !== ' ') {
      tr.insertText(' ', after);
    }
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
  }
  editor.view.dispatch(tr.scrollIntoView());
  if (!editor.view.hasFocus()) editor.view.focus();
  return true;
}

/** The completion plugin: TipTap's Suggestion tracking `[[query`, rendered by `LinkMenu`. */
export function linkMenuPlugin(editor: Editor, services: LinkServices): Plugin {
  let menu: LinkMenu | null = null;
  editor.on('destroy', () => menu?.destroy());
  return Suggestion<LinkOption, LinkOption>({
    pluginKey: linkMenuKey,
    editor,
    floatingUi: MENU_FLOATING_UI,
    char: '[[',
    allowSpaces: true,
    allowedPrefixes: null,
    findSuggestionMatch: findLinkQuery,
    decorationClass: 'pm-link-query',
    allow: ({ state }) => !inCode(state),
    // A remote edit never opens it; a local one (typing, a slash-menu insert) may.
    shouldShow: ({ transaction }) => menu?.isOpen === true || !isBindingTransaction(transaction),
    command: () => undefined,
    render: () => ({
      onStart: (props) => {
        if (!menu) {
          menu = new LinkMenu(editor, services);
          menusByEditor.set(editor, menu);
        }
        menu.open(props);
      },
      onUpdate: (props) => menu?.update(props),
      onKeyDown: ({ event }) => menu?.keydown(event) ?? false,
      onExit: () => menu?.close(),
    }),
  });
}

/** The editor's link menu, for tests. */
export function linkMenuOf(editor: Editor): LinkMenu | null {
  return menusByEditor.get(editor) ?? null;
}
