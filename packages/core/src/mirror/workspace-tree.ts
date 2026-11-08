/**
 * The folder tree as the git mirror reads it from the WorkspaceDoc (T27):
 * folders with the parent the tree shows (cycles broken as every client breaks
 * them, A17) and the folder each note is filed in. A hash of exactly these
 * fields lets a run skip the tree when nothing in it moved; manual ordering
 * (positions) and sort modes are left out, since files have no order.
 *
 * Since T43 each mirror reads its own notebook's part of the tree (A757):
 *
 * - The default notebook's mirror (`notebook: null`) gets every folder and note
 *   that is not in a notebook, exactly as before, so its tree, its hash and
 *   every path it assigns are unchanged while there are no notebooks (A751).
 *   It also gets `others`: the notes in a notebook, or in Trash with one, which
 *   it must never write (their notebook's repository has them).
 * - A notebook's mirror gets the folders below the notebook's folder, those
 *   directly in it at the top, and its notes, the notebook's own folder being
 *   the top level (`null`): paths are relative to the notebook's folder.
 *
 * Fail closed (review of #160, A757): a note's notebook comes from `notebookLineage`, which walks
 * up through live folders and then folder Trash's records. Only folders whose notebook is certain
 * are in a tree. A note whose way up is broken, unknown, or passes a notebook in Trash, and an
 * unfiled note, is `held`: no mirror writes it or removes its file. So is a note whose notebook
 * changed within the settle window, by the mirror of the notebook it joined (A763). A notebook's
 * scope whose folder is not a live notebook any more is `paused` (A762).
 */
import { notebookIndex, notebookLineage, type FolderRecord, type GoneFolder } from '../workspace';
import type { MirrorFolder } from './paths';

/**
 * The settle window (T43 review S1, A763): a mirror writes a note's content only once it has
 * not changed for this long, reading the tree after the window, and a note that came into a
 * notebook waits as long before that notebook's mirror writes it. A NoteDoc and the
 * WorkspaceDoc sync on separate channels, so an edit made offline after a move can reach the
 * server first; the window lets the move catch up.
 */
export const MIRROR_SETTLE_MS = 120_000;

export interface MirrorTreeFull {
  readonly hash: string;
  readonly folders: MirrorFolder[];
  /** `[note id, folder id]`; null at the top level (or, unfiled, the default's own). */
  readonly notes: Array<[string, string | null]>;
  /**
   * The default notebook's tree only: notes that are another notebook's, each with that
   * notebook's id (filed in one, or in Trash with a deleted one). Absent when there are none.
   */
  readonly others?: Array<[string, string]>;
  /**
   * Notes no mirror may write or remove yet (T43, A757: fail closed): where they belong is not
   * certain (a folder on the way up is gone, or two moves made a loop), or they came into this
   * notebook within the settle window. Absent when there are none.
   */
  readonly held?: string[];
  /** Why `held` holds them (A768): a place not certain, or a move within the settle window. */
  readonly heldWhy?: { readonly uncertain: number; readonly settling: number };
  /**
   * The default notebook's tree only: its notes that were in a notebook at some point (A767).
   * One with no record of its own notebook in its NoteDoc is never written by the default.
   */
  readonly wasNotebook?: string[];
  /** A notebook's tree: the notebook's folder id. Absent for the default notebook's. */
  readonly notebook?: string;
  /**
   * A notebook's tree whose folder is not a notebook now (turned back into a folder, deleted,
   * or gone after a restore): its mirror pauses and changes nothing in its repository.
   */
  readonly paused?: true;
}

/** The tree, or only its hash when the caller already has that version. */
export type MirrorTree = MirrorTreeFull | { readonly hash: string };

export function isFullTree(tree: MirrorTree): tree is MirrorTreeFull {
  return 'folders' in tree;
}

export function mirrorTreeOf(
  folders: readonly FolderRecord[],
  notes: ReadonlyArray<{ readonly id: string; readonly folderId: string | null }>,
  since: string | null,
  scope: {
    /** The notebook whose mirror reads it; null (the default): the default notebook's. */
    readonly notebook?: string | null;
    /** Notes in Trash with a deleted notebook (`notebookTrashNotes`), each with its notebook. */
    readonly trashed?: ReadonlyMap<string, string>;
    /** The folders Trash remembers (`goneFolders`): a broken chain is read through them. */
    readonly gone?: readonly GoneFolder[];
    /** Notes whose notebook changed within the settle window: their new notebook's mirror waits. */
    readonly recent?: ReadonlySet<string>;
    /** Notes seen in a notebook at some point (A767). */
    readonly wasNotebook?: ReadonlySet<string>;
  } = {},
): MirrorTree {
  const lineage = notebookLineage(folders, scope.gone ?? []);
  const notebook = scope.notebook ?? null;
  const recent = scope.recent ?? new Set<string>();
  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : 1);
  const byFirst = <T extends [string, unknown]>(a: T, b: T) => (a[0] < b[0] ? -1 : 1);
  // Every mirror holds the notes whose place is not certain: none writes or removes them.
  const held = new Set<string>();
  for (const note of notes) if (!lineage.placement(note.folderId).certain) held.add(note.id);
  const uncertain = held.size;
  const why = () => ({ uncertain, settling: held.size - uncertain });
  /** The note is this notebook's for sure (null: the default's). */
  const ours = (note: { readonly id: string; readonly folderId: string | null }) => {
    const place = lineage.placement(note.folderId);
    return place.certain && place.notebook === notebook;
  };
  const certainIn = (folderId: string) => {
    const place = lineage.placement(folderId);
    return place.certain && place.notebook === notebook;
  };
  let tree: Omit<MirrorTreeFull, 'hash'>;
  if (notebook === null) {
    const registered = new Set(notes.map((note) => note.id));
    const others: Array<[string, string]> = [];
    for (const note of notes) {
      const place = lineage.placement(note.folderId);
      if (place.certain && place.notebook !== null) others.push([note.id, place.notebook]);
    }
    for (const [noteId, of] of scope.trashed ?? []) {
      if (!registered.has(noteId)) others.push([noteId, of]);
    }
    const mine = notes.filter(ours);
    for (const note of mine) if (recent.has(note.id)) held.add(note.id);
    const was = mine.filter((note) => scope.wasNotebook?.has(note.id)).map((note) => note.id);
    tree = {
      folders: folders
        .filter((folder) => certainIn(folder.id))
        .map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.parentId }))
        .sort(byId),
      notes: mine
        .filter((note) => !held.has(note.id))
        .map((note): [string, string | null] => [note.id, note.folderId])
        .sort(byFirst),
      // Only when there are any: without notebooks the tree hashes exactly as before (A751).
      ...(others.length > 0 ? { others: others.sort(byFirst) } : {}),
      ...(held.size > 0 ? { held: [...held].sort(), heldWhy: why() } : {}),
      ...(was.length > 0 ? { wasNotebook: was.sort() } : {}),
    };
  } else if (!notebookIndex(folders).isNotebook(notebook) || !certainIn(notebook)) {
    // Not a notebook now: the mirror pauses and touches nothing (T43 review S2, S6).
    tree = { notebook, paused: true, folders: [], notes: [] };
  } else {
    const mine = notes.filter(ours);
    for (const note of mine) if (recent.has(note.id)) held.add(note.id);
    tree = {
      notebook,
      folders: folders
        .filter((folder) => folder.id !== notebook && certainIn(folder.id))
        .map((folder) => ({
          id: folder.id,
          name: folder.name,
          parentId: folder.parentId === notebook ? null : folder.parentId,
        }))
        .sort(byId),
      notes: mine
        .filter((note) => !held.has(note.id))
        .map((note): [string, string | null] => [
          note.id,
          note.folderId === notebook ? null : note.folderId,
        ])
        .sort(byFirst),
      ...(held.size > 0 ? { held: [...held].sort(), heldWhy: why() } : {}),
    };
  }
  const hash = textHash(JSON.stringify(tree));
  return hash === since ? { hash } : { hash, ...tree };
}

/** A fast 53-bit string hash (cyrb53) as hex: change detection, not security. */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
