/**
 * Where a git notebook's engine keeps its own copy of the notebook in the Mac app (T50 G3, A860):
 * an IndexedDB database of its own, `penmoss-git-engine-<id>`, beside the notes store the
 * windows edit (`penmoss-git-<id>`). Its copy is what the engine has taken in, so a change a
 * window stored while no engine ran is still new to it at the next start, and is adopted then as
 * a local change (A851) rather than read in as if it had come from git.
 */
import type { NotebookChange, NotebookSnapshot, NotebookStorage } from '@penmoss/git-notebook';

/** A small key-value store (IndexedDB in the app; memory in tests). */
export interface EngineKv {
  get(key: string): Promise<unknown>;
  /** Every entry whose key starts with `prefix`. */
  entries(prefix: string): Promise<Array<[string, unknown]>>;
  /** Writes and deletes in one transaction. */
  write(
    puts: ReadonlyArray<readonly [string, unknown]>,
    deletes?: readonly string[],
  ): Promise<void>;
  close?(): void;
}

const META = 'meta';
const WORKSPACE = 'workspace';
const NOTE = 'note:';
const ATTACHMENT = 'attachment:';
/** Each record's `rev` when the engine last took it in, or wrote it (A851). */
const ADOPTED = 'adopted';

export class EngineStorage implements NotebookStorage {
  constructor(private readonly kv: EngineKv) {}

  async load(): Promise<NotebookSnapshot | null> {
    const meta = (await this.kv.get(META)) as NotebookSnapshot['meta'] | undefined;
    if (!meta) return null;
    const workspace = (await this.kv.get(WORKSPACE)) as Uint8Array | undefined;
    const notes = new Map<string, Uint8Array>();
    for (const [key, value] of await this.kv.entries(NOTE)) {
      if (value instanceof Uint8Array) notes.set(key.slice(NOTE.length), value);
    }
    return { workspace: workspace ?? null, notes, meta };
  }

  async save(change: NotebookChange): Promise<void> {
    const puts: Array<[string, unknown]> = [[META, change.meta]];
    const deletes: string[] = [];
    if (change.workspace) puts.push([WORKSPACE, change.workspace]);
    for (const [id, bytes] of change.notes) {
      if (bytes) puts.push([`${NOTE}${id}`, bytes]);
      else deletes.push(`${NOTE}${id}`);
    }
    await this.kv.write(puts, deletes);
  }

  async readAttachment(file: string): Promise<Uint8Array | null> {
    const bytes = await this.kv.get(`${ATTACHMENT}${file}`);
    return bytes instanceof Uint8Array ? bytes : null;
  }

  async writeAttachment(file: string, bytes: Uint8Array): Promise<void> {
    await this.kv.write([[`${ATTACHMENT}${file}`, bytes]]);
  }

  async adopted(): Promise<Map<string, string>> {
    const value = (await this.kv.get(ADOPTED)) as Record<string, string> | undefined;
    return new Map(Object.entries(value ?? {}));
  }

  async setAdopted(adopted: ReadonlyMap<string, string>): Promise<void> {
    await this.kv.write([[ADOPTED, Object.fromEntries(adopted)]]);
  }
}

/** The engine's database for a notebook. */
export const engineDbName = (notebookId: string) => `penmoss-git-engine-${notebookId}`;

/** An `EngineKv` over IndexedDB. */
export async function idbEngineKv(name: string): Promise<EngineKv> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not open ${name}`));
  });
  // Removing the notebook deletes this database (forget.ts): let it go.
  db.onversionchange = () => db.close();
  const done = (transaction: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
    });
  return {
    get: (key) =>
      new Promise((resolve, reject) => {
        const request = db.transaction('kv').objectStore('kv').get(key);
        request.onsuccess = () => resolve(request.result as unknown);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
      }),
    entries: (prefix) =>
      new Promise((resolve, reject) => {
        const out: Array<[string, unknown]> = [];
        const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
        const request = db.transaction('kv').objectStore('kv').openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(out);
            return;
          }
          if (typeof cursor.key === 'string') out.push([cursor.key, cursor.value as unknown]);
          cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
      }),
    write: async (puts, deletes = []) => {
      const transaction = db.transaction('kv', 'readwrite');
      const store = transaction.objectStore('kv');
      for (const [key, value] of puts) store.put(value, key);
      for (const key of deletes) store.delete(key);
      await done(transaction);
    },
    close: () => db.close(),
  };
}

/** An `EngineKv` in memory (tests). */
export function memoryEngineKv(map = new Map<string, unknown>()): EngineKv & {
  readonly map: Map<string, unknown>;
} {
  return {
    map,
    get: (key) => Promise.resolve(map.get(key)),
    entries: (prefix) =>
      Promise.resolve(
        [...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    write: (puts, deletes = []) => {
      for (const [key, value] of puts) map.set(key, value);
      for (const key of deletes) map.delete(key);
      return Promise.resolve();
    },
  };
}
