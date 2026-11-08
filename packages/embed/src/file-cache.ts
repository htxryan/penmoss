/**
 * Vectors on disk (A1153), shared by the app's embedding service and every CLI and MCP process:
 * `~/.penmoss/vectors/<model>/`, one append-only segment per stable writer id (`app`, `mcp`,
 * `cli`) and a compacted `base.bin`, merged on read. Records have a fixed size (the key, the
 * vector, a CRC-32), so a record torn by a crash is recognised and ignored. Readers pick up other
 * writers' appends by reading each segment's new tail; the lease holder (A1157) compacts by
 * writing a new base and renaming it into place, keeping only the keys still in use. An append
 * racing a compaction can be lost: a cache miss embedded again later, never a wrong vector.
 */
import { mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { VectorCache } from '@penmoss/core/search';

const MAGIC = 0x434d5650; // "PVMC", little-endian
const VERSION = 1;
const HEADER_BYTES = 16;
const KEY_BYTES = 32;
const BASE = 'base.bin';
const SEGMENT = /^seg-([a-z0-9-]+)\.bin$/;

/** The cache's folder for a model id (its `/` and `@` made safe for a file name). */
export function vectorsDir(home: string, model: string): string {
  return join(home, 'vectors', model.replace(/[^A-Za-z0-9._-]/g, '_'));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface Tail {
  /** The file's identity, so a replaced base or a deleted segment is noticed. */
  ino: number;
  offset: number;
}

export interface FileVectorCacheOptions {
  readonly home: string;
  readonly model: string;
  readonly dimensions: number;
  /** This process's segment: `app`, `mcp` or `cli`. */
  readonly writer: string;
}

export class FileVectorCache implements VectorCache {
  readonly dir: string;
  private readonly recordBytes: number;
  private readonly vectors = new Map<string, Float32Array>();
  private readonly tails = new Map<string, Tail>();

  constructor(private readonly options: FileVectorCacheOptions) {
    if (!/^[a-z0-9-]+$/.test(options.writer)) throw new Error(`Bad writer id: ${options.writer}`);
    this.dir = vectorsDir(options.home, options.model);
    this.recordBytes = KEY_BYTES + options.dimensions * 4 + 4;
  }

  /** Vectors held after the last refresh. */
  get size(): number {
    return this.vectors.size;
  }

  async get(keys: readonly string[]): Promise<Map<string, Float32Array>> {
    await this.refresh();
    const found = new Map<string, Float32Array>();
    for (const key of keys) {
      const vector = this.vectors.get(key);
      if (vector) found.set(key, vector);
    }
    return found;
  }

  async put(entries: ReadonlyMap<string, Float32Array>): Promise<void> {
    const fresh = [...entries].filter(([key]) => !this.vectors.has(key));
    if (fresh.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `seg-${this.options.writer}.bin`);
    await this.create(path);
    const handle = await open(path, 'a');
    try {
      // A record torn by a crash is filled out to a whole one, which fails its checksum, so the
      // records after it stay aligned.
      const torn = Math.max(0, (await handle.stat()).size - HEADER_BYTES) % this.recordBytes;
      const filler = torn > 0 ? [Buffer.alloc(this.recordBytes - torn)] : [];
      // One write of whole records: another reader sees all of them or a torn last one.
      await handle.write(
        Buffer.concat([...filler, ...fresh.map(([key, vector]) => this.record(key, vector))]),
      );
    } finally {
      await handle.close();
    }
    for (const [key, vector] of fresh) this.vectors.set(key, vector);
  }

  /**
   * Rewrites the cache as one base holding only `keep` (the lease holder's job, A1157): a new base
   * renamed into place, then the segments it absorbed deleted. Answers how many vectors it dropped.
   */
  async compact(keep: ReadonlySet<string>): Promise<number> {
    await this.refresh();
    await mkdir(this.dir, { recursive: true });
    const absorbed = (await readdir(this.dir)).filter((name) => SEGMENT.test(name));
    const kept = [...this.vectors].filter(([key]) => keep.has(key));
    const temp = join(this.dir, `base.${process.pid}.tmp`);
    const handle = await open(temp, 'w');
    try {
      await handle.write(
        Buffer.concat([this.header(), ...kept.map(([key, vector]) => this.record(key, vector))]),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, join(this.dir, BASE));
    for (const name of absorbed) await unlink(join(this.dir, name)).catch(() => undefined);
    const dropped = this.vectors.size - kept.length;
    this.vectors.clear();
    this.tails.clear();
    await this.refresh();
    return dropped;
  }

  /** Reads what other processes appended since the last call; reloads after a compaction. */
  async refresh(): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const files = names.filter((name) => name === BASE || SEGMENT.test(name));
    const baseInfo = files.includes(BASE)
      ? await stat(join(this.dir, BASE)).catch(() => undefined)
      : undefined;
    const known = this.tails.get(BASE);
    const replaced =
      (baseInfo?.ino ?? 0) !== (known?.ino ?? 0) ||
      [...this.tails.keys()].some((n) => !files.includes(n));
    if (replaced) {
      // Compacted (or cleared) elsewhere: start again from what is on disk.
      this.vectors.clear();
      this.tails.clear();
    }
    for (const name of files.sort()) await this.readTail(name);
  }

  private async readTail(name: string): Promise<void> {
    const path = join(this.dir, name);
    let handle;
    try {
      handle = await open(path, 'r');
    } catch {
      return;
    }
    try {
      const info = await handle.stat();
      let tail = this.tails.get(name);
      if (!tail || tail.ino !== info.ino) tail = { ino: info.ino, offset: 0 };
      if (tail.offset === 0) {
        if (info.size < HEADER_BYTES) return;
        const header = Buffer.alloc(HEADER_BYTES);
        await handle.read(header, 0, HEADER_BYTES, 0);
        const ok =
          header.readUInt32LE(0) === MAGIC &&
          header.readUInt32LE(4) === VERSION &&
          header.readUInt32LE(8) === this.options.dimensions;
        // Another layout or dimension: not ours to read.
        tail.offset = ok ? HEADER_BYTES : info.size;
      }
      const whole = Math.floor((info.size - tail.offset) / this.recordBytes) * this.recordBytes;
      if (whole > 0) {
        const bytes = Buffer.alloc(whole);
        await handle.read(bytes, 0, whole, tail.offset);
        for (let at = 0; at < whole; at += this.recordBytes)
          this.take(bytes.subarray(at, at + this.recordBytes));
        tail.offset += whole;
      }
      this.tails.set(name, tail);
    } finally {
      await handle.close();
    }
  }

  /** Creates a segment with its header, once, even when two processes share a writer id. */
  private async create(path: string): Promise<void> {
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.write(this.header());
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  private take(record: Buffer): void {
    const body = record.subarray(0, record.length - 4);
    if (crc32(body) !== record.readUInt32LE(record.length - 4)) return;
    const key = body.subarray(0, KEY_BYTES).toString('hex');
    const vector = new Float32Array(this.options.dimensions);
    for (let i = 0; i < vector.length; i++) vector[i] = body.readFloatLE(KEY_BYTES + i * 4);
    this.vectors.set(key, vector);
  }

  private header(): Buffer {
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt32LE(VERSION, 4);
    header.writeUInt32LE(this.options.dimensions, 8);
    return header;
  }

  private record(key: string, vector: Float32Array): Buffer {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`Bad chunk key: ${key}`);
    if (vector.length !== this.options.dimensions) {
      throw new Error(
        `A vector of ${vector.length} dimensions in a cache of ${this.options.dimensions}`,
      );
    }
    const record = Buffer.alloc(this.recordBytes);
    Buffer.from(key, 'hex').copy(record, 0);
    for (let i = 0; i < vector.length; i++) record.writeFloatLE(vector[i]!, KEY_BYTES + i * 4);
    record.writeUInt32LE(crc32(record.subarray(0, this.recordBytes - 4)), this.recordBytes - 4);
    return record;
  }
}

/** Deletes the vectors of every model but `keep` (after a model change, or Delete for good). */
export async function removeOtherVectors(home: string, keep: string): Promise<string[]> {
  const root = join(home, 'vectors');
  const own = vectorsDir(home, keep);
  const names = await readdir(root, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const entry of names) {
    const path = join(root, entry.name);
    if (!entry.isDirectory() || path === own) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}
