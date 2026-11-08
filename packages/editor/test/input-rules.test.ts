import { schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import { describe, expect, it } from 'vitest';
import { openEditor, press, type } from './support/editor';

// FR-ED-2 (T14): a markdown shortcut for every block and inline mark. Each case
// types into an empty note, as a user would, and checks the note's markdown.

const markdownOf = (collab: ReturnType<typeof openEditor>) =>
  serializeMarkdown({ frontmatter: null, doc: coreSchema.nodeFromJSON(collab.editor.getJSON()) });

function typed(text: string): string {
  const collab = openEditor();
  type(collab.editor.view, text);
  const markdown = markdownOf(collab);
  collab.destroy();
  return markdown;
}

describe('block shortcuts', () => {
  it.each([
    ['# ', 'Title', '# Title\n'],
    ['## ', 'Section', '## Section\n'],
    ['### ', 'Sub', '### Sub\n'],
    ['###### ', 'Six', '###### Six\n'],
    ['- ', 'dash', '- dash\n'],
    ['* ', 'star', '- star\n'],
    ['+ ', 'plus', '- plus\n'],
    ['1. ', 'one', '1. one\n'],
    ['3. ', 'three', '3. three\n'],
    ['- [ ] ', 'task', '- [ ] task\n'],
    ['- [x] ', 'done', '- [x] done\n'],
    ['[ ] ', 'bare task', '- [ ] bare task\n'],
    ['> ', 'quoted', '> quoted\n'],
    ['> [!note] ', 'callout body', '> [!note]\n> callout body\n'],
    ['> [!warning] ', 'careful', '> [!warning]\n> careful\n'],
    ['> [!faq]- ', 'hidden', '> [!faq]-\n> hidden\n'],
    ['> [!tip]+ ', 'open', '> [!tip]+\n> open\n'],
    ['```\n', 'plain', '```\nplain\n```\n'],
    ['```ts\n', 'let a', '```ts\nlet a\n```\n'],
    ['```mermaid\n', 'graph TD', '```mermaid\ngraph TD\n```\n'],
    ['~~~py\n', 'x = 1', '```py\nx = 1\n```\n'],
  ])('%j then %j', (shortcut, text, markdown) => {
    expect(typed(shortcut + text)).toBe(markdown);
  });

  // A rule that opens a note is written `***`, so it is not read as frontmatter (normalisation rule 7).
  it('turns --- into a divider with a paragraph after it', () => {
    expect(typed('---after')).toBe('***\n\nafter\n');
    expect(typed('before\n---after')).toBe('before\n\n---\n\nafter\n');
  });

  it('turns *** and ___ plus space into a divider', () => {
    expect(typed('before\n*** after')).toBe('before\n\n---\n\nafter\n');
    expect(typed('before\n___ after')).toBe('before\n\n---\n\nafter\n');
  });

  it('turns a typed header row plus Enter into a table', () => {
    expect(typed('| a | b |\n1\t2')).toBe('| a | b |\n| - | - |\n| 1 | 2 |\n');
  });

  it('turns $$ plus Enter into a block formula', () => {
    const collab = openEditor();
    type(collab.editor.view, '$$\n');
    expect(collab.editor.getJSON().content?.[0]).toEqual({
      type: 'blockMath',
      attrs: { latex: '' },
    });
  });

  it('nests shortcuts: a heading inside a quote, a list inside a callout', () => {
    expect(typed('> ## Quoted heading')).toBe('> ## Quoted heading\n');
    expect(typed('> [!note] - item')).toBe('> [!note]\n> - item\n');
  });
});

describe('inline mark shortcuts', () => {
  it.each([
    ['**bold** ', 'a **bold** b\n'],
    ['__bold__ ', 'a **bold** b\n'],
    ['*italic* ', 'a *italic* b\n'],
    ['_italic_ ', 'a *italic* b\n'],
    ['`code` ', 'a `code` b\n'],
    ['~~strike~~ ', 'a ~~strike~~ b\n'],
    ['==highlight== ', 'a ==highlight== b\n'],
    ['$x^2$ ', 'a $x^2$ b\n'],
    ['[Penmoss](https://penmoss.app) ', 'a [Penmoss](https://penmoss.app) b\n'],
  ])('%j', (text, markdown) => {
    expect(typed(`a ${text}b`)).toBe(markdown);
  });

  it('turns typed image markdown with a web address into an image (B6)', () => {
    expect(typed('a ![x](https://example.com/a.jpg) b')).toBe(
      'a ![x](https://example.com/a.jpg) b\n',
    );
    const collab = openEditor();
    type(collab.editor.view, '![x](https://example.com/a.jpg)');
    expect(collab.editor.getJSON().content?.[0]?.content?.[0]?.type).toBe('image');
    collab.destroy();
    // Not an image: escaped, or anything but a web address.
    for (const text of ['\\![x](https://example.com/a.jpg)', '![x](notes/a.png)']) {
      const plain = openEditor();
      type(plain.editor.view, text);
      expect(plain.editor.state.doc.textContent).toBe(text);
      plain.destroy();
    }
  });

  it('leaves a markdown link to anything but a web or mail address as text', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'notes/a.md']) {
      const collab = openEditor();
      type(collab.editor.view, `[x](${href}) `);
      const marks = collab.editor
        .getJSON()
        .content?.[0]?.content?.flatMap((node): unknown[] => node.marks ?? []);
      expect(marks).toEqual([]);
      expect(collab.editor.state.doc.textContent).toBe(`[x](${href}) `);
      collab.destroy();
    }
  });

  it('keeps typing outside a mark once it is closed', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '==marked== plain');
    const marks = collab.editor.getJSON().content?.[0]?.content?.map((node) => node.marks);
    expect(marks).toEqual([[{ type: 'highlight' }], undefined]);
  });

  it('toggles highlight with Mod-Shift-H', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, 'word');
    collab.editor.commands.selectAll();
    // happy-dom is not a Mac, so Mod is Ctrl.
    press(view, 'h', { shiftKey: true, ctrlKey: true });
    expect(collab.editor.isActive('highlight')).toBe(true);
  });
});
