/**
 * Words for the notebook steps' repository and folder screens (T81, #229, A1562):
 * FirstRunRepos.tsx, which the first run and Add Notebook both show.
 */

/** "3 days ago", "last week": when a repository was last pushed. */
export function pushedWords(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never pushed';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} months ago`;
  const years = Math.round(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
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
