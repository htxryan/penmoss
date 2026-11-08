/**
 * Delete for good in a git notebook (T50, A828; #147's A748). The note id goes into the
 * WorkspaceDoc's `purged` map and leaves the registry; every engine then drops its local copy,
 * never applies a log of it again and never writes one, and removes its files from the branch:
 * the one case where a writer removes other writers' files (G0's change 1). Git's history keeps
 * the content, and the app's confirmation says so.
 */
import { registerNote, WORKSPACE_FOLDERS, WORKSPACE_NOTES } from '@penmoss/sync-client/workspace';
import * as Y from '@y/y';

/** The WorkspaceDoc's root node of purged note ids (value: when, epoch ms). */
export const WORKSPACE_PURGED = 'purged';
/**
 * Where each purged note was filed when it was marked (value: `{ folder, position }`), so Keep
 * note puts it back there (A855). Absent for a note the tree did not file (in Trash). Once the
 * purge has landed, Keep note no longer applies: the engine takes the entry out at its next sync.
 */
export const WORKSPACE_PURGED_FROM = 'purgedFrom';

interface PurgedFrom {
  readonly folder: string | null;
  readonly position: string | null;
}

export function purgedIds(workspace: Y.Doc): Set<string> {
  return new Set([...workspace.get(WORKSPACE_PURGED).attrKeys()].map(String));
}

export function isPurged(workspace: Y.Doc, noteId: string): boolean {
  return workspace.get(WORKSPACE_PURGED).hasAttr(noteId);
}

/** Records `noteId` as deleted for good and takes it out of the tree, noting where it was. */
export function markPurged(workspace: Y.Doc, noteId: string, at: number, origin: unknown = null) {
  workspace.transact(() => {
    workspace.get(WORKSPACE_PURGED).setAttr(noteId, at);
    const entry: unknown = workspace.get(WORKSPACE_NOTES).getAttr(noteId);
    if (entry instanceof Y.Node) {
      const folder: unknown = entry.getAttr('folder');
      const position: unknown = entry.getAttr('position');
      const from: PurgedFrom = {
        folder: typeof folder === 'string' ? folder : null,
        position: typeof position === 'string' ? position : null,
      };
      workspace.get(WORKSPACE_PURGED_FROM).setAttr(noteId, from);
    }
    if (workspace.get(WORKSPACE_NOTES).hasAttr(noteId)) {
      workspace.get(WORKSPACE_NOTES).deleteAttr(noteId);
    }
  }, origin);
}

/**
 * Takes a purge back before it landed (Keep note, A855): the id leaves `purged` and the note is
 * filed again where it was when marked (the top level if that folder is gone); a note that was in
 * Trash, unfiled, stays in Trash. Its logs are on the branch untouched, so every engine reads it
 * back from there. A purge that landed is never taken back: engines mark it again, and the Mac's
 * main process refuses a commit without it.
 */
export function unmarkPurged(workspace: Y.Doc, noteId: string, origin: unknown = null): void {
  workspace.transact(() => {
    if (workspace.get(WORKSPACE_PURGED).hasAttr(noteId)) {
      workspace.get(WORKSPACE_PURGED).deleteAttr(noteId);
    }
    const from: unknown = workspace.get(WORKSPACE_PURGED_FROM).getAttr(noteId);
    if (workspace.get(WORKSPACE_PURGED_FROM).hasAttr(noteId)) {
      workspace.get(WORKSPACE_PURGED_FROM).deleteAttr(noteId);
    }
    if (typeof from !== 'object' || from === null) return;
    const { folder, position } = from as Partial<PurgedFrom>;
    const there =
      typeof folder === 'string' &&
      workspace.get(WORKSPACE_FOLDERS).getAttr(folder) instanceof Y.Node
        ? folder
        : null;
    registerNote(
      workspace,
      {
        id: noteId,
        folderId: there,
        ...(there === folder && typeof position === 'string' ? { position } : {}),
      },
      origin,
    );
  }, origin);
}

/**
 * Where each note brought back after a store was cleared came from (A886): copy id → the
 * original's id, synced like `purgedFrom`. A copy whose original another device deleted for good
 * before the copy first reached the branch is withheld from the push (`racedCopies`): kept on
 * this device only, for the person to keep and sync, save or delete; main refuses a commit that
 * adds one unless the person confirmed it. Once a copy is on the branch the link stays, and a
 * later purge of the original leaves it.
 */
export const WORKSPACE_RECOVERED_FROM = 'recoveredFrom';

/** Every copy's original, by copy id. */
export function recoveredFromOf(workspace: Y.Doc): Map<string, string> {
  const out = new Map<string, string>();
  const node = workspace.get(WORKSPACE_RECOVERED_FROM);
  for (const key of [...node.attrKeys()].map(String)) {
    const value: unknown = node.getAttr(key);
    if (typeof value === 'string') out.set(key, value);
  }
  return out;
}

/** Records that `copyId` was brought back from `originId`'s old copy. */
export function markRecoveredFrom(
  workspace: Y.Doc,
  copyId: string,
  originId: string,
  origin: unknown = null,
): void {
  workspace.transact(() => {
    workspace.get(WORKSPACE_RECOVERED_FROM).setAttr(copyId, originId);
  }, origin);
}

/** What `racedCopies` weighs, besides the WorkspaceDoc's links. */
export interface RaceCheck {
  /**
   * Notes deleted for good at the fetched head: only a purge fetched from the branch counts. A
   * purge made on this device never withholds a copy: the person can see the copy, and chose to
   * delete only the original.
   */
  readonly landed: ReadonlySet<string>;
  /** Every note deleted for good here (landed or not): a copy that is itself one goes anyway. */
  readonly purged: ReadonlySet<string>;
  /** Whether a log of the note is at head: a copy on the branch is never withheld. */
  readonly atHead: (noteId: string) => boolean;
  /** Whether this device holds the copy (its doc): nothing else can be withheld. */
  readonly held: (noteId: string) => boolean;
  /** Copies the person confirmed keeping and syncing (Keep and sync): pushed as they are. */
  readonly kept: ReadonlySet<string>;
}

/**
 * The copies to withhold from a commit: their original is deleted for good at the fetched head,
 * they have never reached the branch, and the person has not confirmed keeping them.
 */
export function racedCopies(workspace: Y.Doc, check: RaceCheck): string[] {
  return [...recoveredFromOf(workspace)]
    .filter(
      ([copy, from]) =>
        check.landed.has(from) &&
        !check.purged.has(copy) &&
        !check.atHead(copy) &&
        check.held(copy) &&
        !check.kept.has(copy),
    )
    .map(([copy]) => copy)
    .sort();
}

/**
 * Takes a copy out of the tree and its link with it, for a copy that never reached the branch:
 * withheld (its content is kept on this device), or one whose own log cannot be written, so its
 * entry never lands without it.
 */
export function unregisterCopy(workspace: Y.Doc, copyId: string, origin: unknown = null): void {
  workspace.transact(() => {
    if (workspace.get(WORKSPACE_NOTES).hasAttr(copyId))
      workspace.get(WORKSPACE_NOTES).deleteAttr(copyId);
    if (workspace.get(WORKSPACE_RECOVERED_FROM).hasAttr(copyId)) {
      workspace.get(WORKSPACE_RECOVERED_FROM).deleteAttr(copyId);
    }
  }, origin);
}
