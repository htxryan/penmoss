/** How Trash words a deleted folder and its restore (T42, A560), apart from its components. */
import type { TrashedFolder } from '@penmoss/sync-client/workspace';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a folder held, in words: "3 notes, 1 subfolder". */
export function folderContents(folder: TrashedFolder): string {
  const parts = [count(folder.notes, 'note', 'notes')];
  if (folder.folders > 0) parts.push(count(folder.folders, 'subfolder', 'subfolders'));
  return parts.join(', ');
}

/** What a restore says: where it went, and the notes it left where they are now. */
export function restoredMessage(
  name: string,
  result: {
    restored: boolean;
    parentGone: boolean;
    parentId?: string | null;
    refused?: { readonly notebook: string | null };
    notes: number;
    skipped: readonly string[];
    notebook?: boolean;
    filed?: readonly string[];
  },
): string {
  if (result.refused) {
    return `“${name}” was in a notebook that is in Trash: restore the notebook first.`;
  }
  if (!result.restored) return `“${name}” is not in Trash any more.`;
  if (result.notebook) {
    // A notebook comes back at the top level with its notes (T43, A755).
    const filed = result.filed?.length ?? 0;
    return `Restored the notebook “${name}” with ${count(filed, 'note', 'notes')}.`;
  }
  const above = result.parentGone && result.parentId != null;
  const parts = [
    `Restored “${name}”${result.parentGone ? (above ? ' in the folder above' : ' at the top level') : ''}.`,
  ];
  if (result.parentGone) parts.push('The folder it was in is gone.');
  if (result.skipped.length > 0) {
    parts.push(
      `${count(result.skipped.length, 'note was', 'notes were')} moved or deleted since, so ${result.skipped.length === 1 ? 'it stays' : 'they stay'} where ${result.skipped.length === 1 ? 'it is' : 'they are'}.`,
    );
  }
  return parts.join(' ');
}
