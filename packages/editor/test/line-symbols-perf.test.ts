/**
 * The cost of line symbols per keystroke (T44 review): the plugin's state update for one typed
 * character in a long note full of symbol lines. Only the changed line is redrawn, and nothing
 * decorates the blocks themselves, so the cost does not grow with the number of symbol lines.
 * Also: the repair guard holds a `selectionOnly` plugin to its word.
 */
import type { JSONContent } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';
import { skipRepairsOfBindingChanges } from '../src/collab/yjs14';
import { lineSymbolsKey } from '../src/extensions/line-symbols';
import { openEditor, paragraph } from './support/editor';

/** Median time of the symbol plugin's `apply` for typing one character at `at`. */
function applyCost(state: EditorState, at: number, runs = 60): number {
  const plugin = state.plugins.find((each) => each.spec.key === lineSymbolsKey)!;
  const apply = plugin.spec.state!.apply;
  const before = lineSymbolsKey.getState(state)!;
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const tr = state.tr.insertText('x', at);
    const after = state.apply(tr);
    const start = performance.now();
    apply.call(plugin, tr, before, state, after);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

/** The start of the `index`th textblock's text. */
function lineStart(state: EditorState, index: number): number {
  let seen = 0;
  let found = -1;
  state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (!node.isTextblock) return true;
    if (seen++ === index) found = pos + 1;
    return false;
  });
  return found;
}

describe('the cost of symbols per keystroke (T44 review)', () => {
  it('stays small in a 3,000-item list with symbols on one item in ten', () => {
    const list: JSONContent = {
      type: 'bulletList',
      content: Array.from({ length: 3000 }, (_, i) => ({
        type: 'listItem',
        content: [paragraph(`${i % 10 === 0 ? '★ ' : ''}Item number ${i} of the list`)],
      })),
    };
    const { editor } = openEditor([list]);
    const state = editor.state;
    expect(editor.view.dom.querySelectorAll('.pm-symbols')).toHaveLength(300);
    const cost = applyCost(state, lineStart(state, 1500) + 4);
    console.info(`[symbols] apply per keystroke, 3,000-item list: ${cost.toFixed(3)} ms`);
    expect(cost).toBeLessThan(1);
  });

  it('stays small in 3,000 paragraphs, 300 of them with symbols', () => {
    const { editor } = openEditor(
      Array.from({ length: 3000 }, (_, i) =>
        paragraph(`${i % 10 === 0 ? '? ' : ''}Paragraph number ${i}`),
      ),
    );
    const state = editor.state;
    const cost = applyCost(state, lineStart(state, 1500) + 4);
    console.info(`[symbols] apply per keystroke, 3,000 paragraphs: ${cost.toFixed(3)} ms`);
    expect(cost).toBeLessThan(1);
  });
});

describe('a selectionOnly plugin (T44 review)', () => {
  it('may move the selection, and is refused a change to the document', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const plugin = skipRepairsOfBindingChanges(
      new Plugin({
        key: new PluginKey('writesAnyway'),
        selectionOnly: true,
        appendTransaction: (_transactions, _old, state) => state.tr.insertText('!', 1),
      }),
    );
    const { editor } = openEditor([paragraph('Text')]);
    const state = editor.state.reconfigure({ plugins: [...editor.state.plugins, plugin] });
    const after = state.applyTransaction(state.tr.insertText('a', 1)).state;
    expect(after.doc.textContent).toBe('aText');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('writesAnyway'));
    error.mockRestore();
  });
});
