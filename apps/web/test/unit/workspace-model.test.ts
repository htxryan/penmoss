import { buildTree, compareOrder, type NoteEntry } from '@penmoss/core/workspace';
import {
  createFolder,
  moveFolder,
  moveNote,
  readWorkspace,
  registerNote,
  setSortMode,
  setTogether,
} from '@penmoss/sync-client/workspace';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { describe, expect, it } from 'vitest';
import type { NoteListEntry } from '../../src/notes/list';
import {
  ancestors,
  dropZone,
  folderChoices,
  mergeRegistry,
  planDrop,
  planMoveTo,
  planStep,
  revealFolders,
  UNREGISTERED_POSITION,
  visibleRows,
  type MovePlan,
} from '../../src/workspace/model';
import { folderTreeOf } from '../../src/workspace/tree';

type Doc = ReturnType<typeof createYjs14Replica>['doc'];

const listed = (id: string, title = id, updatedAt = 0): NoteListEntry => ({
  id,
  title,
  excerpt: '',
  updatedAt,
  unsynced: false,
  tags: [],
});

/** A doc with: Projects (Home, Work (Deep)), Reading; notes n1–n3 in Projects, n4 at the top level. */
function fixture() {
  const doc = createYjs14Replica().doc;
  createFolder(doc, { id: 'projects', name: 'Projects', parentId: null });
  createFolder(doc, { id: 'reading', name: 'Reading', parentId: null });
  createFolder(doc, { id: 'home', name: 'Home', parentId: 'projects' });
  createFolder(doc, { id: 'work', name: 'Work', parentId: 'projects' });
  createFolder(doc, { id: 'deep', name: 'Deep', parentId: 'work' });
  for (const id of ['n1', 'n2', 'n3']) registerNote(doc, { id, folderId: 'projects' });
  registerNote(doc, { id: 'n4', folderId: null });
  const list = [
    listed('n1', 'Zebra', 10),
    listed('n2', 'apple', 30),
    listed('n3', 'Mango', 20),
    listed('n4', 'Loose', 5),
  ];
  return { doc, list };
}

function treeOf(doc: Doc, list: readonly NoteListEntry[]) {
  const snapshot = readWorkspace(doc);
  return buildTree(
    snapshot.folders,
    mergeRegistry(snapshot, list).entries,
    snapshot.rootSortMode,
    snapshot.rootTogether === true,
  );
}

/** Applies a plan the way the Workspace service does. */
function apply(doc: Doc, plan: MovePlan) {
  if (plan.type !== 'move') return;
  const known = new Set(readWorkspace(doc).notes.map((note) => note.id));
  const place = (kind: 'folder' | 'note', id: string, position: string) => {
    if (kind === 'folder') moveFolder(doc, id, plan.parentId, position);
    else if (known.has(id)) moveNote(doc, id, plan.parentId, position);
    else registerNote(doc, { id, folderId: plan.parentId, position });
  };
  doc.transact(() => {
    if (plan.together) setTogether(doc, plan.parentId);
    for (const sibling of plan.respace) place(sibling.kind, sibling.id, sibling.position);
    place(plan.item.kind, plan.item.id, plan.position);
  });
}

/** A folder's rows in the order shown, as `kind:id`. */
const shown = (doc: Doc, list: readonly NoteListEntry[], folderId: string | null) =>
  visibleRows(treeOf(doc, list), new Set())
    .filter((row) => row.parentId === folderId)
    .map((row) => `${row.kind}:${row.id}`);
const shownIn = (doc: Doc, list: readonly NoteListEntry[], folderId: string) =>
  visibleRows(treeOf(doc, list), new Set([folderId]))
    .filter((row) => row.parentId === folderId)
    .map((row) => `${row.kind}:${row.id}`);

const notesIn = (doc: Doc, list: readonly NoteListEntry[], folderId: string | null) => {
  const tree = treeOf(doc, list);
  const notes = folderId === null ? tree.notes : tree.byId.get(folderId)!.notes;
  return notes.map((note) => note.id);
};

describe('mergeRegistry', () => {
  it('files listed notes where the registry says, unknown ones at the top level', () => {
    const { doc } = fixture();
    const merged = mergeRegistry(readWorkspace(doc), [
      listed('n2'),
      listed('zz-new'),
      listed('aa-new'),
    ]);
    expect(merged.unregistered).toEqual(['aa-new', 'zz-new']);
    expect(merged.entries.find((entry) => entry.id === 'n2')).toMatchObject({
      folderId: 'projects',
    });
    expect(merged.entries.find((entry) => entry.id === 'zz-new')).toMatchObject({
      folderId: null,
      position: UNREGISTERED_POSITION,
    });
    // A note only the registry knows is not shown.
    expect(merged.entries.map((entry) => entry.id)).not.toContain('n1');
  });

  it('puts unregistered notes after registered ones in manual order', () => {
    const registered: NoteEntry = {
      id: 'z',
      folderId: null,
      position: 'zzzz',
      title: '',
      updatedAt: 0,
    };
    const unknown: NoteEntry = { ...registered, id: 'a', position: UNREGISTERED_POSITION };
    expect(compareOrder(registered, unknown)).toBeLessThan(0);
  });
});

describe('revealFolders (T39)', () => {
  it('opens the folders around a note the registry has filed', () => {
    const { doc, list } = fixture();
    registerNote(doc, { id: 'n5', folderId: 'deep' });
    const all = [...list, listed('n5')];
    const snapshot = readWorkspace(doc);
    expect(revealFolders('n5', snapshot, treeOf(doc, all), false)).toEqual([
      'deep',
      'work',
      'projects',
    ]);
  });

  it('waits while the note is listed but the workspace has not said where it is', () => {
    // A cold load: the note list comes from this device's store before the WorkspaceDoc,
    // so the note shows at the top level for a moment. Revealing then would open nothing
    // and never try again once the note moved into its folder.
    const { doc, list } = fixture();
    const empty = createYjs14Replica().doc;
    const all = [...list, listed('n5')];
    expect(revealFolders('n1', readWorkspace(empty), treeOf(empty, all), false)).toBeNull();
    // Once the folders arrive, the note's folder opens.
    expect(revealFolders('n1', readWorkspace(doc), treeOf(doc, all), false)).toEqual(['projects']);
  });

  it('reveals an unfiled note at the top level once the workspace has synced', () => {
    const { doc, list } = fixture();
    const all = [...list, listed('loose')];
    expect(revealFolders('loose', readWorkspace(doc), treeOf(doc, all), false)).toBeNull();
    expect(revealFolders('loose', readWorkspace(doc), treeOf(doc, all), true)).toEqual([]);
  });

  it('reveals nothing for a note the list does not show', () => {
    const { doc, list } = fixture();
    expect(revealFolders('missing', readWorkspace(doc), treeOf(doc, list), true)).toBeNull();
  });
});

describe('Move to folder… (T39)', () => {
  it('lists the top level, then every folder in tree order with its path and depth', () => {
    const { doc, list } = fixture();
    const choices = folderChoices(treeOf(doc, list));
    expect(choices.map((choice) => [choice.id, choice.path, choice.depth])).toEqual([
      [null, 'Top level', 0],
      ['projects', 'Projects', 1],
      ['home', 'Projects / Home', 2],
      ['work', 'Projects / Work', 2],
      ['deep', 'Projects / Work / Deep', 3],
      ['reading', 'Reading', 1],
    ]);
  });

  it('files the note at the end of the folder chosen', () => {
    const { doc, list } = fixture();
    const plan = planMoveTo(treeOf(doc, list), 'n4', 'deep');
    expect(plan).toMatchObject({
      type: 'move',
      item: { kind: 'note', id: 'n4' },
      parentId: 'deep',
    });
    apply(doc, plan);
    expect(notesIn(doc, list, 'deep')).toEqual(['n4']);
    apply(doc, planMoveTo(treeOf(doc, list), 'n4', null));
    expect(notesIn(doc, list, null)).toEqual(['n4']);
  });

  it('changes nothing when the note is already there, even in manual order', () => {
    const { doc, list } = fixture();
    expect(planMoveTo(treeOf(doc, list), 'n1', 'projects')).toEqual({ type: 'noop' });
    expect(planMoveTo(treeOf(doc, list), 'n4', null)).toEqual({ type: 'noop' });
  });

  it('changes nothing for a folder that is gone', () => {
    const { doc, list } = fixture();
    expect(planMoveTo(treeOf(doc, list), 'n4', 'missing')).toEqual({ type: 'noop' });
  });
});

describe('visibleRows', () => {
  it('flattens open folders depth first, folders before notes, with tree positions', () => {
    const { doc, list } = fixture();
    const tree = treeOf(doc, list);
    const collapsed = visibleRows(tree, new Set());
    expect(collapsed.map((row) => row.key)).toEqual([
      'folder:projects',
      'folder:reading',
      'note:n4',
    ]);
    expect(collapsed[0]).toMatchObject({ level: 1, setSize: 3, posInSet: 1, expanded: false });

    const open = visibleRows(tree, new Set(['projects', 'work']));
    expect(open.map((row) => `${row.level}:${row.id}`)).toEqual([
      '1:projects',
      '2:home',
      '2:work',
      '3:deep',
      '2:n1',
      '2:n2',
      '2:n3',
      '1:reading',
      '1:n4',
    ]);
    const work = open.find((row) => row.id === 'work')!;
    expect(work).toMatchObject({
      parentId: 'projects',
      setSize: 5,
      posInSet: 2,
      hasChildren: true,
    });
    expect(open.find((row) => row.id === 'home')).toMatchObject({ hasChildren: false });
    expect(open.find((row) => row.id === 'n3')).toMatchObject({ posInSet: 5, title: 'Mango' });
  });

  it('shows the folder chain of a note', () => {
    const { doc, list } = fixture();
    moveNote(doc, 'n1', 'deep', 'a0');
    expect(ancestors(treeOf(doc, list), { kind: 'note', id: 'n1' })).toEqual([
      'deep',
      'work',
      'projects',
    ]);
  });
});

describe('dropZone', () => {
  it('splits note rows in half and folder rows in quarters', () => {
    expect(dropZone('note', 4, 28)).toBe('before');
    expect(dropZone('note', 20, 28)).toBe('after');
    expect(dropZone('folder', 4, 28)).toBe('before');
    expect(dropZone('folder', 14, 28)).toBe('inside');
    expect(dropZone('folder', 26, 28)).toBe('after');
    expect(dropZone('folder', 0, 0)).toBe('inside');
  });
});

describe('planDrop', () => {
  it('reorders notes in a manual folder with one key', () => {
    const { doc, list } = fixture();
    const plan = planDrop(
      treeOf(doc, list),
      { kind: 'note', id: 'n3' },
      {
        kind: 'note',
        id: 'n1',
        zone: 'before',
      },
    );
    expect(plan).toMatchObject({ type: 'move', parentId: 'projects', respace: [] });
    apply(doc, plan);
    expect(notesIn(doc, list, 'projects')).toEqual(['n3', 'n1', 'n2']);

    apply(
      doc,
      planDrop(
        treeOf(doc, list),
        { kind: 'note', id: 'n3' },
        { kind: 'note', id: 'n2', zone: 'after' },
      ),
    );
    expect(notesIn(doc, list, 'projects')).toEqual(['n1', 'n2', 'n3']);
  });

  it('is a no-op when the item would land where it is', () => {
    const { doc, list } = fixture();
    const tree = treeOf(doc, list);
    expect(
      planDrop(tree, { kind: 'note', id: 'n2' }, { kind: 'note', id: 'n1', zone: 'after' }),
    ).toEqual({ type: 'noop' });
    expect(
      planDrop(tree, { kind: 'note', id: 'n2' }, { kind: 'note', id: 'n2', zone: 'before' }),
    ).toEqual({ type: 'noop' });
    expect(planDrop(tree, { kind: 'note', id: 'n4' }, { kind: 'root' })).toEqual({ type: 'noop' });
  });

  it('moves a note into a folder it is dropped on, at the end', () => {
    const { doc, list } = fixture();
    apply(
      doc,
      planDrop(
        treeOf(doc, list),
        { kind: 'note', id: 'n4' },
        {
          kind: 'folder',
          id: 'projects',
          zone: 'inside',
        },
      ),
    );
    expect(notesIn(doc, list, 'projects')).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('places a note above or between folders in a Manual folder, one order from then on (T62 item 6)', () => {
    const { doc, list } = fixture();
    // Until then, folders first.
    expect(shown(doc, list, null)).toEqual(['folder:projects', 'folder:reading', 'note:n4']);
    const plan = planDrop(
      treeOf(doc, list),
      { kind: 'note', id: 'n4' },
      { kind: 'folder', id: 'projects', zone: 'before' },
    );
    expect(plan).toMatchObject({ type: 'move', together: true });
    apply(doc, plan);
    expect(shown(doc, list, null)).toEqual(['note:n4', 'folder:projects', 'folder:reading']);
    expect(readWorkspace(doc).rootTogether).toBe(true);
    // Between two folders, and a folder below a note.
    apply(
      doc,
      planDrop(
        treeOf(doc, list),
        { kind: 'note', id: 'n4' },
        { kind: 'folder', id: 'projects', zone: 'after' },
      ),
    );
    expect(shown(doc, list, null)).toEqual(['folder:projects', 'note:n4', 'folder:reading']);
    apply(
      doc,
      planDrop(
        treeOf(doc, list),
        { kind: 'folder', id: 'reading' },
        { kind: 'note', id: 'n4', zone: 'before' },
      ),
    );
    expect(shown(doc, list, null)).toEqual(['folder:projects', 'folder:reading', 'note:n4']);
    // Another folder sorted Manual keeps folders first.
    expect(shownIn(doc, list, 'projects')).toEqual([
      'folder:home',
      'folder:work',
      'note:n1',
      'note:n2',
      'note:n3',
    ]);
  });

  it('keeps folders first in a folder sorted by name or date', () => {
    const { doc, list } = fixture();
    setSortMode(doc, null, 'alpha');
    const plan = planDrop(
      treeOf(doc, list),
      { kind: 'note', id: 'n1' },
      { kind: 'folder', id: 'projects', zone: 'before' },
    );
    expect(plan).toMatchObject({ type: 'move', parentId: null });
    expect(plan).not.toHaveProperty('together');
    apply(doc, plan);
    expect(shown(doc, list, null)).toEqual([
      'folder:projects',
      'folder:reading',
      'note:n4',
      'note:n1',
    ]);
  });

  it('moves folders beside or into folders, and to the top level', () => {
    const { doc, list } = fixture();
    apply(
      doc,
      planDrop(
        treeOf(doc, list),
        { kind: 'folder', id: 'reading' },
        {
          kind: 'folder',
          id: 'projects',
          zone: 'before',
        },
      ),
    );
    expect(treeOf(doc, list).folders.map((f) => f.id)).toEqual(['reading', 'projects']);

    apply(
      doc,
      planDrop(
        treeOf(doc, list),
        { kind: 'folder', id: 'reading' },
        {
          kind: 'folder',
          id: 'deep',
          zone: 'inside',
        },
      ),
    );
    expect(treeOf(doc, list).byId.get('reading')!.effectiveParentId).toBe('deep');

    apply(doc, planDrop(treeOf(doc, list), { kind: 'folder', id: 'reading' }, { kind: 'root' }));
    expect(treeOf(doc, list).folders.map((f) => f.id)).toEqual(['projects', 'reading']);
  });

  it('refuses to move a folder into one of its descendants', () => {
    const { doc, list } = fixture();
    const tree = treeOf(doc, list);
    for (const target of ['work', 'deep']) {
      expect(
        planDrop(
          tree,
          { kind: 'folder', id: 'projects' },
          {
            kind: 'folder',
            id: target,
            zone: 'inside',
          },
        ),
      ).toEqual({
        type: 'refused',
        reason: 'A folder cannot move into itself or one of its subfolders.',
      });
    }
    // Dropping a folder on itself does nothing; beside a descendant is inside it too.
    expect(
      planDrop(
        tree,
        { kind: 'folder', id: 'projects' },
        {
          kind: 'folder',
          id: 'projects',
          zone: 'inside',
        },
      ),
    ).toEqual({ type: 'noop' });
    expect(
      planDrop(
        tree,
        { kind: 'folder', id: 'projects' },
        { kind: 'folder', id: 'deep', zone: 'after' },
      ),
    ).toMatchObject({ type: 'refused' });
  });

  it('appends to a sorted folder and leaves its order alone', () => {
    const { doc, list } = fixture();
    setSortMode(doc, 'projects', 'alpha');
    const tree = treeOf(doc, list);
    expect(
      planDrop(tree, { kind: 'note', id: 'n3' }, { kind: 'note', id: 'n2', zone: 'before' }),
    ).toEqual({ type: 'noop' });
    const plan = planDrop(
      tree,
      { kind: 'note', id: 'n4' },
      {
        kind: 'note',
        id: 'n2',
        zone: 'before',
      },
    );
    apply(doc, plan);
    const positions = readWorkspace(doc).notes;
    const n4 = positions.find((note) => note.id === 'n4')!;
    expect(n4.folderId).toBe('projects');
    for (const other of positions.filter(
      (note) => note.folderId === 'projects' && note.id !== 'n4',
    )) {
      expect(n4.position > other.position).toBe(true);
    }
    // Sorted A–Z by title: apple, Loose, Mango, Zebra.
    expect(notesIn(doc, list, 'projects')).toEqual(['n2', 'n4', 'n3', 'n1']);
  });

  it('steps past tied keys from concurrent inserts instead of throwing, re-keying only the tie', () => {
    const { doc, list } = fixture();
    const extra = [...list, listed('t1'), listed('t2'), listed('t3')];
    for (const id of ['t1', 't2', 't3'])
      registerNote(doc, { id, folderId: 'reading', position: 'a5' });
    registerNote(doc, { id: 'first', folderId: 'reading', position: 'a1' });
    const all = [...extra, listed('first')];
    expect(notesIn(doc, all, 'reading')).toEqual(['first', 't1', 't2', 't3']);

    const plan = planDrop(
      treeOf(doc, all),
      { kind: 'note', id: 'n4' },
      {
        kind: 'note',
        id: 't2',
        zone: 'before',
      },
    );
    expect(plan.type).toBe('move');
    if (plan.type !== 'move') return;
    // t2 and t3 (after the drop point, tied with t1) get new keys; 'first' and t1 keep theirs.
    expect(plan.respace.map((p) => p.id)).toEqual(['t2', 't3']);
    apply(doc, plan);
    expect(notesIn(doc, all, 'reading')).toEqual(['first', 't1', 'n4', 't2', 't3']);
  });

  it('registers unknown neighbours when a note is dropped among them', () => {
    const { doc, list } = fixture();
    const all = [...list, listed('u1'), listed('u2')];
    expect(notesIn(doc, all, null)).toEqual(['n4', 'u1', 'u2']);
    const plan = planDrop(
      treeOf(doc, all),
      { kind: 'note', id: 'n1' },
      {
        kind: 'note',
        id: 'u2',
        zone: 'before',
      },
    );
    apply(doc, plan);
    expect(notesIn(doc, all, null)).toEqual(['n4', 'u1', 'n1', 'u2']);
    expect(readWorkspace(doc).notes.map((note) => note.id)).toEqual(
      expect.arrayContaining(['u1', 'u2']),
    );
  });
});

describe('planStep (Alt+↑/↓)', () => {
  it('moves one place past the next row, and stops at the ends', () => {
    const { doc, list } = fixture();
    apply(doc, planStep(treeOf(doc, list), { kind: 'note', id: 'n1' }, 1));
    expect(notesIn(doc, list, 'projects')).toEqual(['n2', 'n1', 'n3']);
    apply(doc, planStep(treeOf(doc, list), { kind: 'note', id: 'n3' }, -1));
    expect(notesIn(doc, list, 'projects')).toEqual(['n2', 'n3', 'n1']);
    expect(planStep(treeOf(doc, list), { kind: 'note', id: 'n1' }, 1)).toEqual({ type: 'noop' });
    // The first note up past the last folder: one order for both from then on (T62 item 6).
    apply(doc, planStep(treeOf(doc, list), { kind: 'note', id: 'n2' }, -1));
    expect(shownIn(doc, list, 'projects')).toEqual([
      'folder:home',
      'note:n2',
      'folder:work',
      'note:n3',
      'note:n1',
    ]);
    apply(doc, planStep(treeOf(doc, list), { kind: 'note', id: 'n2' }, -1));
    expect(shownIn(doc, list, 'projects')[0]).toBe('note:n2');
    expect(planStep(treeOf(doc, list), { kind: 'note', id: 'n2' }, -1)).toEqual({ type: 'noop' });
    // Back down past Home, as the folders were.
    apply(doc, planStep(treeOf(doc, list), { kind: 'note', id: 'n2' }, 1));
    apply(doc, planStep(treeOf(doc, list), { kind: 'note', id: 'n2' }, 1));

    apply(doc, planStep(treeOf(doc, list), { kind: 'folder', id: 'work' }, -1));
    expect(
      treeOf(doc, list)
        .byId.get('projects')!
        .folders.map((f) => f.id),
    ).toEqual(['work', 'home']);
  });

  it('explains that a sorted folder cannot be reordered', () => {
    const { doc, list } = fixture();
    setSortMode(doc, null, 'modified');
    expect(planStep(treeOf(doc, list), { kind: 'folder', id: 'reading' }, -1)).toEqual({
      type: 'refused',
      reason: 'The top level is sorted Modified. Switch it to Manual to reorder.',
    });
  });
});

describe('folderTreeOf (T41: one tree for the sidebar, the picker and the Info panel)', () => {
  it('builds the tree once per snapshot and list, and again when either changes', () => {
    const { doc, list } = fixture();
    const snapshot = readWorkspace(doc);
    const first = folderTreeOf(snapshot, list);
    expect(folderTreeOf(snapshot, list)).toBe(first);
    expect(first.tree).toEqual(treeOf(doc, list));
    expect(first.merged).toEqual(mergeRegistry(snapshot, list));

    const renamed = [listed('n1', 'Aardvark', 40), ...list.slice(1)];
    const next = folderTreeOf(snapshot, renamed);
    expect(next).not.toBe(first);
    expect(next.tree).toEqual(treeOf(doc, renamed));

    createFolder(doc, { id: 'later', name: 'Later', parentId: null });
    const changed = readWorkspace(doc);
    expect(folderTreeOf(changed, list)).not.toBe(first);
    expect(folderTreeOf(changed, list).tree.byId.has('later')).toBe(true);
  });
});
