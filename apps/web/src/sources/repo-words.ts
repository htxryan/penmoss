/**
 * Words and keys shared by Add a Git Notebook's repository and folder steps (T81, #229):
 * RepoPicker.tsx and RepoFolderStep.tsx.
 */
import type { KeyboardEvent } from 'react';
import type { BrowseError } from '../desktop/bridge';

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

/** The refusals that mean no usable sign-in: the form offers typing and the sign-in hint (B8). */
export const SIGNED_OUT: ReadonlySet<BrowseError['reason']> = new Set([
  'no_credential',
  'timeout',
  'unauthorized',
]);

/** Moves focus through a list's enabled options with the arrow keys, Home and End. */
export function listKeys(event: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const list = event.currentTarget;
  const options = [
    ...list.querySelectorAll<HTMLButtonElement>('[role="option"]:not([aria-disabled="true"])'),
  ];
  if (options.length === 0) return;
  event.preventDefault();
  const at = options.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown'
          ? Math.min(options.length - 1, at + 1)
          : Math.max(0, at - 1);
  options[next]!.focus();
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
