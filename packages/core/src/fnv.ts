/**
 * 32-bit FNV-1a, the one hash behind Penmoss's stored ids and stamps: short note references,
 * journal note and folder ids, AI Descriptions' text stamp, cut file names in a mirror and a
 * notebook's default badge. They are stored and compared across devices, so this must never
 * change: `test/fnv.test.ts` pins it to the published FNV-1a vectors.
 */

/** FNV-1a's 32-bit offset basis. */
export const FNV_BASIS = 0x811c9dc5;
/** FNV-1a's 32-bit prime. */
export const FNV_PRIME = 0x01000193;

/**
 * FNV-1a of a string's UTF-16 code units, or of bytes, as an unsigned 32-bit number. `basis`
 * replaces the offset basis, for a salted or second hash.
 */
export function fnv1a(input: string | Uint8Array, basis: number = FNV_BASIS): number {
  let hash = basis >>> 0;
  if (typeof input === 'string') {
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
  } else {
    for (const byte of input) {
      hash ^= byte;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
  }
  return hash >>> 0;
}
