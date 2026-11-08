import { schema } from '@penmoss/core';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { changedNodes, changedRanges } from '../src/extensions/changes';

function paragraphs(...texts: string[]) {
  return schema.node(
    'doc',
    null,
    texts.map((text) => schema.node('paragraph', null, text ? [schema.text(text)] : [])),
  );
}

/** Applies `build` to successive states, returning the transactions in order. */
function run(doc = paragraphs('one', 'two', 'three'), ...builds: ((tr: Transaction) => void)[]) {
  let state = EditorState.create({ doc });
  const transactions: Transaction[] = [];
  for (const build of builds) {
    const tr = state.tr;
    build(tr);
    transactions.push(tr);
    state = state.apply(tr);
  }
  return { transactions, doc: state.doc };
}

function covers(ranges: [number, number][], from: number, to: number): boolean {
  return ranges.some(([a, b]) => a <= from && to <= b);
}

describe('changedRanges', () => {
  it('maps earlier changes through later steps and transactions', () => {
    // "one" at 1..4, "two" at 6..9, "three" at 11..16.
    const { transactions, doc } = run(
      undefined,
      (tr) => tr.insertText('X', 12).insertText('Y', 1),
      (tr) => tr.insertText('ZZ', 1),
    );
    expect(doc.textBetween(0, doc.content.size, '|')).toBe('ZZYone|two|tXhree');
    const ranges = changedRanges(transactions);
    const x = doc.textBetween(0, doc.content.size).indexOf('X');
    expect(doc.textBetween(15, 16)).toBe('X');
    expect(x).toBeGreaterThan(0);
    expect(covers(ranges, 15, 16)).toBe(true);
    expect(covers(ranges, 1, 4)).toBe(true);
    expect(covers(ranges, 7, 10)).toBe(false);
  });

  it('keeps attribute changes and points deletions at the join', () => {
    const doc = schema.node('doc', null, [
      schema.node('codeBlock', { language: 'js' }, [schema.text('a')]),
      schema.node('paragraph', null, [schema.text('bcdef')]),
    ]);
    const { transactions } = run(
      doc,
      (tr) => tr.setNodeAttribute(0, 'language', 'ts'),
      (tr) => tr.delete(5, 7),
    );
    const ranges = changedRanges(transactions);
    expect(covers(ranges, 0, 1)).toBe(true);
    expect(covers(ranges, 5, 5)).toBe(true);
  });

  it('finds every one of many separate changes in one transaction', () => {
    const texts = Array.from({ length: 500 }, () => 'ab');
    const { transactions, doc } = run(paragraphs(...texts), (tr) => {
      // Paragraph i starts at 4i; the i earlier inserts shift it by i.
      for (let i = 0; i < 500; i += 1) tr.insertText('x', 1 + i * 5);
    });
    const found = changedNodes(doc, transactions, (node) => node.type.name === 'paragraph');
    expect(found.size).toBe(500);
  });

  it('stays linear in the number of steps', () => {
    const { transactions, doc } = run(paragraphs('start', 'end'), (tr) => {
      for (let i = 0; i < 20_000; i += 1) tr.insertText('x', 3 + i);
    });
    const started = performance.now();
    const ranges = changedRanges(transactions);
    expect(performance.now() - started).toBeLessThan(250);
    expect(covers(ranges, 3, 20_003)).toBe(true);
    expect(covers(ranges, 1, 3)).toBe(false);
    expect(doc.childCount).toBe(2);
  });
});
