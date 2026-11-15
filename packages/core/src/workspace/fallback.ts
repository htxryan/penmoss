/**
 * Where something meant for a folder goes once that folder may be gone (a delete on another
 * device): read the same way by every client, as the folder tree is (A17).
 */
import type { FolderRecord } from './tree';

/**
 * A folder gone from the tree, as Trash remembers it (the WorkspaceDoc's `folderTrash`, T42):
 * where it was.
 */
export interface GoneFolder {
  readonly id: string;
  readonly parentId: string | null;
}

/**
 * Where to put something meant for a folder: the folder itself while it is in the tree, else the
 * nearest folder above it that is (through Trash's records), else the top level. `refused` when
 * Trash no longer remembers a folder on the way up (or two records make a loop): there is no
 * place known, and the caller asks, or refuses.
 */
export type Fallback = { readonly folderId: string | null } | { readonly refused: 'unknown' };

export function folderFallback(
  folders: readonly Pick<FolderRecord, 'id'>[],
  gone: readonly GoneFolder[],
  folderId: string | null,
): Fallback {
  const live = new Set(folders.map((folder) => folder.id));
  if (folderId === null || live.has(folderId)) return { folderId };
  const trashed = new Map(gone.map((folder) => [folder.id, folder]));
  const seen = new Set<string>();
  for (let at: string | null = folderId; ;) {
    if (at === null) return { folderId: null };
    if (live.has(at)) return { folderId: at };
    const record = trashed.get(at);
    if (!record || seen.has(at)) return { refused: 'unknown' };
    seen.add(at);
    at = record.parentId;
  }
}
