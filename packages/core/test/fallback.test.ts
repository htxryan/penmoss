import { describe, expect, it } from 'vitest';
import { folderFallback, type FolderRecord } from '../src/workspace';

const folder = (id: string, parentId: string | null): FolderRecord => ({
  id,
  name: id,
  parentId,
  position: 'a0',
  sortMode: 'manual',
});

describe('where something meant for a gone folder goes', () => {
  const folders = [
    folder('work', null),
    folder('proj', 'work'),
    folder('home', null),
    // Made offline under a folder another device deleted.
    folder('secret', 'gone-proj'),
  ];
  const gone = [
    { id: 'gone-proj', parentId: 'work' },
    { id: 'gone-sub', parentId: 'gone-proj' },
    { id: 'gone-home', parentId: 'home' },
    { id: 'gone-top', parentId: null },
    { id: 'loop-a', parentId: 'loop-b' },
    { id: 'loop-b', parentId: 'loop-a' },
    // A record of a folder that is back in the tree: the tree wins.
    { id: 'proj', parentId: 'gone-top' },
  ];
  const fallback = (id: string | null) => folderFallback(folders, gone, id);

  it('keeps a folder that is in the tree, and the top level', () => {
    expect(fallback(null)).toEqual({ folderId: null });
    expect(fallback('proj')).toEqual({ folderId: 'proj' });
    // A live folder is a place even while its own parent is gone.
    expect(fallback('secret')).toEqual({ folderId: 'secret' });
  });

  it('goes up through Trash to the nearest folder still there, else the top level', () => {
    expect(fallback('gone-proj')).toEqual({ folderId: 'work' });
    expect(fallback('gone-sub')).toEqual({ folderId: 'work' });
    expect(fallback('gone-home')).toEqual({ folderId: 'home' });
    expect(fallback('gone-top')).toEqual({ folderId: null });
  });

  it('knows no place when Trash forgets a folder on the way up, or its records loop', () => {
    expect(fallback('never-heard-of')).toEqual({ refused: 'unknown' });
    expect(fallback('loop-a')).toEqual({ refused: 'unknown' });
  });
});
