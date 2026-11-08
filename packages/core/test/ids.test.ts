import { describe, expect, it } from 'vitest';
import { isUlid, ulid, ulidTime } from '../src/ids';

describe('ulid', () => {
  it('encodes the creation time so IDs sort by it', () => {
    const early = ulid(1_700_000_000_000);
    const late = ulid(1_700_000_000_001);

    expect(isUlid(early)).toBe(true);
    expect(ulidTime(early)).toBe(1_700_000_000_000);
    expect(early < late).toBe(true);
  });

  it('is unique for the same millisecond', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid(1)));
    expect(ids.size).toBe(1000);
  });

  it('rejects times a ULID cannot hold', () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
  });

  it('recognises only canonical ULIDs', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(isUlid('01arz3ndektsv4rrffq69g5fav')).toBe(false);
    expect(isUlid('81ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
  });
});
