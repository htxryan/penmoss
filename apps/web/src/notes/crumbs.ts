import type { FolderRecord } from '@penmoss/core/workspace';

/**
 * The folders a note sits in, outermost first, for the breadcrumb in its
 * header (T36). A missing parent ends the trail, and a cycle (two devices
 * moving folders into each other) never loops.
 */
export function folderTrail(
  folders: readonly Pick<FolderRecord, 'id' | 'name' | 'parentId'>[],
  folderId: string | null,
): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: string[] = [];
  const seen = new Set<string>();
  for (let id = folderId; id !== null && !seen.has(id);) {
    seen.add(id);
    const folder = byId.get(id);
    if (!folder) break;
    trail.unshift(folder.name);
    id = folder.parentId;
  }
  return trail;
}
