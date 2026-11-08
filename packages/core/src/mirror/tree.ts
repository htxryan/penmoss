/**
 * The tree diff of a mirror run (T27, A203). The mirror remembers every file
 * it committed (path and git blob SHA, computed here as git does), so a run
 * sends GitHub one `create tree` request on top of the last commit's tree with
 * only what differs: markdown inline as `content` (no blob request per note),
 * a moved file by its existing blob SHA, a removed file as `sha: null`.
 */

/** `git hash-object` of nothing: the content of a `.gitkeep`. */
export const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** A file a run wants at a path: its blob SHA, and its text when GitHub does not have it yet. */
export interface FileChange {
  readonly sha: string;
  /** UTF-8 text sent inline (markdown); absent when the blob exists (a move, an uploaded file). */
  readonly content?: string;
}

/** A `create tree` entry (GitHub REST: `POST /repos/{owner}/{repo}/git/trees`). */
export type TreeEntry =
  | {
      readonly path: string;
      readonly mode: '100644';
      readonly type: 'blob';
      readonly sha: string | null;
    }
  | {
      readonly path: string;
      readonly mode: '100644';
      readonly type: 'blob';
      readonly content: string;
    };

/**
 * The entries that turn the committed files into the wanted ones. `changes`
 * maps a path to the file wanted there, or null to remove it; paths it leaves
 * out stay as they are. Only paths the mirror committed are ever removed, and a
 * file whose SHA is already there is not sent. Sorted by path.
 */
export function treeEntries(
  committed: ReadonlyMap<string, string>,
  changes: ReadonlyMap<string, FileChange | null>,
): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const [path, change] of changes) {
    const current = committed.get(path);
    if (change === null) {
      if (current !== undefined) entries.push({ path, mode: '100644', type: 'blob', sha: null });
    } else if (current !== change.sha) {
      entries.push(
        change.content !== undefined
          ? { path, mode: '100644', type: 'blob', content: change.content }
          : { path, mode: '100644', type: 'blob', sha: change.sha },
      );
    }
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const encoder = new TextEncoder();

/**
 * The Web Crypto this needs, typed here: core's code is DOM-free and runs in workerd (which adds
 * `DigestStream`), in Node 24 and in browsers (T50 G1: moved from the server, A832).
 */
interface DigestStreamLike {
  getWriter(): {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
  };
  readonly digest: Promise<ArrayBuffer>;
}
declare const crypto: {
  readonly subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
  readonly DigestStream?: new (algorithm: string) => DigestStreamLike;
};

/**
 * The git blob SHA-1 of `bytes` (`git hash-object`): `blob <length>\0` then
 * the bytes. In the Workers runtime the bytes stream through a `DigestStream`
 * rather than being copied after the header (A213); elsewhere they are copied.
 */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = encoder.encode(`blob ${bytes.byteLength}\0`);
  let digest: Uint8Array;
  if (typeof crypto.DigestStream === 'function') {
    const stream = new crypto.DigestStream('SHA-1');
    const writer = stream.getWriter();
    await writer.write(header);
    await writer.write(bytes);
    await writer.close();
    digest = new Uint8Array(await stream.digest);
  } else {
    const object = new Uint8Array(header.byteLength + bytes.byteLength);
    object.set(header);
    object.set(bytes, header.byteLength);
    digest = new Uint8Array(await crypto.subtle.digest('SHA-1', object));
  }
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The git blob SHA-1 of text, as UTF-8. */
export function gitTextSha(text: string): Promise<string> {
  return gitBlobSha(encoder.encode(text));
}
