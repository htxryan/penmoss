import { describe, expect, it } from 'vitest';
import {
  blocksOf,
  compareRows,
  differs,
  readMarkdown,
  type CompareBlock,
  type CompareRow,
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
