import { parseMarkdown, schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import type { JSONContent } from '@tiptap/core';
// Imported with the file, not inside the test: loading it took 7 s under load, past the test's 5 s.
import { GapCursor } from '@tiptap/pm/gapcursor';
import { describe, expect, it, vi } from 'vitest';
import { memoryFoldState } from '../src/extensions/callout';
import { openEditor, paragraph, press, select, startOf, type } from './support/editor';

type Collab = ReturnType<typeof openEditor>;

/** Core's parse of `markdown`, as editor content. */
const blocksOf = (markdown: string) =>
  (parseMarkdown(markdown).doc.toJSON() as JSONContent).content ?? [];

const markdownOf = (collab: Collab) =>
  serializeMarkdown({ frontmatter: null, doc: coreSchema.nodeFromJSON(collab.editor.getJSON()) });

const button = (collab: Collab, name: string) =>
  collab.editor.view.dom.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;

/** Puts the caret in the cell at (row, column) of the first table. */
function selectCell(collab: Collab, row: number, column: number) {
  const { view } = collab.editor;
  const tablePos = startOf(view, 'table') - 1;
  const table = view.state.doc.nodeAt(tablePos)!;
  let pos = tablePos + 1;
  for (let r = 0; r < row; r += 1) pos += table.child(r).nodeSize;
  pos += 1;
  for (let c = 0; c < column; c += 1) pos += table.child(row).child(c).nodeSize;
  select(view, pos + 1);
}

/** Each table row's cells as `th:text` or `td:text`. */
function cells(collab: Collab): string[][] {
  const rows: string[][] = [];
  collab.editor.state.doc.descendants((node) => {
    if (node.type.name !== 'tableRow') return true;
    const row: string[] = [];
    node.forEach((cell) => {
      row.push(`${cell.type.name === 'tableHeader' ? 'th' : 'td'}:${cell.textContent}`);
    });
    rows.push(row);
    return false;
  });
  return rows;
}

describe('tables', () => {
  it('turns a typed `| a | b |` row plus Enter into a table, caret in the first body cell', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '| Name | Status |\nAda\tdone');
    expect(cells(collab)).toEqual([
      ['th:Name', 'th:Status'],
      ['td:Ada', 'td:done'],
    ]);
    expect(markdownOf(collab)).toBe('| Name | Status |\n| - | - |\n| Ada | done |\n');
  });

  it('moves between cells with Tab and Shift-Tab, adding a row after the last cell', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '| a | b |\n1');
    press(view, 'Tab');
    type(view, '2');
    press(view, 'Tab');
    type(view, '3');
    expect(cells(collab)).toEqual([
      ['th:a', 'th:b'],
      ['td:1', 'td:2'],
      ['td:3', 'td:'],
    ]);
    // Shift-Tab selects the previous cell's content, so typing replaces it.
    press(view, 'Tab', { shiftKey: true });
    type(view, '!');
    expect(cells(collab)[1]).toEqual(['td:1', 'td:!']);
  });

  // T39 pass 3 (A906): seven text buttons wrapped on a phone; they are icons, named for both.
  it('shows the toolbar as named icon buttons, each with its name as its tooltip', () => {
    const collab = openEditor();
    type(collab.editor.view, '| a | b |\nx');
    const toolbar = collab.editor.view.dom.querySelector('.pm-table-toolbar')!;
    const buttons = [...toolbar.querySelectorAll('button')];
    expect(buttons.map((each) => each.getAttribute('aria-label'))).toEqual([
      'Add Row Above',
      'Add Row Below',
      'Delete Row',
      'Add Column Left',
      'Add Column Right',
      'Delete Column',
      'Delete Table',
    ]);
    for (const each of buttons) {
      expect(each.textContent).toBe('');
      expect(each.dataset.tip).toBe(each.getAttribute('aria-label'));
      const icon = each.querySelector('svg')!;
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.querySelector('path')!.getAttribute('d')).toMatch(/^M/);
    }
  });

  it('adds and removes rows and columns from the toolbar, keeping one header row', () => {
    const collab = openEditor();
    type(collab.editor.view, '| a | b |\nx');
    selectCell(collab, 0, 0);
    button(collab, 'Add Row Above').click();
    expect(cells(collab).map((row) => row.map((cell) => cell.slice(0, 2)))).toEqual([
      ['th', 'th'],
      ['td', 'td'],
      ['td', 'td'],
    ]);
    selectCell(collab, 1, 1);
    button(collab, 'Add Column Right').click();
    expect(cells(collab)[0]).toHaveLength(3);
    selectCell(collab, 1, 2);
    button(collab, 'Delete Column').click();
    expect(cells(collab)[0]).toHaveLength(2);
    selectCell(collab, 0, 0);
    button(collab, 'Delete Row').click();
    // The old header row went; the next row became the header.
    expect(cells(collab)).toEqual([
      ['th:a', 'th:b'],
      ['td:x', 'td:'],
    ]);
    button(collab, 'Add Row Below').click();
    expect(cells(collab)).toHaveLength(3);
    button(collab, 'Delete Table').click();
    expect(cells(collab)).toEqual([]);
  });

  it('shows the toolbar only while the selection is in the table', () => {
    const collab = openEditor([paragraph('before')]);
    const { view } = collab.editor;
    select(view, view.state.doc.content.size - 1);
    press(view, 'Enter');
    type(view, '| a |\n');
    const table = view.dom.querySelector('.pm-table')!;
    expect(table.classList.contains('pm-table-active')).toBe(true);
    select(view, 2);
    expect(table.classList.contains('pm-table-active')).toBe(false);
  });

  it("renders a peer's header-row change without repairing it back", () => {
    const a = openEditor();
    type(a.editor.view, '| a | b |\nx');
    const b = openEditor();
    b.replica.applyUpdate(a.replica.encodeStateAsUpdate(), 'remote');
    const writes: Uint8Array[] = [];
    b.replica.onUpdate((update, origin) => {
      if (origin !== 'remote') writes.push(update);
    });
    selectCell(a, 0, 0);
    button(a, 'Add Row Above').click();
    b.replica.applyUpdate(a.replica.encodeStateAsUpdate(), 'remote');
    expect(cells(b)).toEqual(cells(a));
    expect(writes).toEqual([]);
  });
});

describe('checklists', () => {
  it('turns `- [ ] ` and `- [x] ` into task items', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '- [ ] open\nnext');
    expect(markdownOf(collab)).toBe('- [ ] open\n- [ ] next\n');
    const fresh = openEditor();
    type(fresh.editor.view, '- [x] done');
    expect(markdownOf(fresh)).toBe('- [x] done\n');
  });

  it('turns one bullet item into a task, splitting the list around it', () => {
    const collab = openEditor([
      {
        type: 'bulletList',
        content: ['a', '', 'c'].map((text) => ({ type: 'listItem', content: [paragraph(text)] })),
      },
    ]);
    const { view } = collab.editor;
    select(view, startOf(view, 'paragraph', 1));
    type(view, '[ ] b');
    expect(markdownOf(collab)).toBe('- a\n\n* [ ] b\n\n- c\n');
    expect(collab.editor.getJSON().content?.map((node) => node.type)).toEqual([
      'bulletList',
      'taskList',
      'bulletList',
      'paragraph', // TipTap's trailing paragraph
    ]);
  });

  it('joins a new task with the task list just above it', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '- [ ] one\n');
    press(view, 'Enter'); // leaves the task list
    type(view, '- [ ] two');
    expect(markdownOf(collab)).toBe('- [ ] one\n- [ ] two\n');
  });

  it('turns `[ ] ` in a paragraph into a task list', () => {
    const collab = openEditor();
    type(collab.editor.view, '[ ] plain');
    expect(markdownOf(collab)).toBe('- [ ] plain\n');
  });
});

describe('callouts and toggles', () => {
  it('turns `> [!warning] ` into a callout', () => {
    const collab = openEditor();
    type(collab.editor.view, '> [!warning] Mind the gap');
    expect(markdownOf(collab)).toBe('> [!warning]\n> Mind the gap\n');
    const view = collab.editor.view.dom.querySelector<HTMLElement>('.pm-callout')!;
    expect(view.dataset['calloutType']).toBe('warning');
    expect(view.querySelector<HTMLButtonElement>('button.pm-callout-fold')!.hidden).toBe(true);
  });

  it('sets the title and type from the header', () => {
    const collab = openEditor();
    type(collab.editor.view, '> [!note] body');
    const dom = collab.editor.view.dom;
    const title = dom.querySelector<HTMLInputElement>('input[aria-label="Callout title"]')!;
    title.value = 'Source of truth';
    title.dispatchEvent(new Event('change'));
    const picker = dom.querySelector<HTMLSelectElement>('select[aria-label="Callout type"]')!;
    picker.value = 'tip';
    picker.dispatchEvent(new Event('change'));
    expect(markdownOf(collab)).toBe('> [!tip] Source of truth\n> body\n');
  });

  it('keeps an unknown type, styled as a note', () => {
    const collab = openEditor(blocksOf('> [!recipe] Pancakes\n> Flour\n'));
    const callout = collab.editor.view.dom.querySelector<HTMLElement>('.pm-callout')!;
    expect(callout.dataset['calloutType']).toBe('note');
    expect(callout.querySelector('select')!.value).toBe('recipe');
    expect(markdownOf(collab)).toBe('> [!recipe] Pancakes\n> Flour\n');
  });

  it('makes `> [!faq]- ` a folded toggle, open while it is being typed', () => {
    const collab = openEditor();
    type(collab.editor.view, '> [!faq]- Hidden answer');
    expect(markdownOf(collab)).toBe('> [!faq]-\n> Hidden answer\n');
    const toggle = collab.editor.view.dom.querySelector<HTMLElement>('.pm-callout')!;
    expect(toggle.dataset['open']).toBe('true');
    expect(toggle.dataset['calloutType']).toBe('question');
  });

  it('folds a toggle as device state: nothing is written to the note', () => {
    const folds = memoryFoldState();
    const markdown = '> [!todo]+ Packing\n> - [ ] Tent\n\nAfter\n';
    const content = blocksOf(markdown);
    const collab = openEditor(content, { foldState: folds });
    const updates: Uint8Array[] = [];
    collab.replica.onUpdate((update) => updates.push(update));

    const toggle = collab.editor.view.dom.querySelector<HTMLElement>('.pm-callout')!;
    const fold = toggle.querySelector<HTMLButtonElement>('button.pm-callout-fold')!;
    expect(toggle.dataset['open']).toBe('true');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fold.click();
    expect(toggle.dataset['open']).toBe('false');
    expect(fold.getAttribute('aria-label')).toBe('Expand Toggle');
    expect(updates).toEqual([]);
    expect(markdownOf(collab)).toBe(markdown);
    expect(folds.isOpen('todo|Packing|0')).toBe(false);

    // Another editor on this device opens the toggle closed.
    const again = openEditor(content, { foldState: folds });
    const reopened = again.editor.view.dom.querySelector<HTMLElement>('.pm-callout')!;
    expect(reopened.dataset['open']).toBe('false');
  });

  it('reads the fold state only for toggles', () => {
    const folds = memoryFoldState();
    const isOpen = vi.spyOn(folds, 'isOpen');
    openEditor(
      blocksOf('> [!note] One\n> A\n\n> [!tip] Two\n> B\n\n> [!faq]- Three\n> C\n\nAfter\n'),
      {
        foldState: folds,
      },
    );
    expect(isOpen.mock.calls).toEqual([['faq|Three|0']]);
  });

  it('opens a `-` toggle closed by default', () => {
    const content = blocksOf('> [!note]- Closed\n> Inside\n\nAfter\n');
    const collab = openEditor(content);
    select(collab.editor.view, collab.editor.state.doc.content.size - 1);
    expect(collab.editor.view.dom.querySelector<HTMLElement>('.pm-callout')!.dataset['open']).toBe(
      'false',
    );
  });
});

/** Core's fixtures for the blocks the editor builds (T9, T11, T12). */
const blockFixtures = Object.entries(
  import.meta.glob<string>('../../core/test/fixtures/blocks-*.md', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
).map(([path, markdown]) => ({ name: path.replace(/^.*\//, ''), markdown }));

describe('codec round trip through the editor', () => {
  it('finds the block fixtures', () => {
    expect(blockFixtures.map((fixture) => fixture.name)).toEqual(
      expect.arrayContaining(['blocks-callouts.md', 'blocks-checklists.md', 'blocks-tables.md']),
    );
  });

  it.each(blockFixtures)('keeps $name byte for byte', ({ markdown }) => {
    const collab = openEditor(blocksOf(markdown));
    expect(markdownOf(collab)).toBe(markdown);
  });

  const samples = [
    '| Feature | Status |\n| :- | -: |\n| **Sync** | done |\n| Links | |\n',
    '- [ ] Benchmark\n- [x] Plan\n  - [ ] Nested\n',
    '> [!note] Source of truth\n> D1 is an index.\n\n> [!faq]- Folded\n> Hidden.\n\n> [!todo]+ Open\n> - [ ] A task\n',
    '```ts\nconst a = 1;\n```\n',
  ];

  it.each(samples)('keeps %j byte for byte', (markdown) => {
    const blocks = blocksOf(markdown);
    const collab = openEditor(blocks);
    const content = collab.editor.getJSON().content ?? [];
    // TipTap keeps an empty paragraph after a final block that is not one; markdown drops it.
    expect(content.at(-1)).toEqual({ type: 'paragraph' });
    expect(content.slice(0, -1)).toEqual(blocks);
    expect(markdownOf(collab)).toBe(markdown);
  });
});

describe('table arrow keys', () => {
  it('never puts a gap cursor between two cells', () => {
    const collab = openEditor();
    type(collab.editor.view, '| a | b |\n');
    const { doc } = collab.editor.state;
    const betweenCells = doc.resolve(startOf(collab.editor.view, 'tableHeader', 1) - 1);
    expect(betweenCells.parent.type.name).toBe('tableRow');
    // `valid` is how the gap cursor plugin decides (not in its type declarations).
    const { valid } = GapCursor as unknown as { valid: (pos: typeof betweenCells) => boolean };
    expect(valid(betweenCells)).toBe(false);
  });

  /** Opens a table between two paragraphs; happy-dom has no layout, so every caret is at a cell's edge. */
  function tableNote() {
    const collab = openEditor([paragraph('above')]);
    const { view } = collab.editor;
    select(view, view.state.doc.content.size - 1);
    press(view, 'Enter');
    type(view, '| a | b |\nc\td');
    view.endOfTextblock = () => true;
    return collab;
  }
  const caretText = (collab: Collab) => collab.editor.state.selection.$head.parent.textContent;

  it('moves to the cell below and above, in the same column', () => {
    const collab = tableNote();
    const { view } = collab.editor;
    selectCell(collab, 0, 1);
    press(view, 'ArrowDown');
    expect(caretText(collab)).toBe('d');
    press(view, 'ArrowUp');
    expect(caretText(collab)).toBe('b');
  });

  it('leaves the table below the last row and above the first', () => {
    const collab = tableNote();
    const { view } = collab.editor;
    selectCell(collab, 1, 0);
    press(view, 'ArrowDown');
    expect(collab.editor.state.selection.$head.parent.type.name).toBe('paragraph');
    type(view, 'below');
    selectCell(collab, 0, 0);
    press(view, 'ArrowUp');
    expect(caretText(collab)).toBe('above');
    expect(markdownOf(collab)).toBe('above\n\n| a | b |\n| - | - |\n| c | d |\n\nbelow\n');
  });
});
