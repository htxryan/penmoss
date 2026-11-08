import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { BACKSPACE_INTO_TITLE, type BackspaceIntoTitleDetail } from '../src';
import { openEditor, paragraph, press, select, startOf } from './support/editor';

// T64 item 6: Backspace at the start of the first line hands it to the title.

function listen(collab: ReturnType<typeof openEditor>, take = true) {
  const seen: string[] = [];
  collab.editor.view.dom.addEventListener(BACKSPACE_INTO_TITLE, (event) => {
    seen.push((event as CustomEvent<BackspaceIntoTitleDetail>).detail.text);
    if (take) event.preventDefault();
  });
  return seen;
}

const texts = (collab: ReturnType<typeof openEditor>) =>
  (collab.editor.getJSON().content ?? []).map((node: JSONContent) =>
    (node.content ?? []).map((child) => child.text ?? '').join(''),
  );

describe('Backspace at the start of the first line (T64 item 6)', () => {
  it('gives an empty first line to the title and removes it', () => {
    const collab = openEditor([paragraph(), paragraph('second')]);
    const seen = listen(collab);
    const { view } = collab.editor;
    view.focus();
    select(view, 1);
    expect(press(view, 'Backspace')).toBe(true);
    expect(seen).toEqual(['']);
    expect(texts(collab)[0]).toBe('second');
  });

  it('gives a first line of text to the title, to join it', () => {
    const collab = openEditor([paragraph('more title'), paragraph('body')]);
    const seen = listen(collab);
    const { view } = collab.editor;
    view.focus();
    select(view, 1);
    press(view, 'Backspace');
    expect(seen).toEqual(['more title']);
    expect(texts(collab)[0]).toBe('body');
  });

  it('keeps the line when nothing takes it, and anywhere but the very start', () => {
    const collab = openEditor([paragraph('one'), paragraph('two')]);
    const seen = listen(collab, false);
    const { view } = collab.editor;
    view.focus();
    select(view, 1);
    press(view, 'Backspace');
    expect(texts(collab).slice(0, 2)).toEqual(['one', 'two']);
    const taker = openEditor([paragraph('one'), paragraph('two')]);
    const taken = listen(taker);
    taker.editor.view.focus();
    select(taker.editor.view, startOf(taker.editor.view, 'paragraph', 1));
    press(taker.editor.view, 'Backspace');
    expect(taken).toEqual([]);
    expect(texts(taker)[0]).toBe('onetwo');
    expect(seen).toEqual(['one']);
  });

  it('leaves a heading first line to Backspace’s usual meaning', () => {
    const collab = openEditor([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Head' }] },
    ]);
    const seen = listen(collab);
    collab.editor.view.focus();
    select(collab.editor.view, 1);
    press(collab.editor.view, 'Backspace');
    expect(seen).toEqual([]);
  });
});
