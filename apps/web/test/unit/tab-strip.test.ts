import { describe, expect, it } from 'vitest';
import { describeTabs, facePath, pageTitle, tabNumber, tabTip } from '../../src/tabs/describe';
import { initialState, openTab } from '../../src/tabs/state';
import type { Source } from '../../src/sources/registry';

// PEN-140 (AC8, A1502): what each tab says: its title, its notebook when two look alike, and
// its tooltip with the notebook, folders and ⌘ number.

const A = '01J0000000000000000000000A';
const B = '01J0000000000000000000000B';
const C = '01J0000000000000000000000C';

function source(id: string, name: string, folders: Record<string, string[]> = {}): Source {
  const list = Object.entries(folders).map(([note], index) => ({
    id: note,
    folderId: `f${index}`,
  }));
  const folderRecords = Object.values(folders).flatMap((names, index) =>
    names.map((folder, depth) => ({
      id: depth === names.length - 1 ? `f${index}` : `f${index}-${depth}`,
      name: folder,
      parentId: depth === 0 ? null : `f${index}-${depth - 1}`,
    })),
  );
  return {
    id,
    name,
    workspace: { getState: () => ({ snapshot: { notes: list, folders: folderRecords } }) },
  } as unknown as Source;
}

function counter() {
  let n = 0;
  return () => `t${++n}`;
}

describe('a tab’s face', () => {
  const personal = source('p', 'Personal', { [A]: ['Work'] });
  const quanta = source('q', 'Quanta');
  const sourceOf = (id: string) => (id === A ? personal : id === B ? quanta : quanta);
  const titles: Record<string, string> = { [A]: 'Meeting Notes', [B]: 'Meeting Notes', [C]: '' };

  function faces(look: (source: Source) => string) {
    const ids = counter();
    let state = initialState(ids, `/notes/${A}`);
    state = openTab(state, `/notes/${B}`, { ids });
    state = openTab(state, `/notes/${C}`, { ids });
    state = openTab(state, '/graph', { ids });
    return describeTabs(state, { sourceOf, titleOf: (id) => titles[id], look });
  }

  it('names its page, or its note, "Untitled" when it has no title', () => {
    expect(faces((s) => s.id).map((face) => [face.kind, face.title])).toEqual([
      ['note', 'Meeting Notes'],
      ['note', 'Meeting Notes'],
      ['note', 'Untitled'],
      ['graph', 'Graph'],
    ]);
  });

  it('names a page by its path, as Back and Forward’s tooltips say it', () => {
    const titleOf = (id: string) => titles[id];
    expect(pageTitle(`/notes/${A}?heading=x`, titleOf)).toBe('Meeting Notes');
    expect(pageTitle(`/notes/${C}`, titleOf)).toBe('Untitled');
    expect(pageTitle('/', titleOf)).toBe('Home');
    expect(pageTitle('/trash', titleOf)).toBe('Trash');
  });

  it('names the Tags page, and a page that is no longer there as Not Found', () => {
    const ids = counter();
    let state = initialState(ids, '/tags');
    // A tab kept from before the Time Machine was removed (PEN-190).
    state = openTab(state, '/time-machine?source=nb-1', { ids });
    const named = describeTabs(state, { sourceOf, titleOf: (id) => titles[id], look: (s) => s.id });
    expect(named.map((face) => [face.kind, face.title])).toEqual([
      ['tags', 'Tags'],
      ['other', 'Not Found'],
    ]);
  });

  it('adds the notebook only when two same-titled tabs have badges that look the same', () => {
    expect(faces((s) => s.id).map((face) => face.suffix)).toEqual([null, null, null, null]);
    expect(faces(() => 'P|moss').map((face) => face.suffix)).toEqual([
      'Personal',
      'Quanta',
      null,
      null,
    ]);
  });

  it('shows the title, notebook, folders and ⌘ number in its tooltip', () => {
    const [first] = faces((s) => s.id);
    expect(facePath(first!)).toBe('Personal › Work');
    expect(tabTip(first!, true)).toBe('Meeting Notes · Personal › Work (⌘1)');
    expect(tabTip(first!, false)).toBe('Meeting Notes · Personal › Work (Ctrl+1)');
  });

  it('numbers the first eight tabs, and ⌘9 the last', () => {
    expect([0, 1, 7, 8, 9].map((index) => tabNumber(index, 10))).toEqual([1, 2, 8, null, 9]);
    expect(tabNumber(2, 3)).toBe(3);
  });
});
