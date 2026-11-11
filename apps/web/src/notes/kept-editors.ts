import type { CollabEditor, FileServices } from '@penmoss/editor';
import { isDeleted } from '@penmoss/sync-client/note';
import type { NoteDirectory } from './directory';
import type { Notes, OpenNote } from './service';

/** The note view showing an editor: where the editor's messages go. */
export interface EditorHost {
  notice(message: string): void;
  /** A copy's result, as a toast: `ok` when it was copied. */
  copied(message: string, ok: boolean): void;
  /** Open the note again: the server's copy replaced it (A5), or it turned unsupported (A158). */
  reopen(): void;
}

/** A note's editor, bound to the note's open replica (T31). */
export interface NoteEditor {
  readonly id: string;
  /** The wikilink registry it was made with: another one (a new workspace) makes a new editor. */
  readonly directory: NoteDirectory;
  readonly note: OpenNote;
  readonly collab: CollabEditor;
  readonly files: FileServices;
  /** The editor's own element (`.note-editor`), moved into the note body of the view showing it. */
  readonly element: HTMLElement;
  /** The view showing it, if any. */
  host: EditorHost | null;
  /** Never shown again (reset, turned unsupported, deleted): closed when its view lets go. */
  stale: boolean;
  /** How many times a view has shown it. */
  shown: number;
  /** Destroys the editor and closes the note. */
  dispose(): void;
}

/**
 * Editors of the notes shown last, kept open for a while after their view
 * closes (T31): switching back to one of them shows it at once instead of
 * reading the note from IndexedDB, decoding it and binding a new editor,
 * which is most of opening a long note. A kept note stays open as the shown
 * one is: synced over its socket and saved as it changes, so its editor is
 * current when shown again. Kept only while a note view shows another note:
 * a page without one (Trash, Settings, the graph) closes them.
 */
export const KEEP = 2;

interface Shelf {
  /** Most recently shown first. */
  readonly kept: NoteEditor[];
  /** Note views mounted now, showing a note or opening one. */
  views: number;
  sweep: ReturnType<typeof setTimeout> | null;
}

const shelves = new WeakMap<Notes, Shelf>();

function shelfOf(notes: Notes): Shelf {
  let shelf = shelves.get(notes);
  if (!shelf) {
    shelf = { kept: [], views: 0, sweep: null };
    shelves.set(notes, shelf);
  }
  return shelf;
}

/** The ids of the notes whose editors are kept now, most recently shown first (for tests). */
export function keptNotes(notes: Notes): string[] {
  return (shelves.get(notes)?.kept ?? []).map((editor) => editor.id);
}

/** A note view mounted; returns its unmount. */
export function viewMounted(notes: Notes): () => void {
  const shelf = shelfOf(notes);
  shelf.views++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    shelf.views--;
    // Checked once the commit is over: the next note's view mounts right after this one goes.
    shelf.sweep ??= setTimeout(() => {
      shelf.sweep = null;
      if (shelf.views === 0) for (const editor of shelf.kept.splice(0)) discard(editor);
    }, 0);
  };
}

/** The kept editor of note `id`, taken off the shelf to be shown; null if there is none. */
export function takeEditor(notes: Notes, id: string, directory: NoteDirectory): NoteEditor | null {
  const shelf = shelfOf(notes);
  const index = shelf.kept.findIndex((editor) => editor.id === id);
  if (index < 0) return null;
  const editor = unshelve(shelf.kept.splice(index, 1)[0]!);
  if (!editor.stale && editor.directory === directory && !editor.note.isClosed) return editor;
  editor.dispose();
  return null;
}

/** Puts an editor its view let go of on the shelf (taken out of the page), or closes it. */
export function keepEditor(notes: Notes, editor: NoteEditor): void {
  editor.host = null;
  editor.element.remove();
  const { replica } = editor.note;
  if (editor.stale || isDeleted(replica.doc)) return editor.dispose();
  // Stored with its text and links as they are now, as closing it would: while typing they
  // are refreshed only every few seconds, and the next note's Backlinks read them.
  editor.note.saveNow().catch(() => undefined); // Retried with backoff by the provider.
  const shelf = shelfOf(notes);
  shelf.kept.unshift(editor);
  // Moved to Trash while kept (here, from the sidebar, or on another device; purging takes
  // a note in Trash): closed, so the list drops it as for a closed note. Not the note list:
  // a note just made is missing from it for a moment.
  const offUpdate = replica.onUpdate(() => {
    if (isDeleted(replica.doc)) dropEditor(notes, editor);
  });
  unwatch.set(editor, offUpdate);
  for (const old of shelf.kept.splice(KEEP)) discard(old);
}

/** What stops watching a kept editor's note. */
const unwatch = new WeakMap<NoteEditor, () => void>();

/** Off the shelf: no longer watched. */
function unshelve(editor: NoteEditor): NoteEditor {
  unwatch.get(editor)?.();
  unwatch.delete(editor);
  return editor;
}

function discard(editor: NoteEditor): void {
  unshelve(editor).dispose();
}

/** Closes a kept editor at once (its note was reset or turned unsupported while kept). */
export function dropEditor(notes: Notes, editor: NoteEditor): void {
  const shelf = shelfOf(notes);
  const index = shelf.kept.indexOf(editor);
  if (index < 0) return;
  shelf.kept.splice(index, 1);
  discard(editor);
}
