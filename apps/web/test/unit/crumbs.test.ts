import { describe, expect, it } from 'vitest';
import { folderTrail } from '../../src/notes/crumbs';

const folders = [
  { id: 'a', name: 'Projects', parentId: null },
  { id: 'b', name: 'Penmoss', parentId: 'a' },
  { id: 'c', name: 'Orphan', parentId: 'gone' },
  { id: 'x', name: 'X', parentId: 'y' },
  { id: 'y', name: 'Y', parentId: 'x' },
];

describe('folderTrail (T36)', () => {
  it('lists the folders outermost first', () => {
    expect(folderTrail(folders, 'b')).toEqual(['Projects', 'Penmoss']);
    expect(folderTrail(folders, 'a')).toEqual(['Projects']);
  });

  it('is empty at the top level and stops at a missing parent', () => {
    expect(folderTrail(folders, null)).toEqual([]);
    expect(folderTrail(folders, 'missing')).toEqual([]);
    expect(folderTrail(folders, 'c')).toEqual(['Orphan']);
  });

  it('never loops on a cycle', () => {
    expect(folderTrail(folders, 'x')).toEqual(['Y', 'X']);
  });
});
