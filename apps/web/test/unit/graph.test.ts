import type { FolderRecord } from '@penmoss/core/workspace';
import { describe, expect, it } from 'vitest';
import { GraphInputCache, graphInput, topLevelOf } from '../../src/graph/data';
import { graphPath } from '../../src/graph/path';
import type { LocalLinks } from '../../src/notes/service';

const folder = (id: string, parentId: string | null, position: string): FolderRecord => ({
  id,
  name: id.toUpperCase(),
  parentId,
  position,
  sortMode: 'manual',
});

const link = (noteId: string | null) => ({
  noteId,
  target: 'x',
  heading: null,
  alias: null,
  embed: false,
  context: [],
});

const local = (id: string, links: LocalLinks['links'], title = id): LocalLinks => ({
  id,
  title,
  updatedAt: 0,
  unsynced: false,
  links,
});

describe('graph input', () => {
  // projects (b) > work (a) > deep (c); journal (d) at the top level.
  const folders = [
    folder('a', 'b', 'a0'),
    folder('b', null, 'a1'),
    folder('c', 'a', 'a0'),
    folder('d', null, 'a0'),
  ];

  it('finds each folder’s top-level folder', () => {
    expect(Object.fromEntries(topLevelOf(folders))).toEqual({ a: 'b', b: 'b', c: 'b', d: 'd' });
  });

  it('groups notes by top-level folder, in sidebar order, with unique resolved links', () => {
    const { notes, groups } = graphInput(
      [
        local('n1', [link('n2'), link('n2'), link(null), link('n3')]),
        local('n2', [], '  '),
        local('n3', []),
      ],
      {
        folders,
        registry: [
          { id: 'n1', folderId: 'c' },
          { id: 'n2', folderId: 'd' },
        ],
        rootSortMode: 'manual',
      },
    );
    expect(groups).toEqual([
      { id: 'd', name: 'D' },
      { id: 'b', name: 'B' },
      { id: null, name: 'Top level' },
    ]);
    expect(notes).toEqual([
      { id: 'n1', title: 'n1', group: 'b', tags: [], links: ['n2', 'n3'] },
      { id: 'n2', title: 'Untitled', group: 'd', tags: [], links: [] },
      { id: 'n3', title: 'n3', group: null, tags: [], links: [] },
    ]);
  });

  it('keeps the same input through edits that change no note, title, link or group (no new layout)', () => {
    const cache = new GraphInputCache();
    const source = {
      folders,
      registry: [{ id: 'n1', folderId: 'c' }],
      rootSortMode: 'manual' as const,
    };
    const first = cache.get([local('n1', [link('n2')]), local('n2', [])], source);

    // Typing in a note: its time, sync state and text change, nothing the graph shows.
    const edited = cache.get(
      [{ ...local('n1', [link('n2')]), updatedAt: 99, unsynced: true }, local('n2', [])],
      { ...source, folders: [...folders] },
    );
    expect(edited).toBe(first);

    expect(cache.get([local('n1', [link('n2')]), local('n2', [link('n1')])], source)).not.toBe(
      first,
    );
    const renamed = cache.get(
      [local('n1', [link('n2')]), local('n2', [link('n1')], 'Two')],
      source,
    );
    expect(renamed.notes.find((note) => note.id === 'n2')?.title).toBe('Two');
  });

  it('addresses the global and local graphs', () => {
    expect(graphPath(null)).toBe('/graph');
    expect(graphPath('01ABC')).toBe('/graph?note=01ABC');
    expect(graphPath('01ABC', true)).toBe('/graph?note=01ABC&local=1');
  });
});
