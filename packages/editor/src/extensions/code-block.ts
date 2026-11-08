/**
 * Code blocks (T9): fenced code with a language picker, a copy button,
 * Tab/Shift-Tab indenting and lazily loaded highlighting (code-highlight.ts).
 * The model is core's `codeBlock` (`language`, `meta`); `noteExtensions()`
 * aligns it with core (A9).
 */
import { Extension, textblockTypeInputRule } from '@tiptap/core';
import { CodeBlock } from '@tiptap/extension-code-block';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type Command, type EditorState } from '@tiptap/pm/state';
import type { EditorView, NodeView, ViewMutationRecord } from '@tiptap/pm/view';
import { codeBlockKey } from '../block-keys';
import { copyText } from '../clipboard/copy';
import { codeHighlightPlugin } from './code-highlight';
import { CODE_LANGUAGES, resolveLanguage } from './highlight';
import { REVEAL_EVENT } from './hidden-content';
import { MermaidPreview, isMermaid } from './mermaid';

/** One indent step inside code. */
export const CODE_INDENT = '  ';

/** ``` or ~~~, an optional language (`c++`, `objective-c`, `c#` included), then space or Enter. */
const BACKTICK_FENCE = /^```([\w+#.-]*)[\s\n]$/;
const TILDE_FENCE = /^~~~([\w+#.-]*)[\s\n]$/;

/** Line start offsets (within the block's text) of the lines a selection touches. */
function touchedLineStarts(text: string, from: number, to: number): number[] {
  const starts = [text.lastIndexOf('\n', from - 1) + 1];
  for (
    let at = text.indexOf('\n', starts[0]);
    at !== -1 && at < to;
    at = text.indexOf('\n', at + 1)
  ) {
    // A selection that ends at the very start of a line does not take that line along.
    if (at + 1 < to || from === to) starts.push(at + 1);
  }
  return starts;
}

/**
 * Tab and Shift-Tab inside a code block. Tab with a caret inserts an indent;
 * with a selection it indents every touched line. Shift-Tab removes up to one
 * indent (or one tab character) from every touched line.
 */
export function indentCode(direction: 'in' | 'out'): Command {
  return (state: EditorState, dispatch) => {
    const { $from, $to, empty } = state.selection;
    if ($from.parent.type.name !== 'codeBlock' || !$from.sameParent($to)) return false;
    if (!dispatch) return true;
    const start = $from.start();
    if (direction === 'in' && empty) {
      dispatch(state.tr.insertText(CODE_INDENT).scrollIntoView());
      return true;
    }
    const text = $from.parent.textContent;
    const tr = state.tr;
    const lines = touchedLineStarts(text, $from.parentOffset, $to.parentOffset);
    for (const line of lines.reverse()) {
      const pos = start + line;
      if (direction === 'in') {
        tr.insertText(CODE_INDENT, pos);
      } else {
        const lead = /^(?: {1,2}|\t)/.exec(text.slice(line))?.[0].length ?? 0;
        if (lead) tr.delete(pos, pos + lead);
      }
    }
    if (tr.docChanged) dispatch(tr.scrollIntoView());
    return true;
  };
}

const MERMAID = 'mermaid';

function languageOptions(select: HTMLSelectElement) {
  const add = (value: string, label: string) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  };
  add('', 'Plain Text');
  for (const lang of CODE_LANGUAGES) add(lang.fence, lang.label);
  add(MERMAID, 'Mermaid Diagram');
}

/** The picker value for a node's language: a listed language, Mermaid, or the name as written. */
function pickerValue(language: string | null): string {
  if (!language) return '';
  if (language.toLowerCase() === MERMAID) return MERMAID;
  return resolveLanguage(language)?.fence ?? language;
}

/**
 * The code block's DOM: a toolbar (language picker, copy button) above
 * `<pre><code>`, plus the diagram for Mermaid blocks (T12). Rendering never
 * writes to the document; only the picker does, when the user changes it.
 */
export class CodeBlockView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly copy: HTMLButtonElement;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly diagram: MermaidPreview | null;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'pm-code-block';

    const toolbar = document.createElement('div');
    toolbar.className = 'pm-code-toolbar';
    toolbar.contentEditable = 'false';

    this.select = document.createElement('select');
    // The shared select's small, quiet look (T51 item 13, A941; styles.css `.pm-select`).
    this.select.className = 'pm-code-language pm-select pm-select-sm pm-select-quiet';
    this.select.setAttribute('aria-label', 'Code block language');
    languageOptions(this.select);
    this.select.addEventListener('change', () => this.setLanguage(this.select.value || null));

    this.copy = document.createElement('button');
    this.copy.type = 'button';
    this.copy.className = 'pm-code-copy';
    this.copy.textContent = 'Copy';
    this.copy.setAttribute('aria-label', 'Copy Code');
    this.copy.addEventListener('click', () => this.copyCode());

    const actions = document.createElement('div');
    actions.className = 'pm-code-actions';
    actions.append(this.copy);
    toolbar.append(this.select, actions);

    const pre = document.createElement('pre');
    this.contentDOM = document.createElement('code');
    pre.append(this.contentDOM);
    this.dom.append(toolbar, pre);
    // Mermaid loads only when a note has a diagram; a language change rebuilds the view (update()).
    this.diagram = isMermaid(node.attrs['language'])
      ? new MermaidPreview(this.dom, node.textContent, () => this.focusCode())
      : null;
    if (this.diagram) {
      actions.prepend(this.diagram.toggle);
      this.dom.append(this.diagram.element);
      this.dom.addEventListener(REVEAL_EVENT, () => this.diagram?.showSource());
    }
    this.render();
  }

  /** Puts the caret at the end of the code (after switching a diagram to its source). */
  private focusCode() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const end = pos + this.node.nodeSize - 1;
    this.view.dispatch(
      this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, end)),
    );
    this.view.focus();
  }

  private render() {
    const language = this.node.attrs['language'] as string | null;
    const value = pickerValue(language);
    if (value && ![...this.select.options].some((option) => option.value === value)) {
      // A fence name the picker does not list stays selectable (and plain).
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      option.dataset['custom'] = 'true';
      this.select.append(option);
    }
    this.select.value = value;
    const resolved = resolveLanguage(language);
    this.dom.dataset['language'] = language ?? '';
    this.contentDOM.className = resolved ? `hljs language-${resolved.id}` : 'hljs';
  }

  private setLanguage(language: string | null) {
    const pos = this.getPos();
    if (pos === undefined) return;
    const { tr } = this.view.state;
    this.view.dispatch(tr.setNodeAttribute(pos, 'language', language));
    this.view.focus();
  }

  private copyCode() {
    const text = this.node.textContent;
    const done = (label: string) => {
      this.copy.textContent = label;
      if (this.copyTimer !== null) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => (this.copy.textContent = 'Copy'), 1500);
    };
    void copyText(this.dom.ownerDocument, text).then((ok) => done(ok ? 'Copied' : 'Copy failed'));
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    if (isMermaid(node.attrs['language']) !== (this.diagram !== null)) return false;
    this.node = node;
    this.render();
    this.diagram?.setSource(node.textContent);
    return true;
  }

  stopEvent(event: Event): boolean {
    // The toolbar's controls handle their own events.
    return (
      event.target instanceof Node &&
      !this.contentDOM.contains(event.target) &&
      this.dom.contains(event.target)
    );
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false;
    return !this.contentDOM.contains(mutation.target);
  }

  destroy(): void {
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.diagram?.destroy();
  }
}

/**
 * Highlighting as its own extension: TipTap's `extend()` copies a function
 * like `addProseMirrorPlugins` into every extension built on this one (as
 * `alignNode` does), so a plugin added there next to `this.parent()` would be
 * added twice.
 */
export const CodeHighlight = Extension.create({
  name: 'codeHighlight',
  addProseMirrorPlugins: () => [codeHighlightPlugin()],
});

/** TipTap's code block with Penmoss's fences, indenting and view. */
export const PenmossCodeBlock = CodeBlock.extend({
  addKeyboardShortcuts() {
    // TipTap's Mod-Alt-c is AltGr+C off Apple platforms: the toggle takes the platform's key.
    const { 'Mod-Alt-c': toggle, ...inherited } = this.parent?.() ?? {};
    return {
      ...inherited,
      ...(toggle ? { [codeBlockKey()]: toggle } : {}),
      Tab: () => indentCode('in')(this.editor.state, this.editor.view.dispatch),
      'Shift-Tab': () => indentCode('out')(this.editor.state, this.editor.view.dispatch),
    };
  },

  addInputRules() {
    const language = (match: RegExpMatchArray) => ({ language: match[1] || null });
    return [
      textblockTypeInputRule({ find: BACKTICK_FENCE, type: this.type, getAttributes: language }),
      textblockTypeInputRule({ find: TILDE_FENCE, type: this.type, getAttributes: language }),
    ];
  },

  addNodeView() {
    return ({ node, view, getPos }) => new CodeBlockView(node, view, getPos);
  },
});
