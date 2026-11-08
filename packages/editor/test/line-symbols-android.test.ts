/**
 * Line symbols on Chrome for Android (T44 review B1, A745): the soft keyboard's Enter is not a
 * key ProseMirror can stop. The browser splits the paragraph itself, and ProseMirror's DOM
 * observer, while it reads that change, sends a made-up Enter to `handleKeyDown`. The symbol
 * plugin must not read the DOM again inside that read: it would take the half-split selection
 * and the editor's Enter would split the line in the wrong place.
 *
 * ProseMirror decides it is on Android when its module loads, so the user agent is set first.
 */
import { vi, describe, expect, it } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    get: () =>
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });
});

import type { EditorView } from '@tiptap/pm/view';
import { lineSymbolsKey } from '../src/extensions/line-symbols';
import { openEditor, paragraph, select } from './support/editor';

const lines = (view: EditorView) => {
  const out: string[] = [];
  view.state.doc.descendants((node) => {
    if (!node.isTextblock) return true;
    out.push(node.textContent);
    return false;
  });
  return out;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Internals {
  domObserver: { flush(): void };
  input: { lastKeyCode: number | null; lastKeyCodeTime: number };
}

/**
 * Enter on Android's keyboard at `offset` into the line `text`: the key event ProseMirror lets
 * through (keyCode 13), then the browser's own split of the paragraph, read by the observer.
 */
async function androidEnter(view: EditorView, text: string, offset: number): Promise<void> {
  let start = -1;
  view.state.doc.descendants((node, pos) => {
    if (start < 0 && node.isTextblock && node.textContent === text) start = pos + 1;
    return start < 0;
  });
  view.focus();
  select(view, start + offset);
  await wait(30);
  const internals = view as unknown as Internals;
  internals.domObserver.flush();
  internals.input.lastKeyCode = 13;
  internals.input.lastKeyCodeTime = Date.now();
  // What Chrome does: the paragraph splits at the caret, which goes to the new one.
  const paragraphs = [...view.dom.querySelectorAll('p')];
  const line = paragraphs.find((element) => element.textContent?.includes(text.slice(-4)))!;
  const node = [...line.childNodes].findLast((child) => child.nodeType === Node.TEXT_NODE) as Text;
  const shown = node.data.length - (text.length - offset);
  const rest = node.splitText(shown);
  const next = document.createElement('p');
  next.append(rest);
  line.after(next);
  window.getSelection()!.collapse(rest, 0);
  internals.domObserver.flush();
  await wait(80);
}

describe('Enter from Android’s keyboard (T44 review B1)', () => {
  it('splits a plain line where the caret is, with the symbol plugin on', async () => {
    const { editor } = openEditor([
      paragraph('Above'),
      paragraph('HelloWorld'),
      paragraph('Below'),
    ]);
    expect(editor.state.plugins.some((plugin) => plugin.spec.key === lineSymbolsKey)).toBe(true);
    await androidEnter(editor.view, 'HelloWorld', 5);
    expect(lines(editor.view).slice(0, 4)).toEqual(['Above', 'Hello', 'World', 'Below']);
    expect(editor.state.selection.$head.parent.textContent).toBe('World');
    expect(editor.state.selection.$head.parentOffset).toBe(0);
  });

  it('splits a symbol line in its text, the symbols staying on the first half', async () => {
    const { editor } = openEditor([
      paragraph('Above'),
      paragraph('★ HelloWorld'),
      paragraph('Below'),
    ]);
    await androidEnter(editor.view, '★ HelloWorld', 7);
    expect(lines(editor.view).slice(0, 4)).toEqual(['Above', '★ Hello', 'World', 'Below']);
    expect(editor.state.selection.$head.parent.textContent).toBe('World');
  });
});
