/**
 * Naming notes and folders on the command line (A162). A note is its id (a
 * ULID), its short reference (`K7QD-9HTF2CXA`, PEN-69) or its exact title, ignoring the case of A–Z only (SQLite's NOCASE,
 * A175: "Écoles" does not match "écoles"), looked up in the index (which
 * trails edits by a few seconds); a title several notes share is an error
 * listing them. A folder is `/` (the top level), its path (`Projects/Garden`,
 * ignoring case) or its id.
 */
import { isShortNoteRef } from '@penmoss/core/note-ref';
import { LocalError, type LocalNotebook } from '@penmoss/git-notebook/local';
import type { Context } from './command';
import { ApiError, CliError, EXIT } from './errors';
import { when } from './format';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
/** The most notes an ambiguous title lists; one more is asked for, to know there are more. */
const MAX_LISTED = 20;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

export interface NoteRef {
  readonly id: string;
  /** The title, when the note was named by it. */
  readonly title: string | null;
}

export async function resolveNote(context: Context, ref: string): Promise<NoteRef> {
  const name = ref.trim();
  if (!name) throw new CliError(EXIT.USAGE, 'a note id or title is required', 'invalid_request');
  if (ULID.test(name)) return { id: name.toUpperCase(), title: null };
  // A short reference (PEN-69, `K7QD-9HTF2CXA`): the notebook finds the note it names.
  if (isShortNoteRef(name)) {
    return context.read((notebook) => {
      const id = notebook.noteIdOf(name);
      const found = notebook.describe(id);
      if (!found) throw new LocalError(404, 'not_found', 'No such note');
      return { id, title: found.title };
    });
  }
  const { notes: found } = await context.read((notebook) =>
    notebook.listNotes({ title: name, limit: MAX_LISTED + 1 }),
  );
  if (found.length === 1) return { id: found[0]!.id, title: found[0]!.title };
  if (found.length === 0) {
    throw new CliError(EXIT.NOT_FOUND, `No note titled “${name}”.`, 'not_found', undefined, [
      `Titles match exactly, ignoring the case of A–Z only. Find notes with: penmoss search "${name}"`,
      'A note made in the last few seconds may not be indexed yet: use its id.',
    ]);
  }
  const more = found.length > MAX_LISTED;
  const notes = found.slice(0, MAX_LISTED);
  throw new CliError(
    EXIT.AMBIGUOUS,
    `“${name}” matches ${more ? `more than ${MAX_LISTED}` : notes.length} notes; name one by its id:`,
    'title_ambiguous',
    {
      matches: notes.map((note) => ({ id: note.id, title: note.title, updatedAt: note.updatedAt })),
      ...(more ? { more: true } : {}),
    },
    [
      ...notes.map((note) => `  ${note.id}  ${note.title}  (updated ${when(note.updatedAt)})`),
      ...(more ? [`  … and more (the ${MAX_LISTED} edited most recently are listed)`] : []),
    ],
  );
}

export type FolderListing = ReturnType<LocalNotebook['listFolder']>;

/** A folder's listing by `/`, path or id (a path is tried first, then an id). */
export async function listFolder(
  context: Context,
  ref: string | undefined,
): Promise<FolderListing> {
  const name = ref?.trim() ?? '';
  const list = (input: { folderId?: string; path?: string }) =>
    context.read((notebook) => notebook.listFolder(input));
  if (!name || name === '/') return list({});
  if (ULID.test(name)) return list({ folderId: name });
  try {
    return await list({ path: name });
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'folder_not_found' && ID.test(name))) {
      throw error;
    }
  }
  try {
    return await list({ folderId: name });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'folder_not_found') {
      throw new CliError(EXIT.NOT_FOUND, `No folder “${name}”.`, 'folder_not_found', undefined, [
        'Name a folder by its path from the top (e.g. Projects/Garden) or its id; see penmoss ls.',
      ]);
    }
    throw error;
  }
}

/** A folder's id, or null for the top level. */
export async function resolveFolder(context: Context, ref: string): Promise<string | null> {
  const name = ref.trim();
  if (!name || name === '/') return null;
  if (ULID.test(name)) return name.toUpperCase();
  return (await listFolder(context, name)).folder?.id ?? null;
}
