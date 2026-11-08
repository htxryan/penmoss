/**
 * Obsidian callouts and toggles (T11). A callout is core's `callout` node
 * (`> [!type] Title`); a toggle is a foldable callout (`> [!type]-` starts
 * folded, `> [!type]+` open). Whether a toggle is open while editing is
 * per-device UI state kept in a `FoldState` (the app backs it with
 * localStorage), never in the document: opening a toggle writes nothing to
 * the note (ADR 0002).
 */
import { InputRule, mergeAttributes, Node as TipTapNode } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView, NodeView, ViewMutationRecord } from '@tiptap/pm/view';
import { REVEAL_EVENT } from './hidden-content';

/** Per-device open/closed state of toggles, keyed by `calloutKey`. */
export interface FoldState {
  /** Whether the toggle was left open or closed on this device; undefined when never toggled. */
  isOpen(key: string): boolean | undefined;
  setOpen(key: string, open: boolean): void;
}

/** A fold state that lasts as long as the page (the default, and for tests). */
export function memoryFoldState(): FoldState {
  const open = new Map<string, boolean>();
  return { isOpen: (key) => open.get(key), setOpen: (key, value) => void open.set(key, value) };
}

/** Obsidian's callout types, in the picker's order; other types keep their name and the note style. */
export const CALLOUT_TYPES = [
  'note',
  'abstract',
  'info',
  'todo',
  'tip',
  'success',
  'question',
  'warning',
  'failure',
  'danger',
  'bug',
  'example',
  'quote',
] as const;

/** Obsidian's aliases, mapped to the type whose style they share. */
const ALIASES: Record<string, (typeof CALLOUT_TYPES)[number]> = {
  summary: 'abstract',
  tldr: 'abstract',
  hint: 'tip',
  important: 'tip',
  check: 'success',
  done: 'success',
  help: 'question',
  faq: 'question',
  caution: 'warning',
  attention: 'warning',
  fail: 'failure',
  missing: 'failure',
  error: 'danger',
  cite: 'quote',
};

/** The style a callout type uses (`faq` looks like `question`; unknown types look like `note`). */
export function calloutStyle(type: string): string {
  const lower = type.toLowerCase();
  if ((CALLOUT_TYPES as readonly string[]).includes(lower)) return lower;
  return ALIASES[lower] ?? 'note';
}

const label = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);

/**
 * A key for a toggle that survives reloads without a block ID (D2): its type,
 * title and how many callouts with the same type and title come before it.
 */
export function calloutKey(doc: PMNode, pos: number, node: PMNode): string {
  const type = node.attrs['type'] as string;
  const title = node.attrs['title'] as string;
  let index = 0;
  doc.nodesBetween(0, pos, (other, otherPos) => {
    if (otherPos >= pos) return false;
    if (
      other.type === node.type &&
      other.attrs['type'] === type &&
      other.attrs['title'] === title
    ) {
      index += 1;
    }
    return true;
  });
  return `${type}|${title}|${index}`;
}

/**
 * The callout's DOM: a header (fold button for toggles, type picker, title
 * field) above the body. Rendering writes nothing; the picker and the title
 * field change the node's attributes when the user edits them.
 */
export class CalloutView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly fold: HTMLButtonElement;
  private readonly select: HTMLSelectElement;
  private readonly title: HTMLInputElement;
  private open: boolean;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly folds: FoldState,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'pm-callout';

    const header = document.createElement('div');
    header.className = 'pm-callout-header';
    header.contentEditable = 'false';

    this.fold = document.createElement('button');
    this.fold.type = 'button';
    this.fold.className = 'pm-callout-fold';
    this.fold.addEventListener('mousedown', (event) => event.preventDefault());
    this.fold.addEventListener('click', () => this.toggle());

    const icon = document.createElement('span');
    icon.className = 'pm-callout-icon';
    icon.setAttribute('aria-hidden', 'true');

    this.select = document.createElement('select');
    // The shared select's small, quiet look (T51 item 13, A941; styles.css `.pm-select`).
    this.select.className = 'pm-callout-type pm-select pm-select-sm pm-select-quiet';
    this.select.setAttribute('aria-label', 'Callout type');
    for (const type of CALLOUT_TYPES) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = label(type);
      this.select.append(option);
    }
    this.select.addEventListener('change', () => this.setAttr('type', this.select.value));

    this.title = document.createElement('input');
    this.title.type = 'text';
    this.title.className = 'pm-callout-title';
    this.title.setAttribute('aria-label', 'Callout title');
    this.title.addEventListener('change', () => this.setAttr('title', this.title.value));
    this.title.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      this.setAttr('title', this.title.value);
      this.focusBody();
    });

    header.append(this.fold, icon, this.select, this.title);
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'pm-callout-body';
    this.dom.append(header, this.contentDOM);
    // The caret is going into a folded body: open it (device state, like the fold button).
    this.dom.addEventListener(REVEAL_EVENT, () => {
      if (this.foldable && !this.open) this.toggle();
    });

    const pos = getPos();
    const { from } = view.state.selection;
    // A toggle being typed into (just created by `> [!note]- `) starts open. Only
    // toggles need their key (a walk of the document before them), so other
    // callouts never compute it.
    const editing = pos !== undefined && from > pos && from < pos + node.nodeSize;
    this.open =
      editing ||
      !this.foldable ||
      ((pos === undefined ? undefined : this.folds.isOpen(calloutKey(view.state.doc, pos, node))) ??
        !node.attrs['collapsed']);
    this.render();
  }

  private get foldable(): boolean {
    return this.node.attrs['foldable'] as boolean;
  }

  private render() {
    const type = this.node.attrs['type'] as string;
    const title = this.node.attrs['title'] as string;
    this.dom.dataset['calloutType'] = calloutStyle(type);
    this.dom.dataset['foldable'] = String(this.foldable);
    this.dom.dataset['open'] = String(!this.foldable || this.open);
    if (![...this.select.options].some((option) => option.value === type)) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = label(type);
      this.select.append(option);
    }
    this.select.value = type;
    if (document.activeElement !== this.title) this.title.value = title;
    this.title.placeholder = label(type);
    this.fold.hidden = !this.foldable;
    this.fold.setAttribute('aria-expanded', String(this.open));
    this.fold.setAttribute('aria-label', this.open ? 'Collapse Toggle' : 'Expand Toggle');
  }

  private toggle() {
    const pos = this.getPos();
    this.open = !this.open;
    if (pos !== undefined)
      this.folds.setOpen(calloutKey(this.view.state.doc, pos, this.node), this.open);
    this.render();
  }

  private setAttr(name: 'type' | 'title', value: string) {
    const pos = this.getPos();
    if (pos === undefined || this.node.attrs[name] === value) return;
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, name, value));
  }

  private focusBody() {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.focus();
    const { tr } = this.view.state;
    this.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))));
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    const target = event.target;
    return target instanceof Node && !this.contentDOM.contains(target) && this.dom.contains(target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false;
    return !this.contentDOM.contains(mutation.target);
  }
}

export interface CalloutOptions {
  foldState: FoldState;
}

/** `[!type] `, `[!type]- ` or `[!type]+ ` typed at the start of a quote. */
const CALLOUT_MARKER = /^\[!([A-Za-z][\w-]*)\]([+-]?)\s$/;

export const Callout = TipTapNode.create<CalloutOptions>({
  name: 'callout',

  addOptions() {
    return { foldState: memoryFoldState() };
  },

  addAttributes() {
    return {
      type: {
        parseHTML: (element) => element.getAttribute('data-callout') ?? 'note',
        renderHTML: (attrs) => ({ 'data-callout': attrs['type'] as string }),
      },
      title: {
        parseHTML: (element) => element.getAttribute('data-callout-title') ?? '',
        renderHTML: (attrs) => ({ 'data-callout-title': attrs['title'] as string }),
      },
      foldable: {
        parseHTML: (element) => element.hasAttribute('data-callout-fold'),
        renderHTML: (attrs) =>
          attrs['foldable'] ? { 'data-callout-fold': attrs['collapsed'] ? '-' : '+' } : {},
      },
      collapsed: {
        parseHTML: (element) => element.getAttribute('data-callout-fold') === '-',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes), 0];
  },

  addNodeView() {
    return ({ node, view, getPos }) => new CalloutView(node, view, getPos, this.options.foldState);
  },

  addInputRules() {
    return [
      new InputRule({
        find: CALLOUT_MARKER,
        handler: ({ state, range, match }) => {
          const { $from } = state.selection;
          const depth = $from.depth;
          if (depth < 2 || $from.parent.type.name !== 'paragraph') return null;
          const quote = $from.node(depth - 1);
          if (quote.type.name !== 'blockquote' || $from.index(depth - 1) !== 0) return null;
          const fold = match[2] ?? '';
          const tr = state.tr;
          tr.delete(range.from, range.to);
          tr.setNodeMarkup($from.before(depth - 1), this.type, {
            type: (match[1] ?? 'note').toLowerCase(),
            title: '',
            foldable: fold !== '',
            collapsed: fold === '-',
          });
          return undefined;
        },
      }),
    ];
  },
});
