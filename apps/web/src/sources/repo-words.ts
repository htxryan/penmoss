/**
 * Words for the notebook steps' repository and folder screens (T81, #229, A1562):
 * FirstRunRepos.tsx, which the first run and Add Notebook both show.
 */
import { timeAgo } from '@penmoss/core/words';

/** "2 min ago", "Nov 7", "Mar 2, 2024": when a repository was last pushed (core's `timeAgo`). */
export function pushedWords(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never pushed';
  const at = Date.parse(iso);
  return Number.isFinite(at) ? timeAgo(at, now) : '';
}

/** A folder name as the typed Directory takes it: no slashes, no `.` or `..`, no `.git`. */
export function folderNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Name the folder.';
  if (trimmed.includes('/') || trimmed.includes('\\')) return 'One folder at a time: no slashes.';
  if (trimmed === '.' || trimmed === '..' || trimmed === '.git') {
    return 'That name is not a folder git takes.';
  }
  if (trimmed.startsWith('.'))
    return 'Folders starting with a dot are hidden: choose another name.';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed) || trimmed.length > 100) {
    return 'That name is not a folder git takes.';
  }
  return null;
}
