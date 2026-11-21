/**
 * Session detail for the note on screen (PEN-177): the editor's NoteUsage (`@penmoss/editor`)
 * while the note shows, recording `note open` (or `switch`, when a kept editor shows again in a
 * tab), typing bursts, splices, the cursor and the selection, and the title's typing. Each event
 * names the note and its folder by their real ids in `refs`, which the Mac's main process swaps
 * for refs; no prop holds an id, a title or a word.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { attachNoteUsage, type NoteUsage } from '@penmoss/editor';
import type { CollabEditor } from '@penmoss/editor/collab';
import { useWorkspaceState } from '../workspace/hooks';
import { flushRecorded, record } from './record';

/** Editors that have recorded a `note open`: showing one again (a tab switched to) is `switch`. */
const opened = new WeakSet<CollabEditor>();

/** The folder a note is filed in, or null at the top level. */
function useFolderOf(noteId: string): string | null {
  const { snapshot } = useWorkspaceState();
  return snapshot.notes.find((entry) => entry.id === noteId)?.folderId ?? null;
}

/**
 * Records the shown note's session detail; `collab` null (not loaded, or a Settings preview, which
 * is not the person's showing) records nothing.
 */
export function useNoteUsage(
  collab: CollabEditor | null,
  noteId: string,
  titleRef: RefObject<HTMLTextAreaElement | null>,
): void {
  const folder = useFolderOf(noteId);
  const folderRef = useRef(folder);
  useLayoutEffect(() => {
    folderRef.current = folder;
  });
  useEffect(() => {
    if (!collab) return;
    const title = titleRef.current;
    let usage: NoteUsage;
    try {
      usage = attachNoteUsage(collab.editor, {
        record: (name, props) =>
          record('note', name, props, {
            note: noteId,
            ...(folderRef.current ? { folder: folderRef.current } : {}),
          }),
        titleLength: () => titleRef.current?.value.length ?? 0,
      });
      usage.open(opened.has(collab) ? 'switch' : 'open');
      opened.add(collab);
    } catch {
      // Recording never breaks the note.
      return;
    }
    const shown = usage;
    let before = title?.value ?? '';
    const onBeforeInput = () => {
      before = title?.value ?? '';
    };
    const onInput = () => {
      const after = title?.value ?? '';
      shown.title(before, after);
      before = after;
    };
    const onFocus = () => {
      before = title?.value ?? '';
      shown.titleFocused();
    };
    const onHide = () => {
      shown.flush();
      flushRecorded();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide();
    };
    title?.addEventListener('beforeinput', onBeforeInput);
    title?.addEventListener('input', onInput);
    title?.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      title?.removeEventListener('beforeinput', onBeforeInput);
      title?.removeEventListener('input', onInput);
      title?.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      shown.destroy();
    };
  }, [collab, noteId, titleRef]);
}
