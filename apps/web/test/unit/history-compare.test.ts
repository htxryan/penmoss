import { describe, expect, it } from 'vitest';
import {
  blocksOf,
  compareRows,
  diffItems,
  differs,
  fullItems,
  readMarkdown,
  unchangedLines,
  type CompareBlock,
  type CompareRow,
  type DiffItem,
} from '../../src/history/compare';

// View This Version (A1572): a version beside the note as it is now, block by block, paired
// into rows so the two sides stay level, the blocks that differ tinted on each side.

/** A row as words: the change, then each side's text ('·' for a gap). */
function shape(rows: readonly CompareRow[]): string[] {
  const text = (block: CompareBlock | null) =>
    block === null
      ? '·'
      : block.kind === 'title'
        ? `# ${block.text}`
        : (JSON.stringify(block.json).match(/"text":"([^"]*)"/)?.[1] ?? '?');
  return rows.map((row) => `${row.change} ${text(row.left)} | ${text(row.right)}`);
}

async function compare(version: string, now: string) {
  return compareRows(blocksOf(await readMarkdown(version)), blocksOf(await readMarkdown(now)));
}

const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}`;

describe('View This Version: pairing the blocks (A1572)', () => {
  it('pairs every block when nothing changed, and says the two are the same', async () => {
    const markdown = note('Trip', 'Book the train\n\n## Packing\n\nSocks');
    const rows = await compare(markdown, markdown);
    expect(shape(rows)).toEqual([
      'same # Trip | # Trip',
      'same Book the train | Book the train',
      'same Packing | Packing',
      'same Socks | Socks',
    ]);
    expect(differs(rows)).toBe(false);
  });

  it('puts a block replaced since beside what replaced it, tinted on both sides', async () => {
    const rows = await compare(
      note('Trip', 'Book the train\n\nSocks'),
      note('Trip', 'Fly instead\n\nSocks'),
    );
    expect(shape(rows)).toEqual([
      'same # Trip | # Trip',
      'changed Book the train | Fly instead',
      'same Socks | Socks',
    ]);
    expect(differs(rows)).toBe(true);
  });

  it('holds a gap open beside a block only one side has', async () => {
    const rows = await compare(
      note('Trip', 'One\n\nTwo\n\nThree'),
      note('Trip', 'One\n\nThree\n\nFour'),
    );
    expect(shape(rows)).toEqual([
      'same # Trip | # Trip',
      'same One | One',
      'removed Two | ·',
      'same Three | Three',
      'added · | Four',
    ]);
  });

  it('pairs a run of changes in order, the longer side’s rest on rows of its own', async () => {
    const rows = await compare(note('T', 'A\n\nB\n\nC\n\nEnd'), note('T', 'X\n\nEnd'));
    expect(shape(rows)).toEqual([
      'same # T | # T',
      'changed A | X',
      'removed B | ·',
      'removed C | ·',
      'same End | End',
    ]);
  });

  it('marks a changed title', async () => {
    const rows = await compare(note('Trip', 'Body'), note('Holiday', 'Body'));
    expect(shape(rows)).toEqual(['changed # Trip | # Holiday', 'same Body | Body']);
  });

  it('compares a list item by item, so checking one off tints that one alone', async () => {
    const version = note('Roadmap', '- [ ] Tags page\n- [ ] History by day\n- [ ] Sync banner');
    const now = note('Roadmap', '- [x] Tags page\n- [ ] History by day\n- [ ] Sync banner');
    const rows = await compare(version, now);
    expect(rows.map((row) => row.change)).toEqual(['same', 'changed', 'same', 'same']);
    // Each item is a list of one, as the note draws it.
    const item = rows[1]!.right;
    expect(item?.kind === 'block' && item.json.type).toBe('taskList');
    expect(item?.kind === 'block' && item.json.content).toHaveLength(1);
  });

  it('numbers an ordered list’s items as the list does, without the number marking them', async () => {
    const rows = await compare(
      note('T', '1. One\n2. Two\n3. Three'),
      note('T', '1. Zero\n2. One\n3. Two\n4. Three'),
    );
    expect(rows.map((row) => row.change)).toEqual(['same', 'added', 'same', 'same', 'same']);
    const starts = rows
      .map((row) => row.right)
      .flatMap((block) => (block?.kind === 'block' ? [block.json.attrs?.['start']] : []));
    expect(starts).toEqual([1, 2, 3, 4]);
  });

  it('shows a note with no title from its first block', async () => {
    const rows = await compare('Just text', 'Just text, and more');
    expect(shape(rows)).toEqual(['changed Just text | Just text, and more']);
  });
});

/** Diff's items as words: `row 3` for a row by its index, `fold 0-4 (9)` for a fold. */
function items(list: readonly DiffItem[]): string[] {
  return list.map((item) =>
    item.kind === 'row' ? `row ${item.index}` : `fold ${item.from}-${item.to} (${item.lines})`,
  );
}

/** A note of `count` paragraphs, `P1` to `Pn`, one per line with a blank line between. */
const paragraphs = (count: number, change?: { at: number; to: string }) =>
  Array.from({ length: count }, (_, i) => (change?.at === i + 1 ? change.to : `P${i + 1}`)).join(
    '\n\n',
  );

describe('View This Version: Diff, the changes with context (A1572)', () => {
  it('keeps 3 rows of context around a change, and folds the rest on each side', async () => {
    // Row 0 the title, rows 1–20 the paragraphs; P10 (row 10) changed.
    const rows = await compare(
      note('T', paragraphs(20)),
      note('T', paragraphs(20, { at: 10, to: 'Ten' })),
    );
    expect(items(diffItems(rows))).toEqual([
      // The title (line 2) to P6 (line 15; paragraph n is on line 2n + 3).
      'fold 0-6 (14)',
      'row 7',
      'row 8',
      'row 9',
      'row 10',
      'row 11',
      'row 12',
      'row 13',
      // P14 (line 31) to P20 (line 43).
      'fold 14-20 (13)',
    ]);
  });

  it('merges changes whose context overlaps into one hunk, with no fold between', async () => {
    const version = note('T', paragraphs(30));
    const now = note('T', paragraphs(30, { at: 10, to: 'Ten' }).replace('P15', 'Fifteen'));
    const list = items(diffItems(await compare(version, now)));
    // Rows 7 to 18 in one run: 10's context reaches 13, 15's starts at 12.
    expect(list).toEqual([
      'fold 0-6 (14)',
      ...Array.from({ length: 12 }, (_, i) => `row ${i + 7}`),
      'fold 19-30 (23)',
    ]);
  });

  it('puts a fold between two hunks far apart, and opens it by its first row', async () => {
    const version = note('T', paragraphs(30));
    const now = note('T', paragraphs(30, { at: 5, to: 'Five' }).replace('P25', 'Twenty-five'));
    const rows = await compare(version, now);
    const folded = items(diffItems(rows));
    expect(folded).toContain('fold 9-21 (25)');
    expect(folded.filter((item) => item.startsWith('fold'))).toEqual([
      'fold 0-1 (4)',
      'fold 9-21 (25)',
      'fold 29-30 (3)',
    ]);
    const opened = items(diffItems(rows, new Set([9])));
    expect(opened).not.toContain('fold 9-21 (25)');
    expect(opened.filter((item) => item.startsWith('row')).length).toBe(
      folded.filter((item) => item.startsWith('row')).length + 13,
    );
    expect(opened).toContain('fold 0-1 (4)');
  });

  it('has nothing to show when nothing changed, and Full File shows every row', async () => {
    const markdown = note('T', paragraphs(5));
    const rows = await compare(markdown, markdown);
    expect(diffItems(rows)).toEqual([]);
    expect(items(fullItems(rows))).toEqual(['row 0', 'row 1', 'row 2', 'row 3', 'row 4', 'row 5']);
  });

  it('shows every row when a change is within 3 rows of both ends', async () => {
    const rows = await compare(note('T', 'A\n\nB\n\nC'), note('T', 'A\n\nX\n\nC'));
    expect(items(diffItems(rows))).toEqual(['row 0', 'row 1', 'row 2', 'row 3']);
  });

  it('counts a fold’s lines from its first block’s first line to its last’s last', async () => {
    const markdown = note('T', 'One\nstill one\n\n- a\n- b\n\nEnd');
    const rows = await compare(markdown, markdown);
    // The title (line 2), "One" (5–6), the items (8, 9), "End" (11).
    expect(unchangedLines(rows, 1, 3)).toBe(5);
    expect(unchangedLines(rows, 0, 4)).toBe(10);
    expect(unchangedLines(rows, 4, 4)).toBe(1);
  });
});

describe('View This Version: line numbers (A1572)', () => {
  it('numbers each block by its first line in the markdown, the frontmatter counted', async () => {
    const markdown = `---\ntitle: Trip\ntags: [travel]\n---\n\n# Plan\n\nBook the train\nand a seat\n\n- [ ] Socks\n- [x] Hat\n- Scarf\n\n\`\`\`\nmake\n\`\`\`\n\n3. Third\n4. Fourth\n`;
    const blocks = blocksOf(await readMarkdown(markdown));
    expect(blocks.map((block) => [block.kind, block.lines?.start, block.lines?.end])).toEqual([
      ['title', 2, 2],
      ['block', 6, 6],
      ['block', 8, 9],
      // A list of task items then a plain one: two lists, each item its own line.
      ['block', 11, 11],
      ['block', 12, 12],
      ['block', 13, 13],
      ['block', 15, 17],
      ['block', 19, 19],
      ['block', 20, 20],
    ]);
  });

  it('keeps each side’s own numbers in a row, the gap side with none', async () => {
    const rows = await compare(note('T', 'One\n\nThree'), note('T', 'One\n\nTwo\n\nThree'));
    expect(
      rows.map((row) => [
        row.change,
        row.left?.lines?.start ?? null,
        row.right?.lines?.start ?? null,
      ]),
    ).toEqual([
      ['same', 2, 2],
      ['same', 5, 5],
      ['added', null, 7],
      ['same', 7, 9],
    ]);
  });

  it('has no title line without a title, and still numbers the body', async () => {
    const blocks = blocksOf(await readMarkdown('Just text\n\nMore'));
    expect(blocks.map((block) => block.lines?.start)).toEqual([1, 3]);
  });
});
