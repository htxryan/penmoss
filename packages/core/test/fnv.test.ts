import { describe, expect, it } from 'vitest';
import { FNV_BASIS, FNV_PRIME, fnv1a } from '../src/fnv';

describe('fnv1a', () => {
  it('gives the published 32-bit FNV-1a values', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });

  it('hashes bytes as it hashes the code units they spell', () => {
    expect(fnv1a(new TextEncoder().encode('foobar'))).toBe(fnv1a('foobar'));
    expect(fnv1a(new Uint8Array())).toBe(FNV_BASIS);
  });

  it('takes another basis, for a salted or second hash, always unsigned', () => {
    expect(fnv1a('', FNV_PRIME)).toBe(FNV_PRIME);
    expect(fnv1a('a', (FNV_BASIS ^ 13) >>> 0)).not.toBe(fnv1a('a'));
    for (const text of ['', 'a', 'é漢😀', 'x'.repeat(1000)]) {
      const hash = fnv1a(text, 0xffffffff);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
