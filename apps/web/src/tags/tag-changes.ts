/**
 * Changing tags, the one way the sidebar's Tags and the Tags page do it (A1400 to A1403; one set
 * of rules since the architecture review, A1508): the change in every note of the notebook in
 * context, the descriptions moved with their tags, and what its toast says, with an Undo that
 * puts the notes and the descriptions back.
 */
import type { TagChange } from '@penmoss/model/tags';
import { useCallback } from 'react';
import { useNotes } from '../notes/hooks';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import { describedAfter } from './manage';
import type { TagDone } from './TagDoneToast';

/**
 * Makes tag changes in the notebook in context: `change(changes, text)` changes the notes, moves
 * the descriptions, and resolves with what `text(notes changed)` says and its Undo.
 */
export function useTagChanges(): (
  changes: readonly TagChange[],
  text: (notes: number) => string,
) => Promise<TagDone> {
  const notes = useNotes();
  const workspace = useWorkspace();
  const stored = useWorkspaceState().snapshot.tagDescriptions;
  return useCallback(
    async (changes, text) => {
      const before = stored ?? {};
      const moved = describedAfter(before, changes);
      const result = await notes.changeTags(changes);
      for (const [tag, description] of Object.entries(moved)) {
        workspace.setTagDescription(tag, description);
      }
      void workspace.flush().catch(() => undefined);
      return {
        text: text(result.notes.length),
        undo: async () => {
          const back = await result.undo();
          for (const tag of Object.keys(moved)) workspace.setTagDescription(tag, before[tag] ?? '');
          void workspace.flush().catch(() => undefined);
          return back.length;
        },
      };
    },
    [notes, workspace, stored],
  );
}
