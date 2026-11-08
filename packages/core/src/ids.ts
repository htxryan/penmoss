/**
 * ULIDs (https://github.com/ulid/spec): 48-bit millisecond time + 80 random
 * bits in Crockford base32, so IDs sort by creation time. Used for notes,
 * folders, workspaces, users, devices and tokens.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > 2 ** 48 - 1) {
    throw new RangeError(`ULID time out of range: ${now}`);
  }
  let time = '';
  for (let rest = now, i = 0; i < 10; i++) {
    time = ALPHABET[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = '';
  // 16 characters × 5 bits = 80 bits; one byte per character, masked to 5 bits.
  for (let i = 0; i < 16; i++) random += ALPHABET[bytes[i]! & 31];
  return time + random;
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/** The creation time encoded in a ULID. */
export function ulidTime(id: string): number {
  if (!ULID_PATTERN.test(id)) throw new TypeError(`Not a ULID: ${id}`);
  let time = 0;
  for (const char of id.slice(0, 10)) time = time * 32 + ALPHABET.indexOf(char);
  return time;
}
