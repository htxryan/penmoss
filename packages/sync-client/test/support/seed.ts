import { META_STORE, NOTES_STORE, toMeta, type NoteRecord } from '../../src/idb';

/**
 * Writes `records` and their list metadata straight into a closed NoteStore database, in one
 * transaction, as the store itself would (a quick way to seed thousands of notes).
 */
export async function seedRecords(name: string, records: readonly NoteRecord[]): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([NOTES_STORE, META_STORE], 'readwrite');
      for (const record of records) {
        transaction.objectStore(NOTES_STORE).put(record);
        transaction.objectStore(META_STORE).put(toMeta(record));
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('write failed'));
    });
  } finally {
    db.close();
  }
}
