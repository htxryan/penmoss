/**
 * A git notebook's folders on this device: listing one in the app's order, and creating,
 * renaming, moving, sorting and deleting them, with the preconditions agents pass.
 */
import { isUlid } from '@penmoss/core/ids';
import {
  folderPath,
  folderSubtree,
  keyBetween,
  type FolderRecord,
  type SortMode,
} from '@penmoss/core/workspace';
import { readWorkspace, setSortMode } from '@penmoss/model/workspace';
import { LocalError, type NoteCatalog } from './catalog';

/** The most notes one folder listing returns. */
const MAX_LISTED = 200;

/** A folder as the notes API answers it. */
export type LocalFolder = {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly sortMode: SortMode;
};

/** A change to a folder (`PATCH /api/folders/:id`), with its `expected…` preconditions. */
export interface FolderPatch {
  readonly name?: string;
  readonly expectedName?: string;
  readonly parentId?: string | null;
  readonly changeParent?: boolean;
  readonly expectedParentId?: string | null;
  readonly expectParent?: boolean;
  readonly sortMode?: SortMode;
  readonly place?: { readonly before?: string; readonly after?: string };
}

const folderReply = (folder: FolderRecord): LocalFolder => ({
  id: folder.id,
  name: folder.name,
  parentId: folder.parentId,
  sortMode: folder.sortMode,
});

/** A name one folder can have: not blank, and without `/`. */
function checkName(name: string): void {
  if (!name) throw new LocalError(400, 'invalid_request', 'name must not be blank');
  if (name.includes('/')) {
    throw new LocalError(400, 'invalid_request', 'A folder name cannot contain /: name one folder');
  }
}

export class LocalFolders {
  constructor(private readonly notes: NoteCatalog) {}

  private get workspace() {
    return this.notes.workspace;
  }

  listFolder(input: { readonly folderId?: string; readonly path?: string }, limit = MAX_LISTED) {
    const folders = this.notes.folders();
    let folder: FolderRecord | null = null;
    if (input.folderId !== undefined) {
      folder = this.notes.folder(input.folderId) ?? null;
      if (!folder) throw new LocalError(404, 'folder_not_found', 'No such folder');
    } else if (input.path !== undefined && input.path.trim() && input.path.trim() !== '/') {
      const wanted = input.path
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .toLowerCase();
      folder =
        folders.find((each) => (folderPath(folders, each.id) ?? '').toLowerCase() === wanted) ??
        null;
      if (!folder)
        throw new LocalError(404, 'folder_not_found', `No folder “${input.path.trim()}”`);
    }
    const parentId = folder?.id ?? null;
    const sortMode: SortMode = folder
      ? folder.sortMode
      : readWorkspace(this.workspace).rootSortMode;
    const children = folders.filter((each) => each.parentId === parentId);
    const notes = this.notes.live().filter((note) => note.folderId === parentId);
    const positions = new Map(
      readWorkspace(this.workspace).notes.map((note) => [note.id, note.position]),
    );
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    children.sort(
      sortMode === 'alpha'
        ? byName
        : (a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0),
    );
    notes.sort(
      sortMode === 'alpha'
        ? (a, b) => a.title.localeCompare(b.title)
        : sortMode === 'modified'
          ? (a, b) => b.updatedAt - a.updatedAt
          : (a, b) => ((positions.get(a.id) ?? '') < (positions.get(b.id) ?? '') ? -1 : 1),
    );
    const shown = limit > 0 ? notes.slice(0, limit) : [];
    return {
      folder: folder
        ? { id: folder.id, name: folder.name, path: folderPath(folders, folder.id) ?? folder.name }
        : null,
      folders: children.map((each) => ({
        id: each.id,
        name: each.name,
        path: folderPath(folders, each.id) ?? each.name,
      })),
      notes: shown.map((note) => ({ id: note.id, title: note.title, updatedAt: note.updatedAt })),
      ...(notes.length > shown.length && limit > 0 ? { truncated: true } : {}),
    };
  }

  createFolder(input: {
    readonly id: string;
    readonly name: string;
    readonly parentId: string | null;
    readonly reuseName?: boolean;
  }): { status: 200 | 201; folder: LocalFolder } {
    const name = input.name.trim();
    checkName(name);
    if (!isUlid(input.id)) throw new LocalError(400, 'invalid_request', 'Invalid folder id');
    const existing = this.notes.folder(input.id);
    if (existing) return { status: 200, folder: folderReply(existing) };
    if (input.parentId !== null && !this.notes.folder(input.parentId)) {
      throw new LocalError(422, 'folder_not_found', 'No such folder');
    }
    if (input.reuseName) {
      const same = this.notes
        .folders()
        .find(
          (each) =>
            each.parentId === input.parentId && each.name.toLowerCase() === name.toLowerCase(),
        );
      if (same) return { status: 200, folder: folderReply(same) };
    }
    this.notes.op(() =>
      this.notes.ops.createFolder({ id: input.id, name, parentId: input.parentId }),
    );
    return { status: 201, folder: folderReply(this.notes.folder(input.id)!) };
  }

  patchFolder(id: string, patch: FolderPatch): LocalFolder {
    const folder = this.notes.folder(id);
    if (!folder) throw new LocalError(404, 'folder_not_found', 'No such folder');
    if (patch.expectedName !== undefined && patch.expectedName !== folder.name) {
      throw new LocalError(409, 'folder_changed', `The folder is now named “${folder.name}”`, {
        name: folder.name,
      });
    }
    if (patch.expectParent && (patch.expectedParentId ?? null) !== folder.parentId) {
      throw new LocalError(409, 'folder_moved', 'The folder moved since', {
        parentId: folder.parentId,
      });
    }
    const name = patch.name?.trim();
    if (name !== undefined) checkName(name);
    let parentId = folder.parentId;
    if (patch.changeParent) {
      parentId = patch.parentId ?? null;
      if (parentId !== null && !this.notes.folder(parentId)) {
        throw new LocalError(422, 'folder_not_found', 'No such folder');
      }
      if (parentId !== null && folderSubtree(this.notes.folders(), id).has(parentId)) {
        throw new LocalError(
          409,
          'folder_cycle',
          'A folder cannot move into itself or one of its subfolders',
        );
      }
    }
    let position: string | undefined;
    const sibling = patch.place?.before ?? patch.place?.after;
    if (sibling !== undefined) {
      const siblings = this.notes
        .folders()
        .filter((each) => each.parentId === parentId && each.id !== id)
        .sort((a, b) => (a.position < b.position ? -1 : 1));
      const at = siblings.findIndex((each) => each.id === sibling);
      if (at < 0) throw new LocalError(422, 'folder_not_found', 'The sibling folder is not there');
      position =
        patch.place?.before !== undefined
          ? keyBetween(siblings[at - 1]?.position ?? null, siblings[at]!.position)
          : keyBetween(siblings[at]!.position, siblings[at + 1]?.position ?? null);
    }
    const ops = this.notes.ops;
    this.notes.op(() => {
      if (name !== undefined && name !== folder.name) ops.renameFolder(id, name);
      if (patch.changeParent || position !== undefined) {
        if (patch.changeParent && position === undefined && parentId !== folder.parentId) {
          const last = this.notes
            .folders()
            .filter((each) => each.parentId === parentId)
            .map((each) => each.position)
            .sort()
            .at(-1);
          position = keyBetween(last ?? null, null);
        }
        if (position !== undefined || parentId !== folder.parentId) {
          ops.moveFolder(id, parentId, position ?? folder.position);
        }
      }
      if (patch.sortMode !== undefined) setSortMode(this.workspace, id, patch.sortMode);
    });
    return folderReply(this.notes.folder(id)!);
  }

  patchRoot(sortMode: SortMode) {
    setSortMode(this.workspace, null, sortMode);
    return { sortMode: readWorkspace(this.workspace).rootSortMode };
  }

  deleteFolder(id: string) {
    if (!this.notes.folder(id)) return { id, deleted: false, inTrash: false };
    this.notes.op(() => this.notes.ops.deleteFolder(id));
    return { id, deleted: true, inTrash: true };
  }
}
