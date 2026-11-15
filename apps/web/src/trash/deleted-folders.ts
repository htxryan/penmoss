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
    refused?: true;
    notes: number;
    skipped: readonly string[];
  },
): string {
  if (result.refused) {
    return `“${name}” can’t be restored: the folder it was in is gone, and Trash no longer knows where that was.`;
  }
  if (!result.restored) return `“${name}” is not in Trash any more.`;
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
