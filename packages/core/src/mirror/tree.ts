/**
 * The git blob SHA of a file, computed as git does (`git hash-object`): the engine names every
 * file it commits by it.
 */

const encoder = new TextEncoder();

/**
 * The Web Crypto this needs, typed here: core's code is DOM-free and runs in workerd (which adds
 * `DigestStream`), in Node 24 and in browsers (T50 G1, A832).
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
