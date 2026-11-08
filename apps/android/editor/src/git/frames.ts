/**
 * The git engine page's messages to and from the app (T50 G7, A873): one binary frame each, so
 * file bytes cross the bridge as bytes and Kotlin never decodes base64 or reads Yjs (A11).
 *
 * A frame is a big-endian `u32` header length, the header as UTF-8 JSON, then the blobs it names
 * one after another. In the header a blob stands as `{"$b": <index>}` and the header's `b` lists
 * each blob's length. `apps/android/contract/git-engine-v1.json` holds example frames that this
 * file's tests and Kotlin's `GitFrames` tests both read.
 */

/** The frames' version: the app and the page ship in one APK, so it grows by adding calls. */
export const GIT_FRAMES_VERSION = 1;

/** The longest header (JSON) a frame may carry. */
export const MAX_HEADER_BYTES = 16 * 1024 * 1024;

/** The most bytes one frame may carry in all (the app refuses larger ones). */
export const MAX_FRAME_BYTES = 96 * 1024 * 1024;

export interface Frame {
  /** Plain JSON, with each blob as `{ $b: index }`. */
  readonly header: Record<string, unknown>;
  readonly blobs: readonly Uint8Array[];
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

const isBlobRef = (value: unknown): value is { $b: number } =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  Number.isInteger((value as { $b?: unknown }).$b);

/** Replaces every `Uint8Array` in `value` with a blob reference, collecting the bytes. */
function lift(value: unknown, blobs: Uint8Array[]): unknown {
  if (value instanceof Uint8Array) {
    blobs.push(value);
    return { $b: blobs.length - 1 };
  }
  if (Array.isArray(value)) return value.map((each) => lift(each, blobs));
  if (value instanceof Map) {
    throw new FrameError('A Map cannot cross the bridge: send its entries');
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, each] of Object.entries(value)) {
      if (each !== undefined) out[key] = lift(each, blobs);
    }
    return out;
  }
  return value;
}

/** Puts the blobs back where their references are. */
function lower(value: unknown, blobs: readonly Uint8Array[]): unknown {
  if (isBlobRef(value)) {
    const blob = blobs[value.$b];
    if (!blob) throw new FrameError(`The frame has no blob ${value.$b}`);
    return blob;
  }
  if (Array.isArray(value)) return value.map((each) => lower(each, blobs));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, each] of Object.entries(value)) out[key] = lower(each, blobs);
    return out;
  }
  return value;
}

/** A message (any JSON, with `Uint8Array`s anywhere in it) as one frame's bytes. */
export function encodeFrame(message: Record<string, unknown>): Uint8Array {
  const blobs: Uint8Array[] = [];
  const lifted = lift(message, blobs) as Record<string, unknown>;
  const header = new TextEncoder().encode(
    JSON.stringify({ ...lifted, b: blobs.map((blob) => blob.byteLength) }),
  );
  if (header.byteLength > MAX_HEADER_BYTES) throw new FrameError('The frame header is too large');
  const total = 4 + header.byteLength + blobs.reduce((sum, blob) => sum + blob.byteLength, 0);
  if (total > MAX_FRAME_BYTES) throw new FrameError('The frame is too large');
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, header.byteLength, false);
  out.set(header, 4);
  let at = 4 + header.byteLength;
  for (const blob of blobs) {
    out.set(blob, at);
    at += blob.byteLength;
  }
  return out;
}

/** One frame's bytes as its message, blobs in place (views of `bytes`, not copies). */
export function decodeFrame(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength < 4 || bytes.byteLength > MAX_FRAME_BYTES) {
    throw new FrameError('Not a frame');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, false);
  if (length > MAX_HEADER_BYTES || 4 + length > bytes.byteLength) {
    throw new FrameError('The frame header does not fit');
  }
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + length)),
    );
  } catch {
    throw new FrameError('The frame header is not JSON');
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new FrameError('The frame header is not an object');
  }
  const sizes = (header as { b?: unknown }).b ?? [];
  if (!Array.isArray(sizes) || !sizes.every((size) => Number.isInteger(size) && size >= 0)) {
    throw new FrameError('The frame lists no blob sizes');
  }
  const blobs: Uint8Array[] = [];
  let at = 4 + length;
  for (const size of sizes as number[]) {
    if (at + size > bytes.byteLength) throw new FrameError('A blob runs past the frame');
    blobs.push(bytes.subarray(at, at + size));
    at += size;
  }
  if (at !== bytes.byteLength) throw new FrameError('The frame has bytes after its blobs');
  const rest: Record<string, unknown> = { ...(header as Record<string, unknown>) };
  delete rest['b'];
  return lower(rest, blobs) as Record<string, unknown>;
}
