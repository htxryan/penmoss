// T49 (A790): the feedback form's description editor, a reduced Penmoss schema whose markdown is
// the notes' serialiser's. Each case types or formats as a person would and checks the markdown
// GitHub receives.
import type { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFeedbackEditor,
  feedbackDoc,
  feedbackMarkdown,
  FEEDBACK_FORMATS,
  FEEDBACK_MARKS,
  FEEDBACK_NODES,
  isEmptyDescription,
  setFeedbackLink,
} from '../src/feedback';
import { press, select, type } from './support/editor';

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function open(content: Parameters<typeof createFeedbackEditor>[0]['content'] = null): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = createFeedbackEditor({ element, content, label: 'Description' });
  editors.push(editor);
  return editor;
}

const markdown = (editor: Editor) => feedbackMarkdown(editor.getJSON());
const format = (id: string) => FEEDBACK_FORMATS.find((item) => item.id === id)!;

describe('the reduced schema (A790)', () => {
  it('has only what GitHub markdown keeps, and every node and mark is core’s', () => {
    const editor = open();
    expect(Object.keys(editor.schema.nodes).sort()).toEqual([...FEEDBACK_NODES].sort());
    expect(Object.keys(editor.schema.marks).sort()).toEqual([...FEEDBACK_MARKS].sort());
  });

  it('is labelled for screen readers as a multi-line text box', () => {
    const editor = open();
    const dom = editor.view.dom;
    expect(dom.getAttribute('role')).toBe('textbox');
    expect(dom.getAttribute('aria-multiline')).toBe('true');
    expect(dom.getAttribute('aria-label')).toBe('Description');
  });
});

describe('the description as markdown', () => {
  it('writes bold, italic, inline code and a link', async () => {
    const editor = open();
    type(editor.view, 'It **broke** on _Tuesday_ in `sync` ');
    setFeedbackLink(editor, 'https://example.com/a');
    expect(await markdown(editor)).toBe(
      // A link whose text is its address is written as an autolink, as notes are.
      'It **broke** on *Tuesday* in `sync` <https://example.com/a>',
    );
  });

  it('writes bulleted and numbered lists, nested with Tab', async () => {
    const editor = open();
    type(editor.view, '- one\n');
    press(editor.view, 'Tab');
    // Enter on an empty nested item brings it back out a level; on an empty item, out of the list.
    type(editor.view, 'inner\n\ntwo\n\n1. first\nsecond');
    expect(await markdown(editor)).toBe('- one\n  - inner\n- two\n\n1. first\n2. second');
  });

  it('writes a quote and a code block', async () => {
    const editor = open();
    type(editor.view, '> quoted\n');
    press(editor.view, 'Enter');
    type(editor.view, '```\nlet a = 1');
    expect(await markdown(editor)).toBe('> quoted\n\n```\nlet a = 1\n```');
  });

  it('formats the selection from the toolbar, and nests from it too', async () => {
    const editor = open();
    type(editor.view, 'word');
    select(editor.view, 1, 5);
    format('bold').run(editor);
    expect(format('bold').active(editor)).toBe(true);
    format('italic').run(editor);
    expect(await markdown(editor)).toBe('***word***');
    format('bulletList').run(editor);
    expect(await markdown(editor)).toBe('- ***word***');
    format('orderedList').run(editor);
    expect(await markdown(editor)).toBe('1. ***word***');
    format('orderedList').run(editor);
    expect(await markdown(editor)).toBe('***word***');
    format('blockquote').run(editor);
    expect(await markdown(editor)).toBe('> ***word***');
    format('codeBlock').run(editor);
    expect(await markdown(editor)).toBe('> ```\n> word\n> ```');
  });

  it('has no underline: Mod-U does nothing', async () => {
    const editor = open();
    type(editor.view, 'plain');
    select(editor.view, 1, 6);
    press(editor.view, 'u', { ctrlKey: true, metaKey: true });
    expect(await markdown(editor)).toBe('plain');
  });

  it('refuses a link that is not http, https or mailto, and removes one', async () => {
    const editor = open();
    type(editor.view, 'here');
    select(editor.view, 1, 5);
    expect(setFeedbackLink(editor, 'javascript:alert(1)')).toBe(false);
    expect(setFeedbackLink(editor, 'mailto:ryan@example.com')).toBe(true);
    expect(await markdown(editor)).toBe('[here](mailto:ryan@example.com)');
    select(editor.view, 2, 2);
    setFeedbackLink(editor, '');
    expect(await markdown(editor)).toBe('here');
  });

  it('is empty for an empty or blank editor', async () => {
    const editor = open();
    expect(isEmptyDescription(editor.getJSON())).toBe(true);
    expect(await markdown(editor)).toBe('');
    type(editor.view, '   ');
    expect(await markdown(editor)).toBe('');
  });
});

describe('drafts', () => {
  it('opens a saved description as it was', async () => {
    const first = open();
    type(first.view, '- a **b**');
    const saved = first.getJSON();
    const again = open(saved);
    expect(await markdown(again)).toBe('- a **b**');
  });

  it('starts empty from a draft that does not fit the schema', () => {
    const editor = open({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'x' }] }],
    });
    expect(isEmptyDescription(editor.getJSON())).toBe(true);
    expect(() => feedbackDoc({ type: 'doc', content: [{ type: 'table' }] })).toThrow(
      /Not in a description/,
    );
  });
});
