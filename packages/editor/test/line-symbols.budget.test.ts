/**
 * The cost of line symbols per keystroke (T44 review): the plugin's state update for one typed
 * character in a long note full of symbol lines. Only the changed line is redrawn, and nothing
 * decorates the blocks themselves, so the cost does not grow with the number of symbol lines.
 * A wall-clock budget (A1244): `task budgets` runs it, never
 * `task check`. The repair guard's test that was here is line-symbols-repair.test.ts.
 */
import type { JSONContent } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
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
