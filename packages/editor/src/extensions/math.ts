/**
 * Inline `$…$` and block `$$…$$` math (T12), rendered with KaTeX. KaTeX and
 * its stylesheet load the first time a note shows a formula, so notes
 * without math never fetch them. Invalid LaTeX shows its source and KaTeX's
 * message, never an empty box. The model is core's `inlineMath` and
 * `blockMath` atoms (`latex`, ADR 0002); the views only write `latex` when
 * the user edits a formula.
 *
 * The field edits a copy, so a peer may change or delete the formula while it
 * is open. The LaTeX it opened with decides what closing it means: unchanged
 * writes nothing (a peer's edit stands); changed when no peer changed it
 * writes; changed on both sides keeps the peer's version and offers ours.
 * Typed LaTeX is never dropped: closing the editor (switching notes) saves
 * it, and a formula a peer deleted mid-edit comes back with it.
 */
import { type Editor, InputRule, Node as TipTapNode } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';

type Katex = (typeof import('katex'))['default'];

let katex: Promise<Katex> | null = null;

/** KaTeX and its stylesheet (fonts are files next to it, loaded by the browser as needed). */
export function loadKatex(): Promise<Katex> {
  katex ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
    ([module]) => module.default,
  );
  // A failed chunk load (offline before it was cached) may be retried by the next formula.
  katex.catch(() => (katex = null));
  return katex;
}

export type MathRender = { html: string } | { error: string };

/** Renders `latex`, or explains why it cannot be rendered. */
export async function renderMath(latex: string, display: boolean): Promise<MathRender> {
  const instance = await loadKatex();
  try {
    return {
      html: instance.renderToString(latex, {
        displayMode: display,
        throwOnError: true,
        // Unicode text and other non-strict input render; they are not worth a console warning.
        strict: 'ignore',
        trust: false,
        // Bounds for untrusted input: no rule or space wider than 20em, and macros
        // cannot expand without end.
        maxSize: 20,
        maxExpand: 1000,
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The DOM event that opens a formula's editor (Enter on a selected formula). */
const EDIT_EVENT = 'pm-math-edit';

/** Where the formula whose field is open is, followed through every change, and whether it was deleted. */
interface OpenFormula {
  readonly pos: number;
  readonly deleted: boolean;
}

const openFormulaKey = new PluginKey<OpenFormula | null>('mathOpenFormula');

/** Tracks the open formula field's node (view state: the meta never changes the document). */
function openFormulaTracker(): Plugin<OpenFormula | null> {
  return new Plugin<OpenFormula | null>({
    key: openFormulaKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(openFormulaKey) as { open: number } | { close: true } | undefined;
        if (meta) return 'open' in meta ? { pos: meta.open, deleted: false } : null;
        if (!value || !tr.docChanged) return value;
        const result = tr.mapping.mapResult(value.pos, 1);
        return { pos: result.pos, deleted: value.deleted || result.deletedAfter };
      },
    },
  });
}

/**
 * A formula: the rendering, or its source and an error; clicking it (or
 * Enter while it is selected) opens a field to edit the LaTeX. A block
 * formula previews while it is edited.
 */
export class MathView implements NodeView {
  readonly dom: HTMLElement;
  private readonly output: HTMLElement;
  private readonly preview: HTMLElement | null;
  private field: HTMLInputElement | HTMLTextAreaElement | null = null;
  /** The LaTeX the field opened with. */
  private opened = '';
  private conflict: HTMLElement | null = null;
  private renders = 0;
  private destroyed = false;
  /** Closing the editor (switching notes) saves an open field first, while the view still works. */
  private readonly onEditorDestroy = () => this.close(true, false);

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly display: boolean,
    private readonly editor?: Editor,
  ) {
    this.dom = document.createElement(display ? 'div' : 'span');
    this.dom.className = display ? 'pm-math pm-math-block' : 'pm-math pm-math-inline';
    this.output = document.createElement(display ? 'div' : 'span');
    this.output.className = 'pm-math-output';
    this.dom.append(this.output);
    this.preview = display ? document.createElement('div') : null;
    this.dom.addEventListener('click', (event) => {
      if (this.field || !(event.target instanceof Node) || !this.output.contains(event.target))
        return;
      event.preventDefault();
      this.edit();
    });
    this.dom.addEventListener(EDIT_EVENT, () => this.edit());
    editor?.on('destroy', this.onEditorDestroy);
    void this.render();
    // A block formula just made with `$$` + Enter is empty and selected: edit it at once.
    const pos = getPos();
    const { selection } = view.state;
    if (
      display &&
      !this.latex &&
      selection instanceof NodeSelection &&
      pos !== undefined &&
      selection.from === pos
    ) {
      queueMicrotask(() => this.edit());
    }
  }

  private get latex(): string {
    return this.node.attrs['latex'] as string;
  }

  /** Shows the rendering (or the source and an error) of `latex` in `target`. */
  private async show(target: HTMLElement, latex: string) {
    const ticket = ++this.renders;
    target.dataset['state'] = 'loading';
    if (!latex.trim()) {
      target.dataset['state'] = 'empty';
      target.textContent = this.display ? 'Empty formula: click to edit' : 'Empty formula';
      return;
    }
    if (!target.firstChild) target.textContent = latex;
    let result: MathRender;
    try {
      result = await renderMath(latex, this.display);
    } catch (error) {
      result = { error: `Could not load the math renderer (${String(error)})` };
    }
    if (this.destroyed || ticket !== this.renders) return;
    target.replaceChildren();
    if ('html' in result) {
      target.dataset['state'] = 'rendered';
      target.innerHTML = result.html;
      return;
    }
    target.dataset['state'] = 'error';
    const source = document.createElement('code');
    source.className = 'pm-math-source';
    source.textContent = this.display ? `$$\n${latex}\n$$` : `$${latex}$`;
    const message = document.createElement(this.display ? 'div' : 'span');
    message.className = 'pm-math-error';
    message.setAttribute('role', 'status');
    message.textContent = result.error;
    target.append(source, message);
  }

  private render() {
    return this.show(this.output, this.latex);
  }

  /** Opens the LaTeX field. */
  edit(): void {
    if (this.field || !this.view.editable) return;
    this.dismissConflict();
    this.opened = this.latex;
    const pos = this.getPos();
    if (pos !== undefined)
      this.view.dispatch(this.view.state.tr.setMeta(openFormulaKey, { open: pos }));
    const field = this.display
      ? document.createElement('textarea')
      : document.createElement('input');
    field.className = 'pm-math-field';
    field.value = this.latex;
    field.spellcheck = false;
    field.setAttribute('aria-label', this.display ? 'Formula (LaTeX)' : 'Inline formula (LaTeX)');
    if (field instanceof HTMLTextAreaElement)
      field.rows = Math.max(2, this.latex.split('\n').length);
    const keys: HTMLElement = field;
    keys.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      const commit = this.display
        ? event.key === 'Enter' && (event.metaKey || event.ctrlKey)
        : event.key === 'Enter';
      if (commit || event.key === 'Escape') {
        event.preventDefault();
        // Escape cancels a change to a formula, but keeps a new one: a formula
        // typed into an empty block is never thrown away (B4).
        this.close(event.key !== 'Escape' || this.opened === '', true);
      }
    });
    // Clicking elsewhere saves the formula and leaves the caret where the click put it.
    field.addEventListener('blur', () => this.close(true, false));
    if (this.preview) {
      this.preview.className = 'pm-math-preview';
      field.addEventListener('input', () => void this.show(this.preview!, field.value));
      void this.show(this.preview, field.value);
    }
    this.field = field;
    this.dom.classList.add('is-editing');
    this.output.hidden = true;
    this.dom.append(field, ...(this.preview ? [this.preview] : []));
    field.focus();
  }

  /** Closes the field, saving its LaTeX (`save`) or not; `returnCaret` puts the caret after the formula. */
  private close(save: boolean, returnCaret: boolean) {
    const field = this.field;
    if (!field) return;
    this.field = null;
    field.remove();
    this.preview?.remove();
    this.dom.classList.remove('is-editing');
    this.output.hidden = false;
    const pos = this.getPos();
    if (pos === undefined || this.destroyed) return;
    const latex = field.value;
    const tr = this.view.state.tr.setMeta(openFormulaKey, { close: true });
    if (save && latex !== this.opened) {
      // A peer changed the formula meanwhile: theirs stands, ours is offered.
      if (this.latex === this.opened) tr.setNodeAttribute(pos, 'latex', latex);
      else this.offer(latex);
    }
    if (returnCaret) tr.setSelection(TextSelection.near(tr.doc.resolve(pos + this.node.nodeSize)));
    this.view.dispatch(tr);
    if (returnCaret) this.view.focus();
  }

  /** Tells the user a peer changed the formula while they edited it, offering their own version. */
  private offer(mine: string) {
    this.dismissConflict();
    const notice = document.createElement(this.display ? 'div' : 'span');
    notice.className = 'pm-math-conflict';
    notice.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = 'Changed elsewhere while you edited. Yours: ';
    const code = document.createElement('code');
    code.textContent = mine;
    const button = (label: string, choice: 'mine' | 'theirs') => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.dataset['choice'] = choice;
      element.addEventListener('click', (event) => {
        event.preventDefault();
        this.dismissConflict();
        const pos = this.getPos();
        if (choice === 'mine' && pos !== undefined && !this.destroyed)
          this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, 'latex', mine));
      });
      return element;
    };
    notice.append(text, code, button('Use Mine', 'mine'), button('Keep Theirs', 'theirs'));
    this.conflict = notice;
    this.dom.append(notice);
  }

  private dismissConflict() {
    this.conflict?.remove();
    this.conflict = null;
  }

  /**
   * The node went away with the field open (a peer deleted it, or the
   * paragraph was rebuilt). Typed LaTeX is put back where the node was.
   */
  private rescue(latex: string) {
    const { view, opened } = this;
    const type = this.node.type;
    queueMicrotask(() => {
      if (view.isDestroyed) return;
      const tracked = openFormulaKey.getState(view.state);
      if (!tracked) return;
      const tr = view.state.tr.setMeta(openFormulaKey, { close: true });
      const node = tr.doc.nodeAt(tracked.pos);
      // A rebuilt paragraph has the formula again, unchanged; a deleted one gets it back.
      if (node?.type === type && node.attrs['latex'] === opened)
        tr.setNodeAttribute(tracked.pos, 'latex', latex);
      else if (tracked.deleted)
        tr.insert(Math.min(tracked.pos, tr.doc.content.size), type.create({ latex }));
      view.dispatch(tr);
    });
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs['latex'] !== this.latex;
    this.node = node;
    if (changed) void this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  stopEvent(event: Event): boolean {
    if (!(event.target instanceof Node)) return false;
    return Boolean(this.field?.contains(event.target) || this.conflict?.contains(event.target));
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.editor?.off('destroy', this.onEditorDestroy);
    const field = this.field;
    this.field = null;
    if (field && field.value !== this.opened) this.rescue(field.value);
  }
}

/** `$x^2$`: a dollar, LaTeX that neither starts nor ends with a space, a closing dollar. */
const INLINE_MATH = /(?:^|[^$\\])(\$([^$\s](?:[^$]*[^$\s\\])?)\$)$/;
/** `$$` alone in a paragraph, then Enter or space. */
const BLOCK_MATH = /^\$\$\s$/;

/** Opens the LaTeX field of the formula at `pos` (after inserting one from the slash menu). */
export function editFormulaAt(view: EditorView, pos: number): void {
  view.nodeDOM(pos)?.dispatchEvent(new CustomEvent(EDIT_EVENT));
}

/** Enter on a selected formula opens its editor. */
function editSelectedFormula(view: EditorView): boolean {
  const { selection } = view.state;
  if (!(selection instanceof NodeSelection)) return false;
  const name = selection.node.type.name;
  if (name !== 'inlineMath' && name !== 'blockMath') return false;
  view.nodeDOM(selection.from)?.dispatchEvent(new CustomEvent(EDIT_EVENT));
  return true;
}

export const InlineMath = TipTapNode.create({
  name: 'inlineMath',

  addAttributes() {
    return {
      latex: {
        parseHTML: (element) => element.getAttribute('data-latex') ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs['latex'] as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="inline-math"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'span',
      { 'data-type': 'inline-math', ...HTMLAttributes },
      `$${node.attrs['latex'] as string}$`,
    ];
  },

  addNodeView() {
    return ({ node, view, getPos, editor }) => new MathView(node, view, getPos, false, editor);
  },

  addKeyboardShortcuts() {
    return { Enter: () => editSelectedFormula(this.editor.view) };
  },

  addProseMirrorPlugins() {
    return [openFormulaTracker()];
  },

  addInputRules() {
    return [
      new InputRule({
        find: INLINE_MATH,
        handler: ({ state, range, match }) => {
          const [whole, formula, latex] = match;
          if (!whole || !formula || !latex) return null;
          // The typed closing `$` is not in the document yet; `range` covers the rest.
          const start = range.from + whole.length - formula.length;
          state.tr.replaceWith(start, range.to, this.type.create({ latex }));
          return undefined;
        },
      }),
    ];
  },
});

export const BlockMath = TipTapNode.create({
  name: 'blockMath',

  addAttributes() {
    return {
      latex: {
        parseHTML: (element) => element.getAttribute('data-latex') ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs['latex'] as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="block-math"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      { 'data-type': 'block-math', ...HTMLAttributes },
      `$$${node.attrs['latex'] as string}$$`,
    ];
  },

  addNodeView() {
    return ({ node, view, getPos, editor }) => new MathView(node, view, getPos, true, editor);
  },

  addInputRules() {
    return [
      new InputRule({
        find: BLOCK_MATH,
        handler: ({ state }) => {
          const { $from } = state.selection;
          if ($from.parent.type.name !== 'paragraph' || $from.parent.textContent !== '$$')
            return null;
          const start = $from.before();
          const tr = state.tr;
          tr.replaceWith(start, $from.after(), this.type.create({ latex: '' }));
          tr.setSelection(NodeSelection.create(tr.doc, start));
          return undefined;
        },
      }),
    ];
  },
});
