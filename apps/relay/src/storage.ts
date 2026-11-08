/**
 * Where the relay keeps its copy of the notebook (T55): the Durable Object's SQLite, as rows of
 * bytes by key. It is a cache of the repository plus this writer's bookkeeping (A821): losing it
 * loses nothing pushed, and a fresh copy is read back from GitHub. A save is one transaction, so
 * it lands whole or not at all.
 */
import {
  EMPTY_META,
  type NotebookChange,
  type NotebookMeta,
  type NotebookSnapshot,
  type NotebookStorage,
  type WriterSecrets,
} from '@penmoss/git-notebook';

/** Keyed bytes with a transaction: SQLite in the Durable Object, a Map in tests. */
export interface Blobs {
  get(key: string): Uint8Array | null;
  put(key: string, bytes: Uint8Array): void;
  delete(key: string): void;
  keys(prefix: string): string[];
  transaction(run: () => void): void;
  clear(): void;
}

/** SQLite rows hold at most 2 MB; a value is split into parts below that. */
const PART_BYTES = 1024 * 1024;

/** The slice of `DurableObjectStorage` the relay uses. */
export interface SqlStorageLike {
  readonly sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(run: () => T): T;
}

export class SqlBlobs implements Blobs {
  constructor(private readonly storage: SqlStorageLike) {
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS blobs (key TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (key, part))',
    );
  }

  get(key: string): Uint8Array | null {
    const rows = this.storage.sql
      .exec('SELECT bytes FROM blobs WHERE key = ? ORDER BY part', key)
      .toArray();
    if (rows.length === 0) return null;
    const parts = rows.map((row) => new Uint8Array(row['bytes'] as ArrayBuffer));
    if (parts.length === 1) return parts[0]!;
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }

  put(key: string, bytes: Uint8Array): void {
    this.delete(key);
    let part = 0;
    for (let at = 0; part === 0 || at < bytes.byteLength; at += PART_BYTES, part++) {
      const chunk = bytes.slice(at, at + PART_BYTES);
      this.storage.sql.exec(
        'INSERT INTO blobs (key, part, bytes) VALUES (?, ?, ?)',
        key,
        part,
        chunk.buffer,
      );
    }
  }

  delete(key: string): void {
    this.storage.sql.exec('DELETE FROM blobs WHERE key = ?', key);
  }

  keys(prefix: string): string[] {
    return this.storage.sql
      .exec(
        'SELECT DISTINCT key FROM blobs WHERE key >= ? AND key < ? ORDER BY key',
        prefix,
        `${prefix}￿`,
      )
      .toArray()
      .map((row) => String(row['key']));
  }

  transaction(run: () => void): void {
    this.storage.transactionSync(run);
  }

  clear(): void {
    this.storage.sql.exec('DELETE FROM blobs');
  }
}

export class MemoryBlobs implements Blobs {
  readonly map = new Map<string, Uint8Array>();
  get(key: string) {
    return this.map.get(key) ?? null;
  }
  put(key: string, bytes: Uint8Array) {
    this.map.set(key, bytes.slice());
  }
  delete(key: string) {
    this.map.delete(key);
  }
  keys(prefix: string) {
    return [...this.map.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  transaction(run: () => void) {
    const before = new Map(this.map);
    try {
      run();
    } catch (error) {
      this.map.clear();
      for (const [key, value] of before) this.map.set(key, value);
      throw error;
    }
  }
  clear() {
    this.map.clear();
  }
}

const NOTE = 'note:';
const ATTACHMENT = 'attachment:';
const ATTACHMENT_FILE = /^[0-9a-f]{64}\.[a-z0-9]{1,10}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class BlobStorage implements NotebookStorage {
  constructor(private readonly blobs: Blobs) {}

  load(): Promise<NotebookSnapshot | null> {
    const meta = this.blobs.get('meta');
    if (!meta) return Promise.resolve(null);
    const notes = new Map<string, Uint8Array>();
    for (const key of this.blobs.keys(NOTE))
      notes.set(key.slice(NOTE.length), this.blobs.get(key)!);
    return Promise.resolve({
      workspace: this.blobs.get('workspace'),
      notes,
      meta: { ...EMPTY_META, ...(JSON.parse(decoder.decode(meta)) as NotebookMeta) },
    });
  }

  save(change: NotebookChange): Promise<void> {
    this.blobs.transaction(() => {
      if (change.workspace) this.blobs.put('workspace', change.workspace);
      for (const [id, bytes] of change.notes) {
        if (!/^[0-9A-Z]{26}$/.test(id)) throw new Error(`Not a note id: ${id}`);
        if (bytes === null) this.blobs.delete(`${NOTE}${id}`);
        else this.blobs.put(`${NOTE}${id}`, bytes);
      }
      this.blobs.put('meta', encoder.encode(JSON.stringify(change.meta)));
    });
    return Promise.resolve();
  }

  readAttachment(file: string): Promise<Uint8Array | null> {
    if (!ATTACHMENT_FILE.test(file)) return Promise.resolve(null);
    return Promise.resolve(this.blobs.get(`${ATTACHMENT}${file}`));
  }

  writeAttachment(file: string, bytes: Uint8Array): Promise<void> {
    if (!ATTACHMENT_FILE.test(file)) throw new Error(`Not an attachment file name: ${file}`);
    this.blobs.put(`${ATTACHMENT}${file}`, bytes);
    return Promise.resolve();
  }
}

/** The writer's secret (A821), beside the copy: a wiped copy is a new writer, as it should be. */
export class BlobSecrets implements WriterSecrets {
  constructor(private readonly blobs: Blobs) {}
  get(): Promise<string | null> {
    const bytes = this.blobs.get('writer-secret');
    return Promise.resolve(bytes ? decoder.decode(bytes) : null);
  }
  set(secret: string): Promise<void> {
    this.blobs.put('writer-secret', encoder.encode(secret));
    return Promise.resolve();
  }
}
