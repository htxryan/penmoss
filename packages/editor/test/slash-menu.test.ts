import { schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import type { Replica } from '@penmoss/sync-client';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';
import {
  BLOCK_ITEMS,
  availableBlockItems,
  filterBlockItems,
  type BlockItem,
} from '../src/extensions/block-items';
import type { ImageServices } from '../src/extensions/image';
import type { SlashMenu } from '../src/extensions/slash-menu';
import { codeBlock, openEditor, paragraph, press, select, startOf, type } from './support/editor';

type Collab = ReturnType<typeof openEditor>;

const markdownOf = (collab: Collab) =>
  serializeMarkdown({ frontmatter: null, doc: coreSchema.nodeFromJSON(collab.editor.getJSON()) });

const ids = (items: readonly BlockItem[]) => items.map((item) => item.id);

const menuOf = (collab: Collab) =>
  (collab.editor.storage as unknown as { slashMenu: { menu: SlashMenu | null } }).slashMenu.menu;

const isOpen = (collab: Collab) => menuOf(collab)?.isOpen === true;

const images = (): ImageServices => ({
  add: vi.fn(() => Promise.resolve({ path: 'attachments/abc.png' })),
  resolve: () => Promise.resolve(null),
});

/** Types `/query` and Enter in a fresh note, then `after`, and returns the markdown. */
function viaMenu(query: string, after = ''): string {
  const collab = openEditor();
  const { view } = collab.editor;
  type(view, `/${query}`);
  expect(isOpen(collab)).toBe(true);
  expect(press(view, 'Enter')).toBe(true);
  type(view, after);
  const markdown = markdownOf(collab);
  collab.destroy();
  return markdown;
}

describe('filterBlockItems', () => {
  it('lists the general blocks in order without a query, and no callout types', () => {
    const all = filterBlockItems(BLOCK_ITEMS, '');
    expect(ids(all)).toEqual([
      'paragraph',
      'heading1',
      'heading2',
      'heading3',
      'bulletList',
      'orderedList',
      'taskList',
      'blockquote',
      'horizontalRule',
      'codeBlock',
      'table',
      'callout',
      'toggle',
      'mermaid',
      'blockMath',
      'inlineMath',
      'wikilink',
      'embed',
      'image',
      'file',
      'drawing',
      'symbol',
    ]);
    expect(filterBlockItems(BLOCK_ITEMS, '   ')).toEqual(all);
  });

  it('matches label words first, then keywords, then text inside the label', () => {
    expect(ids(filterBlockItems(BLOCK_ITEMS, 'head'))).toEqual([
      'heading1',
      'heading2',
      'heading3',
    ]);
    expect(ids(filterBlockItems(BLOCK_ITEMS, 'h2'))).toEqual(['heading2']);
    expect(ids(filterBlockItems(BLOCK_ITEMS, 'list'))).toEqual([
      'bulletList',
      'orderedList',
      'taskList',
    ]);
    expect(ids(filterBlockItems(BLOCK_ITEMS, 'todo'))).toContain('taskList');
    expect(ids(filterBlockItems(BLOCK_ITEMS, 'eckl'))).toEqual(['taskList']);
    expect(ids(filterBlockItems(BLOCK_ITEMS, 'MATH'))).toEqual(['blockMath', 'inlineMath']);
  });

  it('needs every word of the query to match', () => {
    expect(ids(filterBlockItems(BLOCK_ITEMS, 'num list'))).toEqual(['orderedList']);
    expect(ids(filterBlockItems(BLOCK_ITEMS, 'inline math'))).toEqual(['inlineMath']);
    expect(filterBlockItems(BLOCK_ITEMS, 'zzz')).toEqual([]);
  });

  it('finds a callout of each type by name, after the general callout', () => {
    expect(ids(filterBlockItems(BLOCK_ITEMS, 'warn'))).toEqual(['callout-warning']);
    const callouts = ids(filterBlockItems(BLOCK_ITEMS, 'callout'));
    expect(callouts[0]).toBe('callout');
    expect(callouts).toContain('callout-danger');
    expect(callouts).toHaveLength(14);
  });
});

describe('availableBlockItems', () => {
  it('offers Image only with image storage', () => {
    const collab = openEditor();
    expect(ids(availableBlockItems(collab.editor))).not.toContain('image');
    expect(ids(availableBlockItems(collab.editor, images()))).toContain('image');
  });

  it('offers only inline items in a table cell, and Symbol (T52 item 2)', () => {
    const collab = openEditor();
    type(collab.editor.view, '| a | b |\n');
    expect(ids(availableBlockItems(collab.editor, images()))).toEqual([
      'inlineMath',
      'image',
      'symbol',
    ]);
  });
});

describe('slash menu: inserting every block by keyboard', () => {
  it.each([
    ['text', 'plain', 'plain\n'],
    ['h1', 'Title', '# Title\n'],
    ['heading 2', 'Section', '## Section\n'],
    ['h3', 'Sub', '### Sub\n'],
    ['bullet', 'item', '- item\n'],
    ['numbered', 'first', '1. first\n'],
    ['checklist', 'task', '- [ ] task\n'],
    ['quote', 'wise', '> wise\n'],
    ['code', 'let a', '```\nlet a\n```\n'],
    ['mermaid', 'graph TD', '```mermaid\ngraph TD\n```\n'],
    ['callout', 'body', '> [!note]\n> body\n'],
    ['warning', 'careful', '> [!warning]\n> careful\n'],
  ])('/%s', (query, after, markdown) => {
    expect(viaMenu(query, after)).toBe(markdown);
  });

  it('/divider puts a rule before the caret paragraph', () => {
    const collab = openEditor([paragraph('before')]);
    const { view } = collab.editor;
    select(view, view.state.doc.content.size - 1);
    press(view, 'Enter');
    type(view, '/divider');
    press(view, 'Enter');
    type(view, 'after');
    expect(markdownOf(collab)).toBe('before\n\n---\n\nafter\n');
  });

  it('/table makes a two-column table with the caret in the first header cell', () => {
    expect(viaMenu('table', 'Name\tDone\tAda')).toBe('| Name | Done |\n| - | - |\n| Ada | |\n');
  });

  it('/toggle makes a folded-by-default toggle and puts focus in its title', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '/toggle');
    press(view, 'Enter');
    const title = view.dom.querySelector<HTMLInputElement>('.pm-callout-title')!;
    expect(document.activeElement).toBe(title);
    title.value = 'Details';
    title.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    type(view, 'hidden');
    expect(markdownOf(collab)).toBe('> [!note]- Details\n> hidden\n');
  });

  it('/math block inserts a formula and opens its LaTeX field', async () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '/math block');
    press(view, 'Enter');
    expect(collab.editor.getJSON().content?.[0]).toEqual({
      type: 'blockMath',
      attrs: { latex: '' },
    });
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    await vi.waitFor(() => expect(view.dom.querySelector('textarea.pm-math-field')).not.toBeNull());
  });

  it('/inline math inserts an inline formula and opens its field', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, 'Area /inline');
    press(view, 'Enter');
    const field = view.dom.querySelector<HTMLInputElement>('input.pm-math-field')!;
    expect(field).not.toBeNull();
    field.value = 'a^2';
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(markdownOf(collab)).toBe('Area $a^2$\n');
  });

  it('/image opens a file picker and inserts the chosen image through the image services', async () => {
    const add = vi.fn(() => Promise.resolve({ path: 'attachments/abc.png' }));
    const collab = openEditor(undefined, { images: { ...images(), add } });
    const { view } = collab.editor;
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      const file = new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });
      Object.defineProperty(this, 'files', { value: [file] });
      this.dispatchEvent(new Event('change'));
    });
    type(view, 'Photo: /image');
    press(view, 'Enter');
    expect(click).toHaveBeenCalledTimes(1);
    const picker = click.mock.contexts[0] as HTMLInputElement;
    expect(picker.type).toBe('file');
    expect(picker.accept).toContain('image/png');
    await vi.waitFor(() => expect(markdownOf(collab)).toBe('Photo: ![](attachments/abc.png)\n'));
    expect(add).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('turns the caret block into the chosen kind, keeping its text', () => {
    const collab = openEditor([paragraph('Groceries ')]);
    const { view } = collab.editor;
    select(view, startOf(view, 'paragraph') + 'Groceries '.length);
    type(view, '/h2');
    press(view, 'Enter');
    expect(markdownOf(collab)).toBe('## Groceries\n');
  });

  it('inserts a block-level item after a line that has text', () => {
    const collab = openEditor([paragraph('Before ')]);
    const { view } = collab.editor;
    select(view, startOf(view, 'paragraph') + 'Before '.length);
    type(view, '/table');
    press(view, 'Enter');
    expect(collab.editor.getJSON().content?.map((node) => node.type)).toEqual([
      'paragraph',
      'table',
      'paragraph',
    ]);
  });
});

describe('slash menu: keyboard and accessibility', () => {
  it('moves with the arrow keys, wrapping, and inserts the highlighted item', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '/');
    const menu = menuOf(collab)!;
    expect(menu.selected?.id).toBe('paragraph');
    press(view, 'ArrowDown');
    press(view, 'ArrowDown');
    expect(menu.selected?.id).toBe('heading2');
    press(view, 'ArrowUp');
    press(view, 'ArrowUp');
    press(view, 'ArrowUp');
    // Without image storage, the last item is Symbol (T44), after Inline math.
    expect(menu.selected?.id).toBe('symbol');
    press(view, 'ArrowDown');
    press(view, 'ArrowDown');
    press(view, 'ArrowDown');
    press(view, 'Tab');
    type(view, 'x');
    expect(markdownOf(collab)).toBe('## x\n');
  });

  it('is a labelled listbox the editor points at with aria-activedescendant', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '/he');
    const listbox = document.querySelector('[role="listbox"]')!;
    expect(listbox.getAttribute('aria-label')).toBe('Insert block');
    const options = [...listbox.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      'H1Heading 1#',
      'H2Heading 2##',
      'H3Heading 3###',
    ]);
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(view.dom.getAttribute('aria-controls')).toBe(listbox.id);
    // aria-expanded is not allowed on a textbox; aria-controls and the active option are.
    expect(view.dom.hasAttribute('aria-expanded')).toBe(false);
    expect(view.dom.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    press(view, 'ArrowDown');
    expect(view.dom.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    expect(listbox.querySelector('[aria-selected="true"]')!.id).toBe(options[1]!.id);
  });

  it('closes with Escape, keeping the typed text and the attributes tidy', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '/he');
    expect(press(view, 'Escape')).toBe(true);
    expect(isOpen(collab)).toBe(false);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(view.dom.hasAttribute('aria-activedescendant')).toBe(false);
    expect(view.dom.hasAttribute('aria-expanded')).toBe(false);
    // Enter now ends the line instead of inserting anything.
    press(view, 'Enter');
    expect(markdownOf(collab)).toBe('/he\n');
  });

  it('says when nothing matches, and lets Enter through', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '/zzz');
    expect(isOpen(collab)).toBe(true);
    expect(document.querySelector('.pm-slash-empty')!.textContent).toBe('No blocks match “zzz”');
    press(view, 'Enter');
    expect(collab.editor.state.doc.childCount).toBe(2);
    expect(isOpen(collab)).toBe(false);
  });

  it('allows single spaces in the query, and closes on a double space', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '/math bl');
    expect(menuOf(collab)!.options.map((item) => item.id)).toEqual(['blockMath']);
    type(view, '  ');
    expect(isOpen(collab)).toBe(false);
  });

  it('opens only at the start of a line or after a space, and never in code', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, 'and/or');
    expect(isOpen(collab)).toBe(false);
    type(view, ' /');
    expect(isOpen(collab)).toBe(true);
    const code = openEditor([codeBlock('')]);
    select(code.editor.view, 1);
    type(code.editor.view, '/');
    expect(isOpen(code)).toBe(false);
  });

  it("never opens because a peer's edit put a slash before the caret", () => {
    const a = openEditor();
    const b = openEditor();
    const sync = (from: Replica, to: Replica) =>
      to.applyUpdate(from.encodeStateAsUpdate(to.encodeStateVector()), 'remote');
    type(a.editor.view, 'x');
    sync(a.replica, b.replica);
    select(a.editor.view, 1);
    select(b.editor.view, 1);
    type(b.editor.view, '/');
    sync(b.replica, a.replica);
    expect(a.editor.state.doc.textContent).toBe('/x');
    expect(isOpen(a)).toBe(false);
  });
});

describe('slash menu: opening only on a typed slash', () => {
  it('stays closed when the caret moves back after an existing /word', () => {
    const collab = openEditor([paragraph('see /heading'), paragraph('next')]);
    const { view } = collab.editor;
    select(view, 1 + 'see /heading'.length);
    expect(isOpen(collab)).toBe(false);
    press(view, 'Enter');
    expect(isOpen(collab)).toBe(false);
    // Enter did what Enter does: no block conversion, nothing deleted.
    expect(markdownOf(collab)).toBe('see /heading\n\nnext\n');
  });

  it('stays closed after a click or arrow that lands after a slash it closed before', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, 'a /he');
    expect(isOpen(collab)).toBe(true);
    select(view, 1);
    expect(isOpen(collab)).toBe(false);
    select(view, 1 + 'a /he'.length);
    expect(isOpen(collab)).toBe(false);
    press(view, 'Tab');
    expect(collab.editor.state.doc.textContent).toBe('a /he');
  });

  it('does not open for a pasted slash, but keeps an open menu through a paste', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    const paste = (text: string) =>
      view.dispatch(view.state.tr.insertText(text).setMeta('uiEvent', 'paste'));
    paste('x /code');
    expect(isOpen(collab)).toBe(false);
    type(view, ' /');
    expect(isOpen(collab)).toBe(true);
    paste('he');
    expect(isOpen(collab)).toBe(true);
    expect(menuOf(collab)!.options[0]!.id).toBe('heading1');
  });

  it('opens again when a slash is typed after closing it', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '/');
    press(view, 'Escape');
    expect(isOpen(collab)).toBe(false);
    type(view, ' /');
    expect(isOpen(collab)).toBe(true);
  });

  it('never opens inside inline code, or with inline code about to be typed', () => {
    const collab = openEditor([
      { type: 'paragraph', content: [{ type: 'text', text: 'run ', marks: [{ type: 'code' }] }] },
    ]);
    const { view } = collab.editor;
    select(view, 1 + 'run '.length);
    type(view, '/');
    expect(isOpen(collab)).toBe(false);
    const fresh = openEditor();
    fresh.editor.commands.toggleCode();
    type(fresh.editor.view, '/');
    expect(isOpen(fresh)).toBe(false);
  });
});

describe('slash menu: options and teardown', () => {
  it('moves the highlight without rebuilding the options', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '/');
    const before = [...document.querySelectorAll('[role="option"]')];
    press(view, 'ArrowDown');
    const after = [...document.querySelectorAll('[role="option"]')];
    expect(after).toHaveLength(before.length);
    after.forEach((option, index) => expect(option).toBe(before[index]));
    expect(before[0]!.getAttribute('aria-selected')).toBe('false');
    expect(before[1]!.getAttribute('aria-selected')).toBe('true');
    expect(view.dom.getAttribute('aria-activedescendant')).toBe(before[1]!.id);
  });

  it('leaves no menu, attributes or document listeners when destroyed while open', () => {
    const added: string[] = [];
    const removed: string[] = [];
    const add = vi.spyOn(document, 'addEventListener').mockImplementation(function (
      this: Document,
      ...args: Parameters<Document['addEventListener']>
    ) {
      added.push(args[0]);
      return EventTarget.prototype.addEventListener.apply(this, args);
    });
    const remove = vi.spyOn(document, 'removeEventListener').mockImplementation(function (
      this: Document,
      ...args: Parameters<Document['removeEventListener']>
    ) {
      removed.push(args[0]);
      return EventTarget.prototype.removeEventListener.apply(this, args);
    });
    try {
      const collab = openEditor();
      const { view } = collab.editor;
      const before = added.length;
      type(view, '/');
      expect(isOpen(collab)).toBe(true);
      const opened = added.slice(before);
      collab.destroy();
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      expect(view.dom.hasAttribute('aria-activedescendant')).toBe(false);
      for (const type of opened) expect(removed).toContain(type);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});

describe('slash menu: image', () => {
  /** Image services whose `add` waits for the test to release it. */
  function slowImages() {
    let release: () => void = () => undefined;
    const add = vi.fn(
      () =>
        new Promise<{ path: string }>((resolve) => {
          release = () => resolve({ path: 'attachments/abc.png' });
        }),
    );
    return { services: { ...images(), add }, release: () => release() };
  }

  function choose(input: HTMLInputElement) {
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
  }

  it('inserts the image where it was picked, even if the selection moves during the upload', async () => {
    const { services, release } = slowImages();
    const collab = openEditor(undefined, { images: services });
    const { view } = collab.editor;
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      type(view, 'Photo: /image');
      press(view, 'Enter');
      // While the picker is open, text is added before the insertion point.
      collab.editor.chain().insertContentAt(1, 'My ').run();
      choose(click.mock.contexts[0] as HTMLInputElement);
      await vi.waitFor(() => expect(services.add).toHaveBeenCalled());
      // During the upload the user selects text, and a peer-like edit lands before it.
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
      collab.editor.chain().insertContentAt(1, '> ').run();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
      release();
      await vi.waitFor(() => expect(view.state.doc.textContent).toContain('Photo'));
      await vi.waitFor(() =>
        expect(markdownOf(collab)).toBe('\\> My Photo: ![](attachments/abc.png)\n'),
      );
    } finally {
      click.mockRestore();
    }
  });

  it('removes the hidden file input when the picker closes without a choice', () => {
    vi.useFakeTimers();
    const collab = openEditor(undefined, { images: images() });
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      type(collab.editor.view, '/image');
      press(collab.editor.view, 'Enter');
      expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
      // The dialog closed: the window gets focus back, and no change event comes.
      window.dispatchEvent(new Event('focus'));
      vi.advanceTimersByTime(2000);
      expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
    } finally {
      click.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('the block menu on a right-click (no `/` typed)', () => {
  /** A note opened as the Mac app and the web open one: with the right-click menu. */
  const withMenu = (content?: Parameters<typeof openEditor>[0]) =>
    openEditor(content, { blockContextMenu: true });

  /**
   * A right-click at document position `pos` (happy-dom has no layout, so the place under the
   * pointer is given), on `target` (the note's text by default). Returns the contextmenu event.
   */
  function rightClick(collab: Collab, pos: number, target?: Element): MouseEvent {
    const { view } = collab.editor;
    const at = vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos, inside: -1 });
    try {
      const on = target ?? view.dom.querySelector('p') ?? view.dom;
      const init = { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 };
      on.dispatchEvent(new MouseEvent('mousedown', init));
      const event = new MouseEvent('contextmenu', init);
      on.dispatchEvent(event);
      return event;
    } finally {
      at.mockRestore();
    }
  }

  const typeKeys = (collab: Collab, text: string) => {
    for (const key of text) expect(press(collab.editor.view, key)).toBe(true);
  };

  const filterOf = () => document.querySelector<HTMLElement>('[data-testid="slash-filter"]')!;

  it('opens at the click with the caret there, filters as you type, and inserts there', () => {
    const collab = withMenu([paragraph('Beds'), paragraph(), paragraph('Paths')]);
    const { view } = collab.editor;
    const at = startOf(view, 'paragraph', 1);
    const event = rightClick(collab, at);
    expect(event.defaultPrevented).toBe(true);
    expect(isOpen(collab)).toBe(true);
    expect(menuOf(collab)!.isContextMenu).toBe(true);
    expect(view.state.selection.empty).toBe(true);
    expect(view.state.selection.from).toBe(at);
    expect(ids(menuOf(collab)!.options)).toEqual(
      ids(availableBlockItems(collab.editor).filter((item) => !item.searchOnly)),
    );
    expect(filterOf().hidden).toBe(false);
    expect(filterOf().textContent).toBe('/');
    // Typing filters the menu, not the note.
    typeKeys(collab, 'checkx');
    expect(menuOf(collab)!.options).toEqual([]);
    expect(press(view, 'Backspace')).toBe(true);
    expect(filterOf().textContent).toBe('/check');
    expect(menuOf(collab)!.selected?.id).toBe('taskList');
    expect(markdownOf(collab)).toBe('Beds\n\nPaths\n');
    expect(press(view, 'Enter')).toBe(true);
    expect(isOpen(collab)).toBe(false);
    type(view, 'Water');
    expect(markdownOf(collab)).toBe('Beds\n\n- [ ] Water\n\nPaths\n');
  });

  it('closes with Escape, or Backspace with nothing typed, leaving the note as it was', () => {
    const collab = withMenu([paragraph('Beds')]);
    const { view } = collab.editor;
    rightClick(collab, 3);
    typeKeys(collab, 'he');
    expect(press(view, 'Escape')).toBe(true);
    expect(isOpen(collab)).toBe(false);
    rightClick(collab, 3);
    expect(press(view, 'Backspace')).toBe(true);
    expect(isOpen(collab)).toBe(false);
    expect(markdownOf(collab)).toBe('Beds\n');
    // Any other key closes it and does what it does.
    rightClick(collab, 3);
    expect(isOpen(collab)).toBe(true);
    expect(press(view, 'ArrowLeft')).toBe(false);
    expect(isOpen(collab)).toBe(false);
  });

  it('after text in the line, puts the block after it, as the slash menu does', () => {
    const collab = withMenu([paragraph('Beds')]);
    rightClick(collab, 5);
    typeKeys(collab, 'divider');
    press(collab.editor.view, 'Enter');
    expect(markdownOf(collab)).toBe('Beds\n\n---\n');
  });

  it('opens at the caret with the context-menu key or Shift+F10', () => {
    const collab = withMenu([paragraph('Beds')]);
    const { view } = collab.editor;
    select(view, 3);
    expect(press(view, 'ContextMenu')).toBe(true);
    expect(menuOf(collab)!.isContextMenu).toBe(true);
    // The key's own contextmenu event that follows opens nothing more, and no page menu.
    const follow = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    view.dom.dispatchEvent(follow);
    expect(follow.defaultPrevented).toBe(true);
    press(view, 'Escape');
    expect(press(view, 'F10', { shiftKey: true })).toBe(true);
    expect(isOpen(collab)).toBe(true);
    press(view, 'Escape');
    expect(press(view, 'F10')).toBe(false);
    expect(isOpen(collab)).toBe(false);
  });

  it('leaves the page its own menu with text selected', () => {
    const collab = withMenu([paragraph('Beds and paths')]);
    const { view } = collab.editor;
    select(view, 1, 5);
    expect(rightClick(collab, 3).defaultPrevented).toBe(false);
    expect(isOpen(collab)).toBe(false);
    expect(press(view, 'ContextMenu')).toBe(false);
  });

  it('leaves the page its own menu on a link, in code, in a table, or on a comment', () => {
    const link = { type: 'link', attrs: { href: 'https://example.com' } };
    const collab = withMenu([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          { type: 'text', text: 'the site', marks: [link] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'code', marks: [{ type: 'code' }] },
        ],
      },
      codeBlock('const a = 1;'),
    ]);
    const { view } = collab.editor;
    expect(rightClick(collab, 7, view.dom.querySelector('a')!).defaultPrevented).toBe(false);
    expect(rightClick(collab, 20, view.dom.querySelector('code')!).defaultPrevented).toBe(false);
    // Places in a link or in code, whatever the element under the pointer says.
    expect(rightClick(collab, 7).defaultPrevented).toBe(false);
    expect(rightClick(collab, startOf(view, 'codeBlock') + 2).defaultPrevented).toBe(false);
    const comment = document.createElement('span');
    comment.className = 'pm-comment';
    view.dom.querySelector('p')!.append(comment);
    expect(rightClick(collab, 2, comment).defaultPrevented).toBe(false);
    expect(isOpen(collab)).toBe(false);

    const table = withMenu();
    type(table.editor.view, '| a | b |\n');
    const cell = startOf(table.editor.view, 'tableCell');
    const td = table.editor.view.dom.querySelector('td, th')!;
    expect(rightClick(table, cell, td).defaultPrevented).toBe(false);
    expect(rightClick(table, cell).defaultPrevented).toBe(false);
    expect(isOpen(table)).toBe(false);
  });

  it('is off without the option (Android) and in a read-only note', () => {
    const android = openEditor([paragraph('Beds')]);
    expect(rightClick(android, 3).defaultPrevented).toBe(false);
    select(android.editor.view, 3);
    expect(press(android.editor.view, 'ContextMenu')).toBe(false);
    expect(isOpen(android)).toBe(false);
    const readOnly = withMenu([paragraph('Beds')]);
    readOnly.editor.setEditable(false);
    expect(rightClick(readOnly, 3).defaultPrevented).toBe(false);
    expect(isOpen(readOnly)).toBe(false);
  });

  it('closes on a press outside it, and a click on an option inserts that block', () => {
    const collab = withMenu([paragraph()]);
    rightClick(collab, 1);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(isOpen(collab)).toBe(false);
    rightClick(collab, 1);
    const option = [...document.querySelectorAll<HTMLElement>('.pm-slash-option')].find((element) =>
      element.textContent?.includes('Quote'),
    )!;
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(isOpen(collab)).toBe(false);
    type(collab.editor.view, 'Said');
    expect(markdownOf(collab)).toBe('> Said\n');
  });
});
