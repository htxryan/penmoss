import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildTree,
  compareOrder,
  effectiveParents,
  folderPath,
  folderSubtree,
  isOrderKey,
  isWithin,
  keyBetween,
  keysBetween,
  type FolderRecord,
  type NoteEntry,
} from '../src/workspace';

const folder = (
  id: string,
  parentId: string | null,
  extra: Partial<FolderRecord> = {},
): FolderRecord => ({
  id,
  name: id,
  parentId,
  position: 'a0',
  sortMode: 'manual',
  ...extra,
});

const note = (id: string, folderId: string | null, extra: Partial<NoteEntry> = {}): NoteEntry => ({
  id,
  folderId,
  position: 'a0',
  title: id,
  updatedAt: 0,
  ...extra,
});

describe('order keys', () => {
  it('fall strictly between their neighbours', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 100 }), { minLength: 1, maxLength: 60 }), (inserts) => {
        const keys: string[] = [];
        for (const raw of inserts) {
          const index = raw % (keys.length + 1);
          const key = keyBetween(keys[index - 1] ?? null, keys[index] ?? null);
          expect(isOrderKey(key)).toBe(true);
          keys.splice(index, 0, key);
        }
        expect([...keys].sort()).toEqual(keys);
        expect(new Set(keys).size).toBe(keys.length);
      }),
    );
  });

  it('stay short when appending or prepending', () => {
    let last: string | null = null;
    let first: string | null = null;
    for (let i = 0; i < 5000; i++) {
      last = keyBetween(last, null);
      first = keyBetween(null, first);
    }
    expect(last!.length).toBeLessThanOrEqual(4);
    expect(first!.length).toBeLessThanOrEqual(4);
  });

  it('make runs of keys', () => {
    const keys = keysBetween('a0', 'a1', 5);
    expect(keys).toHaveLength(5);
    expect([...keys].sort()).toEqual(keys);
    expect(keys.every((key) => key > 'a0' && key < 'a1')).toBe(true);
  });

  it('reject keys out of order or malformed', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow();
    expect(() => keyBetween('a0V0', null)).toThrow();
    expect(() => keyBetween('', null)).toThrow();
    expect(isOrderKey('a0')).toBe(true);
    expect(isOrderKey('V')).toBe(false);
  });

  it('break ties by id', () => {
    const items = [
      { id: 'b', position: 'a1' },
      { id: 'a', position: 'a1' },
      { id: 'c', position: 'a0' },
    ];
    expect(items.sort(compareOrder).map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('the folder tree', () => {
  it('nests folders and notes, with orphans at the top level', () => {
    const tree = buildTree(
      [folder('work', null), folder('projects', 'work'), folder('lost', 'deleted-folder')],
      [note('n1', 'projects'), note('n2', null), note('n3', 'deleted-folder')],
    );
    expect(tree.folders.map((f) => f.id)).toEqual(['lost', 'work']);
    expect(tree.byId.get('work')?.folders.map((f) => f.id)).toEqual(['projects']);
    expect(tree.byId.get('projects')?.notes.map((n) => n.id)).toEqual(['n1']);
    expect(tree.notes.map((n) => n.id)).toEqual(['n2', 'n3']);
  });

  it('breaks a cycle from concurrent moves at its smallest id, the same way everywhere', () => {
    // a moved into b on one device while b moved into a on another.
    const folders = [folder('b', 'a'), folder('a', 'b'), folder('c', 'b')];
    const parents = effectiveParents(folders);
    expect(parents.get('a')).toBeNull();
    expect(parents.get('b')).toBe('a');
    expect(effectiveParents([...folders].reverse())).toEqual(parents);
    const tree = buildTree(folders, []);
    expect(tree.folders.map((f) => f.id)).toEqual(['a']);
    expect(tree.byId.get('b')?.folders.map((f) => f.id)).toEqual(['c']);
  });

  it('handles longer cycles and self-parents', () => {
    const parents = effectiveParents([
      folder('x', 'z'),
      folder('y', 'x'),
      folder('z', 'y'),
      folder('s', 's'),
    ]);
    expect(parents.get('x')).toBeNull();
    expect(parents.get('s')).toBeNull();
    expect(parents.get('z')).toBe('y');
  });

  it('never loses a folder whatever the parents', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.integer({ min: 0, max: 7 }), fc.option(fc.integer({ min: 0, max: 9 }))),
          { maxLength: 8 },
        ),
        (pairs) => {
          const ids = [...new Set(pairs.map(([id]) => `f${id}`))];
          const folders = ids.map((id) => {
            const parent = pairs.find(([p]) => `f${p}` === id)?.[1];
            return folder(id, parent === null || parent === undefined ? null : `f${parent}`);
          });
          const tree = buildTree(folders, []);
          const seen: string[] = [];
          const walk = (nodes: typeof tree.folders) => {
            for (const node of nodes) {
              seen.push(node.id);
              walk(node.folders);
            }
          };
          walk(tree.folders);
          expect(seen.sort()).toEqual([...ids].sort());
        },
      ),
    );
  });

  it('knows when a move would put a folder inside itself', () => {
    const folders = [folder('work', null), folder('projects', 'work'), folder('2026', 'projects')];
    expect(isWithin(folders, '2026', 'work')).toBe(true);
    expect(isWithin(folders, 'work', 'work')).toBe(true);
    expect(isWithin(folders, null, 'work')).toBe(false);
    expect(isWithin(folders, 'work', '2026')).toBe(false);
  });

  it('sorts each folder by its own mode', () => {
    const notes = [
      note('n1', 'f', { title: 'banana', position: 'a0', updatedAt: 3 }),
      note('n2', 'f', { title: 'Apple 10', position: 'a2', updatedAt: 1 }),
      note('n3', 'f', { title: 'apple 9', position: 'a1', updatedAt: 2 }),
    ];
    const order = (mode: FolderRecord['sortMode']) =>
      buildTree([folder('f', null, { sortMode: mode })], notes)
        .byId.get('f')
        ?.notes.map((n) => n.id);
    expect(order('manual')).toEqual(['n1', 'n3', 'n2']);
    expect(order('alpha')).toEqual(['n3', 'n2', 'n1']);
    expect(order('modified')).toEqual(['n1', 'n3', 'n2']);
  });
});

describe('folder subtrees (T22 search filters)', () => {
  it('holds a folder and every folder below it, as the tree shows them', () => {
    const folders = [
      folder('a', null),
      folder('b', 'a'),
      folder('c', 'b'),
      folder('d', null),
      // A cycle e ↔ f: the smallest id (e) shows at the top level, so f is under e only.
      folder('e', 'f'),
      folder('f', 'e'),
      // An orphan shows at the top level.
      folder('g', 'missing'),
    ];
    expect([...folderSubtree(folders, 'a')].sort()).toEqual(['a', 'b', 'c']);
    expect([...folderSubtree(folders, 'b')].sort()).toEqual(['b', 'c']);
    expect([...folderSubtree(folders, 'e')].sort()).toEqual(['e', 'f']);
    expect([...folderSubtree(folders, 'f')].sort()).toEqual(['f']);
    expect([...folderSubtree(folders, 'g')]).toEqual(['g']);
    expect([...folderSubtree(folders, 'nope')]).toEqual([]);
  });

  it('names a folder by its path from the top, as the tree shows it (T37)', () => {
    const folders = [
      folder('a', null, { name: 'Projects' }),
      folder('b', 'a', { name: 'Garden' }),
      folder('e', 'f', { name: 'E' }),
      folder('f', 'e', { name: 'F' }),
      folder('g', 'missing', { name: 'Orphan' }),
    ];
    expect(folderPath(folders, 'a')).toBe('Projects');
    expect(folderPath(folders, 'b')).toBe('Projects/Garden');
    expect(folderPath(folders, 'f')).toBe('E/F');
    expect(folderPath(folders, 'g')).toBe('Orphan');
    expect(folderPath(folders, 'nope')).toBeNull();
  });
});
