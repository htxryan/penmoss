/**
 * Removing a git notebook leaves no local data behind (T50 G5, #153): its notes store and its
 * engine's copy are deleted in this browser profile once its source has stopped. Main deletes
 * the clone and its secrets. Other windows close their connections on `versionchange`.
 */
import { engineDbName } from './engine-store';
import { gitStoreName } from './git-source';

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve();
      return;
    }
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    // Blocked: another window still has it open; it closes on versionchange and this goes on.
    request.onblocked = () => undefined;
  });
}

export async function forgetGitStores(notebookId: string): Promise<void> {
  await Promise.all([
    deleteDatabase(gitStoreName(notebookId)),
    deleteDatabase(engineDbName(notebookId)),
  ]);
}
