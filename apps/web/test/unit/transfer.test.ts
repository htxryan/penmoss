import { buildTree } from '@penmoss/core/workspace';
import { describe, expect, it } from 'vitest';
import { copyTitle, itemsCount, topItems } from '../../src/workspace/transfer';

describe("Duplicate's title (T68, #227)", () => {
  it('is "(copy)", then the next free number from the same base', () => {
    expect(copyTitle('Plan', ['Plan'])).toBe('Plan (copy)');
    expect(copyTitle('Plan', ['Plan', 'Plan (copy)'])).toBe('Plan (copy 2)');
    expect(copyTitle('Plan', ['Plan', 'Plan (copy)', 'Plan (copy 2)'])).toBe('Plan (copy 3)');
    // A copy of a copy counts from the same base.
    expect(copyTitle('Plan (copy)', ['Plan', 'Plan (copy)'])).toBe('Plan (copy 2)');
    expect(copyTitle('Plan (copy 2)', ['Plan (copy 2)', 'Plan (copy 7)'])).toBe('Plan (copy 8)');
    // Other notes that only start alike do not count.
    expect(copyTitle('Plan', ['Plans (copy)', 'Plan B (copy 4)'])).toBe('Plan (copy)');
    expect(copyTitle('', [])).toBe('Untitled (copy)');
  });
});

describe('what goes to another notebook (T68, #230)', () => {
  const folder = (id: string, parentId: string | null, position: string) => ({
    id,
    name: id,
    parentId,
    position,
    sortMode: 'manual' as const,
  });
  const note = (id: string, folderId: string | null, position: string) => ({
    id,
    folderId,
    position,
    title: id,
    updatedAt: 0,
  });
  const tree = buildTree(
    [folder('A', null, 'a'), folder('B', 'A', 'a'), folder('C', null, 'b')],
    [note('n1', 'B', 'a'), note('n2', null, 'a'), note('n3', 'C', 'a')],
    'manual',
  );

  it('leaves out what a picked folder already takes', () => {
    expect(
      topItems(tree, [
        { kind: 'folder', id: 'A' },
        { kind: 'folder', id: 'B' },
        { kind: 'note', id: 'n1' },
        { kind: 'note', id: 'n2' },
        { kind: 'note', id: 'n3' },
        { kind: 'note', id: 'n2' },
      ]),
    ).toEqual([
      { kind: 'folder', id: 'A' },
      { kind: 'note', id: 'n2' },
      { kind: 'note', id: 'n3' },
    ]);
  });

  it('names what moved', () => {
    expect(itemsCount(1, 0)).toBe('1 note');
    expect(itemsCount(0, 2)).toBe('2 folders');
    expect(itemsCount(2, 1)).toBe('2 notes and 1 folder');
  });
});
