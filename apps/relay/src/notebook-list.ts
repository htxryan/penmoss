/**
 * The notebooks a relay serves (PEN-194, R2): the list its owner keeps on the Notebooks page, in
 * the Durable Object's storage beside the App. A notebook reached by a token keeps the token
 * here, never in a page: the page shows its last four characters.
 */
import type { NotebookPlace, Place } from './config';
import type { Blobs } from './storage';

export interface StoredNotebook extends Place {
  /** The notebook's own token (a pasted one, or its account's); absent for the App. */
  readonly token?: string;
  /** Its `notebook.json`'s id and name when it was added (A1701); absent before. */
  readonly id?: string;
  readonly name?: string;
}

const KEY = 'settings:notebooks';

export function readNotebookList(blobs: Blobs): StoredNotebook[] {
  const bytes = blobs.get(KEY);
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as StoredNotebook[]) : [];
}

export function writeNotebookList(blobs: Blobs, list: readonly StoredNotebook[]): void {
  blobs.put(KEY, new TextEncoder().encode(JSON.stringify(list)));
}

export const placesOf = (list: readonly StoredNotebook[]): NotebookPlace[] =>
  list.map((each) => ({
    repository: each.repository,
    branch: each.branch,
    root: each.root,
    access: each.token ? { kind: 'token', token: each.token } : { kind: 'app' },
  }));
