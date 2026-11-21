// A wall-clock budget (A1244): `task budgets` runs it, never `task check`. What NoteUsage records
// is unit tested in usage.test.ts; here only what it costs a keystroke (PEN-177): under 1 ms at
// the 95th percentile in a 2,000-block note, typing in its first, middle and last blocks and in
// a long list, with 2× slack on CI's slower runners. Percentiles of many samples, never one.
import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { attachNoteUsage } from '../src/usage';
import { select, type } from './support/editor';
import { FakeClock, h, li, p, ul } from './support/usage';
import { openEditor } from './support/editor';

const SLACK = process.env['CI'] ? 2 : 1;

function note(): JSONContent[] {
  const blocks: JSONContent[] = [];
  for (let i = 0; i < 1700; i++)
    blocks.push(i % 25 === 0 ? h(2, `Part ${i}`) : p(`Line ${i} of the note, with a few words.`));
  blocks.push(ul(...Array.from({ length: 300 }, (_, i) => li(`Item ${i}`))));
  blocks.push(p('End'));
  return blocks;
}

describe('NoteUsage’s cost per keystroke (PEN-177)', () => {
  it('stays under 1 ms at p95 in a 2,000-block note', () => {
    const collab = openEditor(note());
    const editor = collab.editor;
    let started = 0;
    const samples: number[] = [];
    // Listeners run in the order added: these two time NoteUsage's own between them.
    editor.on('transaction', () => {
      started = performance.now();
    });
    const usage = attachNoteUsage(editor, { record: () => undefined, clock: new FakeClock() });
    editor.on('transaction', () => {
      samples.push(performance.now() - started);
    });
    usage.open();
    const view = editor.view;
    const doc = view.state.doc;
    const at = (index: number) => {
      let pos = 0;
      for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
      return pos;
    };
    let listItem = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'Item 250') listItem = pos + 8;
      return listItem === -1;
    });
    for (const start of [at(1) + 2, at(850) + 2, at(1699) + 2, listItem]) {
      select(view, start);
      // A warm-up, then the timed keystrokes.
      type(view, 'warm');
      samples.length = 0;
      for (let i = 0; i < 400; i++) type(view, 'x');
      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
      const median = sorted[Math.floor(sorted.length / 2)]!;
      process.stderr.write(
        `usage keystroke at ${start}: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms\n`,
      );
      expect(p95, `p95 of ${sorted.length} keystrokes at ${start}`).toBeLessThan(1 * SLACK);
    }
    usage.destroy();
  });
});
