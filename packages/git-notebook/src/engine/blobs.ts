/**
 * Reading files at head for the engine, with what this process has read before: logs and actor
 * files are content-addressed, so a blob read once is never read again, and one that is not a Yjs
 * update (or too large) is known as such without reading it again (A822).
 */
import type { Layout } from '../layout';
import type { GitTransport } from '../transport';
import { isUpdate } from '../yjs';
import { formatBytes } from '@penmoss/core/words';

export class BlobReader {
  /** Blob bytes read during this process, by git blob id (logs are content-addressed). */
  private readonly blobs = new Map<string, Uint8Array>();
  /** Blobs that are not Yjs updates, by git blob id: why (A822). */
  private readonly unreadable = new Map<string, string>();

  constructor(
    private readonly layout: Layout,
    /** The largest log read. */
    private readonly maxLogBytes: number,
  ) {}

  /** Reads blobs at `head`, from this process's cache where it has them. */
  async read(
    git: GitTransport,
    head: string,
    files: ReadonlyMap<string, string>,
    paths: Iterable<string>,
  ): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    const missing: string[] = [];
    for (const path of paths) {
      const blob = files.get(path);
      if (blob === undefined) continue;
      const cached = this.blobs.get(blob);
      if (cached) out.set(path, cached);
      else missing.push(path);
    }
    if (missing.length > 0) {
      const read = await git.read(head, missing);
      for (const [path, bytes] of read) {
        out.set(path, bytes);
        const blob = files.get(path);
        // Logs and actor files are kept; rendered files are read once for their frontmatter id.
        if (blob !== undefined && path.startsWith(this.layout.base)) this.blobs.set(blob, bytes);
      }
    }
    return out;
  }

  /**
   * Writers' logs at `head` this writer can use (A822): one too large to read, or not a Yjs
   * update (a corrupt file, a bad merge), is left out and recorded in `skipped`, so one bad file
   * never stops every device's sync. Its writer's other files still count.
   */
  async logs(
    git: GitTransport,
    head: string,
    files: ReadonlyMap<string, string>,
    paths: Iterable<string>,
    skipped: Map<string, string>,
  ): Promise<Map<string, Uint8Array>> {
    const max = this.maxLogBytes;
    const candidates: string[] = [];
    for (const path of paths) {
      const blob = files.get(path);
      if (blob === undefined) continue;
      const known = this.unreadable.get(blob);
      if (known) skipped.set(path, known);
      else candidates.push(path);
    }
    const uncached = candidates.filter((path) => !this.blobs.has(files.get(path)!));
    const sizes = uncached.length > 0 && git.sizes ? await git.sizes(head, uncached) : null;
    const wanted: string[] = [];
    for (const path of candidates) {
      if ((sizes?.get(path) ?? 0) > max) {
        this.unreadable.set(files.get(path)!, tooLarge(max));
        skipped.set(path, tooLarge(max));
      } else {
        wanted.push(path);
      }
    }
    const read = await this.read(git, head, files, wanted);
    const out = new Map<string, Uint8Array>();
    for (const [path, bytes] of read) {
      const blob = files.get(path)!;
      const why =
        bytes.byteLength > max ? tooLarge(max) : isUpdate(bytes) ? null : 'not a Yjs update';
      if (why) {
        this.unreadable.set(blob, why);
        this.blobs.delete(blob);
        skipped.set(path, why);
      } else {
        out.set(path, bytes);
      }
    }
    return out;
  }
}

function tooLarge(max: number): string {
  return `larger than ${formatBytes(max)}`;
}
