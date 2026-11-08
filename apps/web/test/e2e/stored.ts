import { readSettings, readWorkspace, WORKSPACE_RECORD_KEY } from '@penmoss/sync-client/workspace';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import type { Page } from '@playwright/test';

// What this browser has stored on the device (IndexedDB, A7), for tests that must not leave a
// page (close, reload, navigate) before a change is written: a page that goes keeps only what
// was stored (A622, A624). Each git notebook has its own store, `penmoss-git-<id>` (T50); the
// test's one notebook is found by itself unless `notebookId` names another.

/** The IndexedDB name of a git notebook's notes store (`gitStoreName`). */
export const gitStoreName = (notebookId: string) => `penmoss-git-${notebookId}`;

/** The record this browser stored under `key`: a note's, or the workspace's. */
export async function storedRecord(
  page: Page,
  key: string,
  notebookId?: string,
): Promise<{
  readonly text: string;
  readonly update: number[];
} | null> {
  return page.evaluate(
    async ({ id, name }) => {
      let store = name;
      if (!store) {
        // The one notebook's store (its engine keeps another, `penmoss-git-engine-<id>`).
        const names = (await indexedDB.databases())
          .map((database) => database.name ?? '')
          .filter(
            (each) => each.startsWith('penmoss-git-') && !each.startsWith('penmoss-git-engine-'),
          );
        if (names.length !== 1) return null;
        store = names[0]!;
      }
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      });
      try {
        if (!db.objectStoreNames.contains('notes')) return null;
        const record = await new Promise<{ text?: string; update: Uint8Array } | undefined>(
          (resolve, reject) => {
            const request = db.transaction('notes').objectStore('notes').get(id);
            request.onsuccess = () => resolve(request.result as never);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
          },
        );
        return record ? { text: record.text ?? '', update: [...record.update] } : null;
      } finally {
        db.close();
      }
    },
    { id: key, name: notebookId ? gitStoreName(notebookId) : null },
  );
}

/** The stored workspace, read as the app reads it, or null when none is stored yet. */
async function storedWorkspace<T>(
  page: Page,
  read: (doc: ReturnType<typeof createYjs14Replica>) => T,
  notebookId?: string,
): Promise<T | null> {
  const record = await storedRecord(page, WORKSPACE_RECORD_KEY, notebookId);
  return record ? withDoc(new Uint8Array(record.update), read) : null;
}

function withDoc<T>(
  update: Uint8Array,
  read: (replica: ReturnType<typeof createYjs14Replica>) => T,
) {
  const replica = createYjs14Replica();
  try {
    replica.applyUpdate(update);
    return read(replica);
  } finally {
    replica.destroy();
  }
}

/** The plain text of the document a note's stored record holds (not its stored `text`, A695). */
export async function storedDocumentText(
  page: Page,
  noteId: string,
  notebookId?: string,
): Promise<string | null> {
  const record = await storedRecord(page, noteId, notebookId);
  return record ? withDoc(new Uint8Array(record.update), (replica) => replica.plainText()) : null;
}

/** The folder names in the workspace this browser stored. */
export async function storedFolders(page: Page, notebookId?: string): Promise<string[]> {
  const names = await storedWorkspace(
    page,
    (replica) => readWorkspace(replica.doc).folders.map((folder) => folder.name),
    notebookId,
  );
  return names ?? [];
}

/**
 * Setting `key` in the notebook this browser stored: the notebook's own (`timeZone`,
 * `template.*`) or this device's, which a git notebook keeps under `device` (A827).
 */
export async function storedSetting(
  page: Page,
  key: string,
  notebookId?: string,
): Promise<unknown> {
  const map = key === 'timeZone' || key.startsWith('template.') ? 'notebook' : 'device';
  return storedWorkspace(page, (replica) => readSettings(replica.doc, map)[key], notebookId);
}
