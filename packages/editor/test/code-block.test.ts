import { schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import { NOTE_ROOT } from '@penmoss/sync-client';
import { describe, expect, it, vi } from 'vitest';
import { setNativeClipboard, type NativeClipboardPayload } from '../src/clipboard';
import { DEFER_CHARS, DEFER_MS } from '../src/extensions/code-highlight';
import { CODE_LANGUAGES, codeHighlighter, resolveLanguage } from '../src/extensions/highlight';
import { codeBlock, openEditor, paragraph, press, select, startOf, type } from './support/editor';

const markdownOf = (collab: ReturnType<typeof openEditor>) =>
  serializeMarkdown({ frontmatter: null, doc: coreSchema.nodeFromJSON(collab.editor.getJSON()) });

const tokenClasses = (root: HTMLElement) =>
  [...root.querySelectorAll('[class*="hljs-"]')].map((element) => element.className);

describe('code block input rules', () => {
  it('turns ``` plus Enter into a code block', () => {
    const collab = openEditor();
    const { view } = collab.editor;
    type(view, '```\n');
    expect(collab.editor.getJSON().content?.[0]).toMatchObject({
      type: 'codeBlock',
      attrs: { language: null },
    });
    type(view, 'plain');
    expect(markdownOf(collab)).toBe('```\nplain\n```\n');
  });

  it('keeps the language typed after the fence, including c++ and c#', () => {
    for (const language of ['ts', 'c++', 'c#', 'objective-c']) {
      const collab = openEditor();
      type(collab.editor.view, `\`\`\`${language}\n`);
      expect(collab.editor.getJSON().content?.[0]).toMatchObject({
        type: 'codeBlock',
        attrs: { language },
      });
      collab.destroy();
    }
  });

  it('turns ~~~ plus Enter into a code block that serialises with backticks', () => {
    const collab = openEditor();
    type(collab.editor.view, '~~~py\nprint(1)');
    expect(markdownOf(collab)).toBe('```py\nprint(1)\n```\n');
  });
});

describe('code block indenting', () => {
  const text = (collab: ReturnType<typeof openEditor>) =>
    collab.editor.state.doc.firstChild!.textContent;

  it('inserts an indent at the caret with Tab', () => {
    const collab = openEditor([codeBlock('ab', 'ts')]);
    const { view } = collab.editor;
    select(view, startOf(view, 'codeBlock') + 1);
    expect(press(view, 'Tab')).toBe(true);
    expect(text(collab)).toBe('a  b');
  });

  it('indents and outdents every selected line', () => {
    const collab = openEditor([codeBlock('one\ntwo\nthree', 'ts')]);
    const { view } = collab.editor;
    const start = startOf(view, 'codeBlock');
    select(view, start + 1, start + 6); // "ne\ntw"
    press(view, 'Tab');
    expect(text(collab)).toBe('  one\n  two\nthree');
    press(view, 'Tab', { shiftKey: true });
    expect(text(collab)).toBe('one\ntwo\nthree');
  });

  it('outdents the caret line by one step, or removes a tab character', () => {
    const collab = openEditor([codeBlock('x\n    deep\n\ttabbed', 'ts')]);
    const { view } = collab.editor;
    const start = startOf(view, 'codeBlock');
    select(view, start + 8);
    press(view, 'Tab', { shiftKey: true });
    expect(text(collab)).toBe('x\n  deep\n\ttabbed');
    select(view, start + 12);
    press(view, 'Tab', { shiftKey: true });
    expect(text(collab)).toBe('x\n  deep\ntabbed');
  });

  it('indents code inside a list item instead of nesting the item', () => {
    const collab = openEditor([
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [paragraph('a')] },
          { type: 'listItem', content: [paragraph('b'), codeBlock('x')] },
        ],
      },
    ]);
    const { view } = collab.editor;
    select(view, startOf(view, 'codeBlock'));
    press(view, 'Tab');
    expect(collab.editor.state.doc.firstChild!.childCount).toBe(2);
    expect(view.state.doc.nodeAt(startOf(view, 'codeBlock') - 1)!.textContent).toBe('  x');
  });

  it('leaves Tab alone outside code', () => {
    const collab = openEditor([paragraph('text')]);
    const { view } = collab.editor;
    select(view, 2);
    expect(press(view, 'Tab')).toBe(false);
  });
});

describe('code block highlighting', () => {
  it('offers at least 30 languages, each with a loadable grammar', async () => {
    expect(CODE_LANGUAGES.length).toBeGreaterThanOrEqual(30);
    await Promise.all(CODE_LANGUAGES.map((lang) => codeHighlighter.load(lang.id)));
    for (const lang of CODE_LANGUAGES) {
      expect(codeHighlighter.isLoaded(lang.id), lang.id).toBe(true);
      expect(resolveLanguage(lang.fence)).toBe(lang);
    }
  });

  it('highlights a TypeScript block with highlight.js token classes', async () => {
    const collab = openEditor([codeBlock('const answer: number = 42; // yes', 'ts')]);
    const dom = collab.editor.view.dom;
    await vi.waitFor(() => expect(tokenClasses(dom)).toContain('hljs-keyword'));
    expect(tokenClasses(dom)).toEqual(expect.arrayContaining(['hljs-number', 'hljs-comment']));
    expect(dom.querySelector('code')!.className).toBe('hljs language-typescript');
  });

  it('shows unknown languages as plain text', async () => {
    const collab = openEditor([
      codeBlock('const x = 1', 'klingon'),
      codeBlock('const y = 2', 'js'),
    ]);
    const dom = collab.editor.view.dom;
    await vi.waitFor(() => expect(tokenClasses(dom).length).toBeGreaterThan(0));
    const [unknown] = dom.querySelectorAll('code');
    expect(unknown!.querySelector('[class*="hljs-"]')).toBeNull();
    expect(unknown!.className).toBe('hljs');
  });

  it('re-highlights only the block being edited', async () => {
    await codeHighlighter.load('typescript');
    const collab = openEditor([
      codeBlock('let a = 1', 'ts'),
      paragraph('between'),
      codeBlock('let b = 2', 'ts'),
    ]);
    const { view } = collab.editor;
    const spy = vi.spyOn(codeHighlighter, 'tokens');
    select(view, startOf(view, 'codeBlock', 1) + 9);
    type(view, '3');
    expect(spy.mock.calls.map(([, code]) => code)).toEqual(['let b = 23']);
    spy.mockClear();
    select(view, startOf(view, 'paragraph') + 1);
    type(view, 'x');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('re-highlights a long block after a pause instead of on every keystroke', async () => {
    await codeHighlighter.load('typescript');
    const lines = Array.from(
      { length: 200 },
      (_, i) => `export const value${i} = ${i}; // line ${i}`,
    );
    expect(lines.join('\n').length).toBeGreaterThan(DEFER_CHARS);
    const collab = openEditor([codeBlock(lines.join('\n'), 'ts')]);
    const { view } = collab.editor;
    await vi.waitFor(() => expect(tokenClasses(view.dom).length).toBeGreaterThan(400));
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(codeHighlighter, 'tokens');
      select(view, startOf(view, 'codeBlock'));
      type(view, 'let z = 1;\n');
      expect(spy).not.toHaveBeenCalled();
      // Earlier tokens keep their colours meanwhile.
      expect(tokenClasses(view.dom).length).toBeGreaterThan(400);
      vi.advanceTimersByTime(DEFER_MS + 10);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders without writing to the document', async () => {
    const source = openEditor([codeBlock('const a = 1', 'ts')]);
    const replica = source.replica;
    const target = openEditor();
    const updates: Uint8Array[] = [];
    target.replica.onUpdate((update) => updates.push(update));
    target.replica.applyUpdate(replica.encodeStateAsUpdate(), 'remote');
    const before = updates.length;
    await vi.waitFor(() => expect(tokenClasses(target.editor.view.dom)).toContain('hljs-keyword'));
    expect(updates.length).toBe(before);
    expect(target.replica.doc.get(NOTE_ROOT).length).toBe(replica.doc.get(NOTE_ROOT).length);
  });
});

describe('code block view', () => {
  it('changes the language from the picker', () => {
    const collab = openEditor([codeBlock('x = 1', 'py')]);
    const picker = collab.editor.view.dom.querySelector('select')!;
    expect(picker.value).toBe('python');
    expect(picker.getAttribute('aria-label')).toBe('Code block language');
    picker.value = 'rust';
    picker.dispatchEvent(new Event('change'));
    expect(collab.editor.getJSON().content?.[0]?.attrs).toMatchObject({ language: 'rust' });
  });

  it('keeps an unlisted language selectable', () => {
    const collab = openEditor([codeBlock('x', 'zig')]);
    expect(collab.editor.view.dom.querySelector('select')!.value).toBe('zig');
  });

  it('copies the code through an app shell’s clipboard when there is one (T40 P8, ED7)', async () => {
    const writes: NativeClipboardPayload[] = [];
    setNativeClipboard((payload) => {
      writes.push(payload);
      return Promise.resolve(true);
    });
    try {
      const collab = openEditor([codeBlock('echo hi', 'bash')]);
      const copy = collab.editor.view.dom.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy Code"]',
      )!;
      copy.click();
      await vi.waitFor(() => expect(copy.textContent).toBe('Copied'));
      expect(writes).toEqual([{ text: 'echo hi' }]);
    } finally {
      setNativeClipboard(null);
    }
  });

  it('copies the code to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const collab = openEditor([codeBlock('echo hi', 'bash')]);
      const copy = collab.editor.view.dom.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy Code"]',
      )!;
      copy.click();
      expect(writeText).toHaveBeenCalledWith('echo hi');
      await vi.waitFor(() => expect(copy.textContent).toBe('Copied'));
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
