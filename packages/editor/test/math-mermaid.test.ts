import { parseMarkdown, schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import type { JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';
import { renderMath } from '../src/extensions/math';
import { codeBlock, openEditor, paragraph, press, select, type } from './support/editor';
import { reportVisibleAtOnce, showAll } from './support/intersection';

type Collab = ReturnType<typeof openEditor>;

const markdownOf = (collab: Collab) =>
  serializeMarkdown({ frontmatter: null, doc: coreSchema.nodeFromJSON(collab.editor.getJSON()) });
const blocksOf = (markdown: string) =>
  (parseMarkdown(markdown).doc.toJSON() as JSONContent).content ?? [];

function keydown(target: Element, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );
}

describe('math input rules', () => {
  it('turns $…$ into inline math', () => {
    const collab = openEditor();
    type(collab.editor.view, 'Euler: $e^{i\\pi} + 1 = 0$ done');
    expect(collab.editor.getJSON().content?.[0]?.content?.[1]).toEqual({
      type: 'inlineMath',
      attrs: { latex: 'e^{i\\pi} + 1 = 0' },
    });
    expect(markdownOf(collab)).toBe('Euler: $e^{i\\pi} + 1 = 0$ done\n');
  });

  it('leaves prices and spaced dollars as text', () => {
    const collab = openEditor();
    type(collab.editor.view, 'From $5 to $6, or $ x $.');
    expect(collab.editor.state.doc.firstChild!.childCount).toBe(1);
    expect(markdownOf(collab)).toBe('From \\$5 to \\$6, or \\$ x \\$.\n');
  });

  it('turns $$ plus Enter into a block formula that opens for editing', async () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '$$\n');
    expect(collab.editor.getJSON().content?.[0]).toEqual({
      type: 'blockMath',
      attrs: { latex: '' },
    });
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    const field = await vi.waitFor(() => {
      const found = view.dom.querySelector<HTMLTextAreaElement>('textarea.pm-math-field');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(field.getAttribute('aria-label')).toBe('Formula (LaTeX)');
    field.value = '\\int_0^1 x^2 \\, dx = \\frac{1}{3}';
    field.dispatchEvent(new Event('input'));
    keydown(field, 'Enter', { ctrlKey: true });
    expect(markdownOf(collab)).toBe('$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n');
    expect(view.dom.querySelector('textarea')).toBeNull();
  });
});

describe('math rendering', () => {
  it('renders inline and block formulas with KaTeX', async () => {
    const collab = openEditor(
      blocksOf('Inline $a^2 + b^2$ here.\n\n$$\nc = \\sqrt{a^2 + b^2}\n$$\n'),
    );
    const dom = collab.editor.view.dom;
    await vi.waitFor(() => expect(dom.querySelectorAll('[data-state="rendered"]')).toHaveLength(2));
    expect(dom.querySelector('.pm-math-inline .katex')).not.toBeNull();
    expect(dom.querySelector('.pm-math-block .katex-display')).not.toBeNull();
  });

  it('shows the source and an error for invalid LaTeX, never an empty box', async () => {
    const invalid = await renderMath('\\frac{1', false);
    expect('error' in invalid && invalid.error).toMatch(/^KaTeX parse error/);
    const collab = openEditor(blocksOf('Bad $\\frac{1$ and\n\n$$\n\\begin{matrix}\n$$\n'));
    const dom = collab.editor.view.dom;
    await vi.waitFor(() => expect(dom.querySelectorAll('[data-state="error"]')).toHaveLength(2));
    const [inline, block] = dom.querySelectorAll('.pm-math');
    expect(inline!.querySelector('.pm-math-source')!.textContent).toBe('$\\frac{1$');
    expect(inline!.querySelector('.pm-math-error')!.textContent).toMatch(/KaTeX parse error/);
    expect(block!.querySelector('.pm-math-source')!.textContent).toBe('$$\n\\begin{matrix}\n$$');
  });

  it('edits an inline formula on click, saving on Enter and keeping it on Escape', async () => {
    const collab = openEditor(blocksOf('Area $\\pi r^2$.\n'));
    const { view } = collab.editor;
    const math = view.dom.querySelector<HTMLElement>('.pm-math-inline')!;
    await vi.waitFor(() => expect(math.querySelector('[data-state="rendered"]')).not.toBeNull());
    math.querySelector<HTMLElement>('.pm-math-output')!.click();
    const field = math.querySelector<HTMLInputElement>('input.pm-math-field')!;
    expect(field.value).toBe('\\pi r^2');
    field.value = '2\\pi r';
    keydown(field, 'Enter');
    expect(markdownOf(collab)).toBe('Area $2\\pi r$.\n');

    math.querySelector<HTMLElement>('.pm-math-output')!.click();
    const again = math.querySelector<HTMLInputElement>('input.pm-math-field')!;
    again.value = 'changed';
    keydown(again, 'Escape');
    expect(markdownOf(collab)).toBe('Area $2\\pi r$.\n');
  });

  it('keeps a new formula on Escape (B4)', async () => {
    const collab = openEditor(blocksOf('$$\n$$\n'));
    const math = collab.editor.view.dom.querySelector<HTMLElement>('.pm-math')!;
    await vi.waitFor(() => expect(math.querySelector('[data-state="empty"]')).not.toBeNull());
    math.querySelector<HTMLElement>('.pm-math-output')!.click();
    const field = math.querySelector<HTMLTextAreaElement>('textarea.pm-math-field')!;
    field.value = 'e^{i\\pi}+1=0';
    keydown(field, 'Escape');
    expect(markdownOf(collab)).toBe('$$\ne^{i\\pi}+1=0\n$$\n');
  });

  it('opens a selected formula with Enter', () => {
    const collab = openEditor(blocksOf('Area $\\pi r^2$.\n'));
    const { view } = collab.editor;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 6)));
    expect(press(view, 'Enter')).toBe(true);
    expect(view.dom.querySelector('input.pm-math-field')).not.toBeNull();
  });

  it('renders without writing to the document', async () => {
    const source = openEditor(blocksOf('$x$\n\n$$\ny\n$$\n'));
    const target = openEditor();
    const writes: Uint8Array[] = [];
    target.replica.onUpdate((update, origin) => {
      if (origin !== 'remote') writes.push(update);
    });
    target.replica.applyUpdate(source.replica.encodeStateAsUpdate(), 'remote');
    await vi.waitFor(() =>
      expect(target.editor.view.dom.querySelectorAll('[data-state="rendered"]')).toHaveLength(2),
    );
    expect(writes).toEqual([]);
  });
});

describe('mermaid blocks', () => {
  it('adds a diagram with an edit/preview toggle to mermaid code blocks only', () => {
    const collab = openEditor([codeBlock('graph TD\n  A --> B', 'mermaid'), codeBlock('x', 'ts')]);
    const [diagram, plain] = collab.editor.view.dom.querySelectorAll<HTMLElement>('.pm-code-block');
    expect(diagram!.dataset['mode']).toBe('preview');
    expect(diagram!.querySelector('.pm-diagram')).not.toBeNull();
    const toggle = diagram!.querySelector<HTMLButtonElement>('button.pm-diagram-toggle')!;
    expect(toggle.getAttribute('aria-label')).toBe('Edit Diagram');
    toggle.click();
    expect(diagram!.dataset['mode']).toBe('edit');
    expect(toggle.getAttribute('aria-label')).toBe('Preview Diagram');
    expect(plain!.querySelector('.pm-diagram')).toBeNull();
  });

  it('starts an empty diagram in edit mode, and switches views when the language changes', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '```mermaid\n');
    const block = () => view.dom.querySelector<HTMLElement>('.pm-code-block')!;
    expect(block().dataset['mode']).toBe('edit');
    expect(block().dataset['diagram']).toBe('empty');
    const picker = block().querySelector('select')!;
    picker.value = 'ts';
    picker.dispatchEvent(new Event('change'));
    expect(block().querySelector('.pm-diagram')).toBeNull();
  });

  it('shows the source and Mermaid’s message for an invalid diagram', async () => {
    const collab = openEditor([codeBlock('graph TD\n  A -->', 'mermaid'), paragraph('after')]);
    const block = collab.editor.view.dom.querySelector<HTMLElement>('.pm-code-block')!;
    await vi.waitFor(() => expect(block.dataset['diagram']).toBe('error'), { timeout: 10_000 });
    expect(block.querySelector('.pm-diagram-error')!.textContent).toMatch(/^Mermaid: /);
    expect(block.querySelector('code')!.textContent).toBe('graph TD\n  A -->');
    // The block still serialises as a fenced mermaid block.
    expect(markdownOf(collab)).toBe('```mermaid\ngraph TD\n  A -->\n```\n\nafter\n');
    select(collab.editor.view, 2);
  });
});

describe('the formula field with peers', () => {
  /** Two editors on one note, each sending its own changes to the other. */
  function pair(markdown: string): [Collab, Collab] {
    const a = openEditor(blocksOf(markdown));
    const b = openEditor();
    b.replica.applyUpdate(a.replica.encodeStateAsUpdate(), 'remote');
    a.replica.onUpdate((update, origin) => {
      if (origin !== 'remote') b.replica.applyUpdate(update, 'remote');
    });
    b.replica.onUpdate((update, origin) => {
      if (origin !== 'remote') a.replica.applyUpdate(update, 'remote');
    });
    return [a, b];
  }

  function formulaPos(collab: Collab): number {
    let found = -1;
    collab.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'inlineMath' && found === -1) found = pos;
      return found === -1;
    });
    return found;
  }

  function openField(collab: Collab): HTMLInputElement {
    collab.editor.view.dom.querySelector<HTMLElement>('.pm-math-inline .pm-math-output')!.click();
    return collab.editor.view.dom.querySelector<HTMLInputElement>('input.pm-math-field')!;
  }

  function peerSets(peer: Collab, latex: string) {
    const { view } = peer.editor;
    view.dispatch(view.state.tr.setNodeAttribute(formulaPos(peer), 'latex', latex));
  }

  it('keeps a peer’s edit when the local field closes unchanged', () => {
    const [a, b] = pair('Area $x$.\n');
    const field = openField(a);
    peerSets(b, 'y');
    field.dispatchEvent(new FocusEvent('blur'));
    expect(markdownOf(a)).toBe('Area $y$.\n');
    expect(markdownOf(b)).toBe('Area $y$.\n');
  });

  it('saves a local edit when no peer changed the formula', () => {
    const [a, b] = pair('Area $x$.\n');
    const field = openField(a);
    field.value = 'z';
    field.dispatchEvent(new FocusEvent('blur'));
    expect(markdownOf(b)).toBe('Area $z$.\n');
  });

  it('keeps the peer’s version when both changed, and offers the local one', () => {
    const [a, b] = pair('Area $x$.\n');
    const field = openField(a);
    field.value = 'mine';
    peerSets(b, 'theirs');
    field.dispatchEvent(new FocusEvent('blur'));
    expect(markdownOf(b)).toBe('Area $theirs$.\n');
    const notice = a.editor.view.dom.querySelector<HTMLElement>('.pm-math-conflict')!;
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('mine');
    notice.querySelector<HTMLButtonElement>('button[data-choice="mine"]')!.click();
    expect(markdownOf(b)).toBe('Area $mine$.\n');
    expect(a.editor.view.dom.querySelector('.pm-math-conflict')).toBeNull();
  });

  it('keeps the field open while a peer edits elsewhere in the paragraph', () => {
    const [a, b] = pair('Area $x$.\n');
    const field = openField(a);
    field.value = 'w';
    b.editor.view.dispatch(b.editor.state.tr.insertText('Big ', 1));
    expect(field.isConnected).toBe(true);
    keydown(field, 'Enter');
    expect(markdownOf(b)).toBe('Big Area $w$.\n');
  });

  it('saves typed LaTeX when the editor closes (switching notes)', () => {
    const [a, b] = pair('Area $x$.\n');
    const field = openField(a);
    field.value = 'v';
    a.destroy();
    expect(markdownOf(b)).toBe('Area $v$.\n');
  });

  it('puts the formula back with the typed LaTeX when a peer deletes it mid-edit', async () => {
    const [a, b] = pair('Area $x$ here.\n');
    const field = openField(a);
    field.value = 'kept';
    const pos = formulaPos(b);
    b.editor.view.dispatch(b.editor.state.tr.delete(pos, pos + 1));
    await vi.waitFor(() => expect(markdownOf(b)).toBe('Area $kept$ here.\n'));
  });

  it('lets a peer delete a formula whose field is open but unchanged', async () => {
    const [a, b] = pair('Area $x$ here.\n');
    openField(a);
    const pos = formulaPos(b);
    b.editor.view.dispatch(b.editor.state.tr.delete(pos, pos + 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(markdownOf(a)).toBe('Area  here.\n');
  });
});

describe('diagrams off screen', () => {
  it('draws a diagram only once it is near the viewport', async () => {
    reportVisibleAtOnce(false);
    try {
      const collab = openEditor([
        codeBlock('graph TD\n  A -->', 'mermaid'),
        paragraph('between'),
        codeBlock('graph TD\n  B -->', 'mermaid'),
      ]);
      const [first, second] =
        collab.editor.view.dom.querySelectorAll<HTMLElement>('.pm-code-block');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(first!.dataset['diagram']).toBe('pending');
      expect(second!.dataset['diagram']).toBe('pending');
      showAll();
      await vi.waitFor(() => expect(first!.dataset['diagram']).toBe('error'), { timeout: 10_000 });
      await vi.waitFor(() => expect(second!.dataset['diagram']).toBe('error'), { timeout: 10_000 });
    } finally {
      reportVisibleAtOnce(true);
    }
  });
});

describe('untrusted diagram and formula input', () => {
  it('never follows a link inside a drawn diagram', () => {
    const collab = openEditor([codeBlock('graph TD\n  A --> B', 'mermaid')]);
    const output = collab.editor.view.dom.querySelector<HTMLElement>('.pm-diagram-output')!;
    const link = document.createElement('a');
    link.setAttribute('href', 'https://example.com/');
    output.append(link);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it('caps the size of a formula', async () => {
    const result = await renderMath('\\rule{100000em}{1em}', false);
    expect('html' in result && result.html).toMatch(/width:\s*20em/);
  });
});
