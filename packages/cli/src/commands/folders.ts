/**
 * mkdir, rmdir, rename and sort: changing folders (T42 item 11, A567), attributed to the clone's
 * writer, through the notebook's folder routes. `mv --folder` (write.ts) moves one.
 */
import { ulid } from '@penmoss/core/ids';
import type { LocalFolder } from '@penmoss/git-notebook/local';
import { UsageError } from '../args';
import type { Command, Context } from '../command';
import { ApiError, CliError, EXIT } from '../errors';
import { listFolder, resolveFolder, type FolderListing } from '../refs';

const FOLDER_HELP =
  'A folder is its path from the top (Projects/Garden, ignoring case), its id, or / for the top level.';

/** The path's folders, top first; blank segments (a leading or doubled /) are dropped. */
function segments(path: string): string[] {
  return path
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The listing of `path`, or null when no such folder exists. */
async function folderAt(context: Context, path: string): Promise<FolderListing | null> {
  try {
    return await listFolder(context, path);
  } catch (error) {
    if (
      (error instanceof ApiError || error instanceof CliError) &&
      error.code === 'folder_not_found'
    ) {
      return null;
    }
    throw error;
  }
}

export const mkdir: Command = {
  name: 'mkdir',
  summary: 'Make a folder',
  usage: ['mkdir [-p] <path>'],
  description: [
    'Makes the folder at path, e.g. Projects/Garden: its parent must exist, as with mkdir. With -p the missing folders along the path are made too, and a folder that is already there is fine.',
    'Names match ignoring case, so mkdir -p projects/garden finds Projects/Garden. The new folder is yours to rename, move or delete in the apps.',
  ],
  flags: [
    {
      name: 'parents',
      short: 'p',
      type: 'boolean',
      description: 'Make the missing folders along the path; no error if it exists',
    },
  ],
  examples: ['penmoss mkdir Projects/Garden', 'penmoss mkdir -p Projects/2027/Garden'],
  async run(context) {
    const [path] = context.args(['path']);
    const parts = segments(path!);
    if (parts.length === 0) throw new UsageError('path names no folder');
    const parents = context.bool('parents');
    // The deepest folder along the path that exists already, looked for from the deepest up:
    // a token scoped to a nested folder cannot see the folders above its own (T42 review S6).
    let found = 0;
    let parentId: string | null = null;
    let last: FolderListing | null = null;
    for (let depth = parts.length; depth >= 1; depth--) {
      const listing = await folderAt(context, parts.slice(0, depth).join('/'));
      if (!listing?.folder) continue;
      found = depth;
      parentId = listing.folder.id;
      last = listing;
      break;
    }
    if (found === parts.length) {
      if (!parents) {
        throw new CliError(
          EXIT.REFUSED,
          `The folder ${last!.folder!.path} exists already.`,
          'folder_exists',
          { id: parentId },
          ['Pass -p to accept a folder that is already there.'],
        );
      }
      context.emit(
        { id: parentId, path: last!.folder!.path, created: [] },
        () => `${last!.folder!.path} exists already.`,
      );
      return;
    }
    if (found < parts.length - 1 && !parents) {
      const missing = parts.slice(0, found + 1).join('/');
      throw new CliError(EXIT.NOT_FOUND, `No folder “${missing}”.`, 'folder_not_found', undefined, [
        'Pass -p to make the missing folders too, or see penmoss ls.',
      ]);
    }
    const created: LocalFolder[] = [];
    for (const name of parts.slice(found)) {
      const under = parentId;
      const reply: LocalFolder = await context.write(
        (notebook) =>
          // The folder's id is made here, as the apps make theirs.
          // reuseName: a folder of that name made since the walk (another mkdir -p) is the answer.
          notebook.createFolder({ id: ulid(), name, parentId: under, reuseName: parents }).folder,
      );
      created.push(reply);
      parentId = reply.id;
    }
    const path_ = parts.join('/');
    context.emit(
      { id: parentId, path: path_, created: created.map((folder) => folder.id) },
      () => `Made ${path_}.`,
    );
  },
};

/** A folder by path or id; the top level is no folder to change. */
async function changeable(context: Context, ref: string): Promise<string> {
  const id = await resolveFolder(context, ref);
  if (id === null) throw new UsageError('the top level is not a folder to change');
  return id;
}

export const rmdir: Command = {
  name: 'rmdir',
  summary: 'Delete a folder (its notes move up)',
  usage: ['rmdir <folder>'],
  description: [
    'Deletes the folder and its subfolders. No note is deleted: their notes move up to the folder’s parent. The folder goes to the notebook’s Trash, where you can restore it with its subfolders and notes; for a clone added with --agent the change is also in the notebook’s Agent activity in the Mac and Android apps, with an Undo, and the repository’s history keeps every change. Deleting a folder that is already gone is fine.',
    FOLDER_HELP,
  ],
  flags: [],
  examples: ['penmoss rmdir Projects/Old'],
  async run(context) {
    const [ref] = context.args(['folder']);
    const id = await changeable(context, ref!);
    const reply = await context.write((notebook) => notebook.deleteFolder(id));
    context.emit(reply, () =>
      reply.deleted
        ? `Moved ${ref} to Trash; its notes moved up. You can restore it, with its subfolders and notes, from the notebook’s Trash in the apps.`
        : `${ref} was already gone.`,
    );
  },
};

export const rename: Command = {
  name: 'rename',
  summary: 'Rename a folder',
  usage: ['rename <folder> <name>'],
  description: [
    'Renames the folder; its notes and subfolders stay in it. If someone renamed it since this command looked it up, nothing changes and it says so (exit 5).',
    FOLDER_HELP,
  ],
  flags: [],
  examples: ['penmoss rename Projects/Garden "Garden 2027"'],
  async run(context) {
    const [ref, name] = context.args(['folder', 'name']);
    if (!name!.trim() || name!.includes('/')) {
      throw new UsageError('name must be one folder’s name, without /');
    }
    const id = await changeable(context, ref!);
    const listing = await listFolder(context, id);
    const reply = await context.write((notebook) =>
      notebook.patchFolder(id, { name: name!.trim(), expectedName: listing.folder?.name ?? '' }),
    );
    context.emit(reply, () => `Renamed ${ref} to ${reply.name}.`);
  },
};

const SORT_MODES = ['manual', 'alpha', 'modified'] as const;

export const sort: Command = {
  name: 'sort',
  summary: 'Set how a folder sorts its notes',
  usage: ['sort <folder> <manual|alpha|modified>'],
  description: [
    'How the apps list a folder’s notes and subfolders: manual (your order), alpha (A–Z) or modified (latest first). / is the top level.',
    FOLDER_HELP,
  ],
  flags: [],
  examples: ['penmoss sort Projects alpha', 'penmoss sort / modified'],
  async run(context) {
    const [ref, mode] = context.args(['folder', 'order']);
    if (!(SORT_MODES as readonly string[]).includes(mode!)) {
      throw new UsageError(`order must be one of ${SORT_MODES.join(', ')}`);
    }
    const id = await resolveFolder(context, ref!);
    const sortMode = mode as (typeof SORT_MODES)[number];
    const reply = await context.write((notebook) =>
      id === null ? notebook.patchRoot(sortMode) : notebook.patchFolder(id, { sortMode }),
    );
    context.emit(
      { folderId: id, sortMode: reply.sortMode },
      () => `${ref} sorts ${reply.sortMode}.`,
    );
  },
};
