import { schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import type { JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';
import { BLOCK_ITEMS, turnInto } from '../src/extensions/block-items';
import { normaliseHref, wantsToolbar } from '../src/extensions/bubble-toolbar';
import { createCollabEditor } from '../src/collab';
import { COMMENT_ADD_EVENT } from '../src/extensions/comments';
import { noteExtensions } from '../src/extensions';
import { codeBlock, openEditor, paragraph, press, select, startOf } from './support/editor';

type Collab = ReturnType<typeof openEditor>;

const markdownOf = (collab: Collab) =>
  serializeMarkdown({ frontmatter: null, doc: coreSchema.nodeFromJSON(collab.editor.getJSON()) });

const toolbar = () =>
  document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Format selection"]');
const control = (name: string) =>
  [...toolbar()!.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === name,
  )!;

/** A focused note holding `text`, with `word` selected, and the toolbar shown. */
async function withSelection(
  text: string,
  word: string,
  content = [paragraph(text)],
  options?: Parameters<typeof openEditor>[1],
) {
  const collab = openEditor(content, options);
  const { view } = collab.editor;
  view.focus();
  const start = startOf(view, 'paragraph') + text.indexOf(word);
  select(view, start, start + word.length);
  await vi.waitFor(() => expect(toolbar()).not.toBeNull());
  return collab;
}

const item = (id: string) => BLOCK_ITEMS.find((entry) => entry.id === id)!;

describe('normaliseHref', () => {
  it('accepts web and mail addresses, adding the scheme when it is missing', () => {
    expect(normaliseHref('https://penmoss.app/x')).toBe('https://penmoss.app/x');
    expect(normaliseHref(' penmoss.app/notes?a=1 ')).toBe('https://penmoss.app/notes?a=1');
    expect(normaliseHref('ryan@example.com')).toBe('mailto:ryan@example.com');
    expect(normaliseHref('mailto:a@b.co')).toBe('mailto:a@b.co');
  });

  it('refuses anything else, including script URLs', () => {
    expect(normaliseHref('javascript:alert(1)')).toBeNull();
    expect(normaliseHref('just words')).toBeNull();
    expect(normaliseHref('')).toBeNull();
  });
});

describe('wantsToolbar', () => {
  it('wants a text selection outside code, and nothing else', () => {
    const collab = openEditor([
      paragraph('hello world'),
      codeBlock('let a'),
      { type: 'blockMath', attrs: { latex: 'x' } },
    ]);
    const { view } = collab.editor;
    select(view, 1);
    expect(wantsToolbar(collab.editor)).toBe(false);
    select(view, 1, 6);
    expect(wantsToolbar(collab.editor)).toBe(true);
    const code = startOf(view, 'codeBlock');
    select(view, code, code + 3);
    expect(wantsToolbar(collab.editor)).toBe(false);
    view.dispatch(
      view.state.tr.setSelection(
        NodeSelection.create(view.state.doc, startOf(view, 'blockMath') - 1),
      ),
    );
    expect(wantsToolbar(collab.editor)).toBe(false);
  });
});

describe('selection toolbar', () => {
  it('shows labelled buttons over a selection, and hides when it collapses', async () => {
    const collab = await withSelection('make this bold', 'this');
    const labels = [...toolbar()!.querySelectorAll('button')]
      .filter((button) => !button.closest('[hidden]'))
      .map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Bold',
      'Italic',
      'Strikethrough',
      'Inline Code',
      'Highlight',
      'Link',
      'Copy As',
      'Turn into (Now Text)',
    ]);
    select(collab.editor.view, 2);
    await vi.waitFor(() => expect(toolbar()).toBeNull());
  });

  it('goes when Comment opens a composer, which floats where it was (T52 item 5)', async () => {
    const collab = await withSelection('the garden plan', 'garden', undefined, { comments: true });
    const asked: string[] = [];
    collab.editor.view.dom.addEventListener(COMMENT_ADD_EVENT, () => asked.push('add'));
    // As a click does: the toolbar's mousedown keeps it from hiding on the editor's blur.
    const button = control('Comment');
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    button.click();
    expect(asked).toEqual(['add']);
    await vi.waitFor(() => expect(toolbar()).toBeNull());
  });

  it('toggles each mark, reporting it as pressed', async () => {
    const collab = await withSelection('a word here', 'word');
    for (const [name, mark] of [
      ['Bold', 'bold'],
      ['Italic', 'italic'],
      ['Strikethrough', 'strike'],
      ['Highlight', 'highlight'],
    ] as const) {
      control(name).click();
      expect(collab.editor.isActive(mark)).toBe(true);
      expect(control(name).getAttribute('aria-pressed')).toBe('true');
    }
    expect(markdownOf(collab)).toBe('a ***~~==word==~~*** here\n');
    control('Bold').click();
    expect(control('Bold').getAttribute('aria-pressed')).toBe('false');
    control('Inline Code').click();
    expect(collab.editor.isActive('code')).toBe(true);
  });

  it('links the selection from the link field, adding https', async () => {
    const collab = await withSelection('see the docs now', 'the docs');
    control('Link').click();
    const input = toolbar()!.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
    expect(document.activeElement).toBe(input);
    input.value = 'penmoss.app/docs';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(markdownOf(collab)).toBe('see [the docs](https://penmoss.app/docs) now\n');
    // The note has focus at once, not a frame later: a key typed straight after Enter
    // (End, say) must reach it rather than the page.
    expect(document.activeElement).toBe(collab.editor.view.dom);
  });

  it('leaves the caret where a key put it straight after the link field closes', async () => {
    const collab = await withSelection('see the docs', 'the docs');
    control('Link').click();
    const input = toolbar()!.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
    input.value = 'penmoss.app';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(collab.editor.view.dom);
    // A key the browser handles itself (End) moves the page's selection before the editor
    // reads it. Focusing the note a frame later (TipTap's focus()) would write the editor's
    // older selection back over it, so nothing may focus it once the field has closed.
    const focus = vi.spyOn(collab.editor.view, 'focus');
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    expect(focus).not.toHaveBeenCalled();
  });

  it('explains an address it cannot use, and removes a link when emptied', async () => {
    const collab = await withSelection('see the docs now', 'docs');
    control('Link').click();
    const input = toolbar()!.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
    input.value = 'not a link';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(toolbar()!.querySelector('[role="alert"]')!.textContent).toMatch(/web address/);
    input.value = 'https://a.example';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(markdownOf(collab)).toBe('see the [docs](https://a.example) now\n');
    const start = startOf(collab.editor.view, 'paragraph') + 'see the '.length;
    select(collab.editor.view, start, start + 4);
    collab.editor.view.focus();
    await vi.waitFor(() => expect(toolbar()).not.toBeNull());
    control('Link').click();
    expect(input.value).toBe('https://a.example');
    input.value = '';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(markdownOf(collab)).toBe('see the docs now\n');
  });

  it('turns the selected block into another kind from its menu', async () => {
    const collab = await withSelection('Shopping list', 'Shopping');
    const turn = control('Turn into (Now Text)');
    turn.click();
    expect(turn.getAttribute('aria-expanded')).toBe('true');
    const menu = toolbar()!.querySelector('[role="menu"]')!;
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('true');
    const options = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(options.map((option) => option.lastElementChild?.textContent)).toEqual([
      'Text',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Bulleted List',
      'Numbered List',
      'Checklist',
      'Quote',
      'Code Block',
      'Callout',
      'Toggle',
    ]);
    options[2]!.click();
    expect(markdownOf(collab)).toBe('## Shopping list\n');
    expect(control('Turn into (Now Heading 2)')).toBeDefined();
  });

  it('copies the selection as Markdown or rich text from its Copy menu (T15)', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const collab = await withSelection('make **this** bold', 'this');
      const copy = control('Copy As');
      copy.click();
      expect(copy.getAttribute('aria-expanded')).toBe('true');
      const items = [...toolbar()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      expect(items.map((entry) => entry.firstElementChild?.textContent)).toEqual([
        'Copy as Markdown',
        'Copy as Rich Text',
      ]);
      expect(document.activeElement).toBe(items[0]);
      expect(items[0]!.getAttribute('aria-keyshortcuts')).toMatch(/^(Control|Meta)\+Shift\+C$/);
      // Copy as rich text has a default shortcut on Apple platforms only (AltGr+Shift+C types Ć).
      const apple = /Mac|iPhone|iPad/.test(navigator.platform);
      expect(items[1]!.getAttribute('aria-keyshortcuts')).toBe(apple ? 'Meta+Alt+Shift+C' : null);
      expect(items[1]!.querySelector('kbd')?.textContent ?? '').toBe(apple ? '⌘⌥⇧C' : '');
      items[0]!.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('this'));
      expect(copy.getAttribute('aria-expanded')).toBe('false');
      expect(collab.editor.view.hasFocus()).toBe(true);
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('is reached with Alt-F10, moved through with arrows, and left with Escape', async () => {
    const collab = await withSelection('one two', 'two');
    const { view } = collab.editor;
    expect(press(view, 'F10', { altKey: true })).toBe(true);
    expect(document.activeElement).toBe(control('Bold'));
    expect(control('Bold').tabIndex).toBe(0);
    const key = (name: string) =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      );
    key('ArrowRight');
    expect(document.activeElement).toBe(control('Italic'));
    expect(control('Bold').tabIndex).toBe(-1);
    key('ArrowLeft');
    key('ArrowLeft');
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Turn into/i);
    key('Escape');
    expect(view.hasFocus()).toBe(true);
    expect(view.state.selection.empty).toBe(false);
  });

  it('edits a link’s text and address together, buttons above the fields (T64 item 1)', async () => {
    const collab = await withSelection('see the docs now', 'the docs');
    control('Link').click();
    const form = toolbar()!.querySelector<HTMLElement>('.pm-toolbar-link-form')!;
    const text = form.querySelector<HTMLInputElement>('input[aria-label="Link text"]')!;
    const input = form.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
    // The buttons come first, each an icon and a word.
    expect(form.firstElementChild!.classList.contains('pm-toolbar-link-actions')).toBe(true);
    for (const name of ['Apply', 'Remove Link']) {
      expect(control(name).querySelector('svg')).not.toBeNull();
      expect(control(name).textContent).toBe(name === 'Apply' ? 'Apply' : 'Remove');
    }
    expect(text.value).toBe('the docs');
    input.value = 'penmoss.app/docs';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(markdownOf(collab)).toBe('see [the docs](https://penmoss.app/docs) now\n');
    // With the caret in the link, the form opens on the whole link.
    const start = startOf(collab.editor.view, 'paragraph') + 'see the d'.length;
    select(collab.editor.view, start, start + 2);
    collab.editor.view.focus();
    await vi.waitFor(() => expect(toolbar()).not.toBeNull());
    control('Link').click();
    expect(text.value).toBe('the docs');
    expect(input.value).toBe('https://penmoss.app/docs');
    text.value = 'the guide';
    input.value = 'https://penmoss.app/guide';
    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(markdownOf(collab)).toBe('see [the guide](https://penmoss.app/guide) now\n');
  });

  it('opens the link field with Mod-K', async () => {
    const collab = await withSelection('one two', 'two');
    expect(press(collab.editor.view, 'k', { ctrlKey: true })).toBe(true);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Link address');
  });
});

describe('turnInto', () => {
  it('lifts a list item out of its list for kinds a list item cannot start with', () => {
    const collab = openEditor([
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [paragraph('one')] },
          { type: 'listItem', content: [paragraph('two')] },
        ],
      },
    ]);
    const { view } = collab.editor;
    select(view, startOf(view, 'paragraph', 1) + 1);
    turnInto(collab.editor, item('heading1'));
    expect(markdownOf(collab)).toBe('- one\n\n# two\n');
  });

  it('switches between list kinds and back to text in one undo step', () => {
    const collab = openEditor([paragraph('alpha')]);
    const { view } = collab.editor;
    select(view, 2);
    turnInto(collab.editor, item('orderedList'));
    expect(markdownOf(collab)).toBe('1. alpha\n');
    turnInto(collab.editor, item('taskList'));
    expect(markdownOf(collab)).toBe('- [ ] alpha\n');
    turnInto(collab.editor, item('paragraph'));
    expect(markdownOf(collab)).toBe('alpha\n');
    turnInto(collab.editor, item('blockquote'));
    expect(markdownOf(collab)).toBe('> alpha\n');
  });
});

describe('turn into and tables', () => {
  const cell = (type: 'tableHeader' | 'tableCell', text: string, align: string | null) => ({
    type,
    attrs: { colspan: 1, rowspan: 1, colwidth: [120], align },
    content: [{ type: 'text', text }],
  });
  const content = [
    paragraph('before the table'),
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [cell('tableHeader', 'h1', 'center'), cell('tableHeader', 'h2', null)],
        },
        {
          type: 'tableRow',
          content: [cell('tableCell', 'b1', 'center'), cell('tableCell', 'b2', 'right')],
        },
      ],
    },
  ];

  it('neither offers nor runs Turn into for a selection reaching into a table', async () => {
    const collab = openEditor(content);
    const { view } = collab.editor;
    view.focus();
    const before = collab.editor.getJSON();
    // From the paragraph into the first body cell.
    select(view, 3, startOf(view, 'tableCell') + 1);
    await vi.waitFor(() => expect(toolbar()).not.toBeNull());
    const turn = [...toolbar()!.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.getAttribute('aria-label')?.toLowerCase().startsWith('turn into'),
    )!;
    expect(turn.hidden).toBe(true);
    for (const id of ['paragraph', 'bulletList', 'heading2', 'blockquote', 'callout']) {
      expect(turnInto(collab.editor, item(id))).toBe(false);
    }
    expect(collab.editor.getJSON()).toEqual(before);
  });

  it('keeps marks working across a table, without touching the cells', async () => {
    const collab = openEditor(content);
    const { view } = collab.editor;
    view.focus();
    select(view, 3, startOf(view, 'tableCell') + 1);
    await vi.waitFor(() => expect(toolbar()).not.toBeNull());
    control('Bold').click();
    const table = collab.editor.getJSON().content?.[1];
    const attrs = (table?.content ?? []).flatMap((row: JSONContent) =>
      (row.content ?? []).map((entry: JSONContent) => [entry.type, entry.attrs]),
    );
    expect(attrs).toEqual([
      ['tableHeader', { colspan: 1, rowspan: 1, colwidth: [120], align: 'center' }],
      ['tableHeader', { colspan: 1, rowspan: 1, colwidth: [120], align: null }],
      ['tableCell', { colspan: 1, rowspan: 1, colwidth: [120], align: 'center' }],
      ['tableCell', { colspan: 1, rowspan: 1, colwidth: [120], align: 'right' }],
    ]);
  });
});

describe('toolbar shortcuts leave the app its keys', () => {
  it('lets Mod-K through without a text selection (the command palette, T20)', () => {
    const collab = openEditor([paragraph('one two')]);
    const { view } = collab.editor;
    select(view, 2);
    expect(press(view, 'k', { ctrlKey: true })).toBe(false);
  });

  it('toggles inline code with Mod-Shift-E and leaves Mod-E (recent notes, T20) alone', () => {
    const collab = openEditor([paragraph('one two')]);
    const { view } = collab.editor;
    select(view, 1, 4);
    expect(press(view, 'e', { ctrlKey: true })).toBe(false);
    expect(collab.editor.isActive('code')).toBe(false);
    expect(press(view, 'e', { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(collab.editor.isActive('code')).toBe(true);
    const storage = collab.editor.storage as unknown as {
      selectionToolbar: { toolbar: { element: HTMLElement } };
    };
    const code = storage.selectionToolbar.toolbar.element.querySelector(
      '[aria-label="Inline Code"]',
    );
    expect(code?.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+E');
  });

  it('builds the toolbar in the editor’s own document', () => {
    const other = document.implementation.createHTMLDocument('other');
    const element = other.createElement('div');
    other.body.append(element);
    const collab = createCollabEditor({ element, extensions: noteExtensions() });
    try {
      const storage = collab.editor.storage as unknown as {
        selectionToolbar: { toolbar: { element: HTMLElement } };
      };
      expect(storage.selectionToolbar.toolbar.element.ownerDocument).toBe(other);
    } finally {
      collab.destroy();
    }
  });
});
