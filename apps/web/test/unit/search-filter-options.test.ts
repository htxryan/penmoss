/**
 * The search dialog's Folder and Tag lists (PEN-71, A1290): under All Notebooks, every open
 * notebook's folders grouped by notebook, and every notebook's tags each once.
 */
import { describe, expect, it } from 'vitest';
import type { FolderRecord } from '@penmoss/core/workspace';
import {
  ALL_NOTEBOOKS_FOLDERS,
  folderGroups,
  folderOptions,
  folderScopes,
  notebookTags,
  type FilterNotebook,
} from '../../src/search/filter-options';

const EM = ' ';

const folder = (
  id: string,
  name: string,
  parentId: string | null,
  position = 'a',
): FolderRecord => ({ id, name, parentId, position, sortMode: 'manual' });

const notebook = (
  id: string,
  name: string,
  folders: FolderRecord[],
  tags: string[][] = [],
): FilterNotebook => ({ id, name, folders, tags });

describe('folderScopes', () => {
  it('offers All Folders alone with one notebook open', () => {
    expect(folderScopes(false, false)).toEqual([{ value: '', label: 'All Folders' }]);
  });

  it('offers All Folders alone under All Notebooks', () => {
    expect(folderScopes(true, false)).toEqual([{ value: '', label: 'All Folders' }]);
  });

  it('offers this notebook’s folders or all notebooks’ with one notebook chosen', () => {
    expect(folderScopes(true, true)).toEqual([
      { value: '', label: 'All Folders (This Notebook)' },
      { value: ALL_NOTEBOOKS_FOLDERS, label: 'All Folders (All Notebooks)' },
    ]);
  });

  it('gives All Notebooks a value no folder or grouped folder has', () => {
    expect(ALL_NOTEBOOKS_FOLDERS).not.toBe('');
    expect(() => JSON.parse(ALL_NOTEBOOKS_FOLDERS) as unknown).toThrow();
  });
});

describe('folderOptions', () => {
  it('lists folders in tree order, subfolders indented', () => {
    const options = folderOptions([
      folder('b', 'Beta', null, 'b'),
      folder('a', 'Alpha', null, 'a'),
      folder('a1', 'Inner', 'a'),
      folder('a2', 'Deeper', 'a1'),
    ]);
    expect(options).toEqual([
      { id: 'a', label: 'Alpha' },
      { id: 'a1', label: `${EM}Inner` },
      { id: 'a2', label: `${EM}${EM}Deeper` },
      { id: 'b', label: 'Beta' },
    ]);
  });
});

describe('folderGroups', () => {
  it('groups each notebook’s folders under its name, in the order given', () => {
    const groups = folderGroups([
      notebook('n2', 'Work', [folder('w', 'Projects', null), folder('w1', 'Parser', 'w')]),
      notebook('n1', 'Quanta', [folder('q', 'Archive', null)]),
    ]);
    expect(groups).toEqual([
      {
        notebookId: 'n2',
        name: 'Work',
        folders: [
          { id: 'w', label: 'Projects' },
          { id: 'w1', label: `${EM}Parser` },
        ],
      },
      { notebookId: 'n1', name: 'Quanta', folders: [{ id: 'q', label: 'Archive' }] },
    ]);
  });

  it('gives a notebook without folders no group', () => {
    const groups = folderGroups([
      notebook('n1', 'Empty', []),
      notebook('n2', 'Work', [folder('w', 'Projects', null)]),
    ]);
    expect(groups.map((group) => group.name)).toEqual(['Work']);
  });

  it('keeps two notebooks’ folders apart even when their ids match', () => {
    const groups = folderGroups([
      notebook('n1', 'Quanta', [folder('same', 'Archive', null)]),
      notebook('n2', 'Work', [folder('same', 'Archive', null)]),
    ]);
    expect(groups.map((group) => group.notebookId)).toEqual(['n1', 'n2']);
  });

  it('makes one group for a single notebook', () => {
    expect(folderGroups([notebook('n1', 'Quanta', [folder('q', 'Archive', null)])])).toHaveLength(
      1,
    );
  });
});

describe('notebookTags', () => {
  it('lists every notebook’s tags, each once', () => {
    const tags = notebookTags([
      notebook('n1', 'Quanta', [], [['alpha'], ['shared']]),
      notebook('n2', 'Work', [], [['beta', 'shared']]),
    ]);
    expect([...tags].sort()).toEqual(['alpha', 'beta', 'shared']);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('lists one notebook’s tags alone', () => {
    expect(notebookTags([notebook('n2', 'Work', [], [['beta']])])).toEqual(['beta']);
  });
});
