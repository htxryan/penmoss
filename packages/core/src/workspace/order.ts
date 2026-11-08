/**
 * Fractional order keys for manual sorting (T7): strings that sort
 * lexicographically, with a key between any two. Moving an item rewrites
 * only its own key, so concurrent reorders merge. Equal keys (two clients
 * inserting at the same spot) are broken by item id.
 *
 * The scheme follows rocicorp/fractional-indexing (CC0): a variable-length
 * integer part (its first character encodes its length: `a`–`z` positive,
 * `A`–`Z` negative) followed by an optional base-62 fraction with no
 * trailing zero. Appending or prepending bumps the integer, so keys stay
 * short when items are added at either end; inserting between two keys
 * extends the fraction.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0]!;
const LAST = DIGITS[DIGITS.length - 1]!;
const SMALLEST_INTEGER = 'A' + ZERO.repeat(26);

export function isOrderKey(key: string): boolean {
  try {
    validateKey(key);
    return true;
  } catch {
    return false;
  }
}

/** A key strictly between `before` and `after` (null: unbounded on that side). */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null) validateKey(before);
  if (after !== null) validateKey(after);
  if (before !== null && after !== null && before >= after) {
    throw new Error(`Order keys out of order: ${before} >= ${after}`);
  }
  if (before === null) {
    if (after === null) return 'a' + ZERO;
    const intB = integerPart(after);
    const fracB = after.slice(intB.length);
    if (intB === SMALLEST_INTEGER) return intB + midpoint('', fracB);
    if (intB < after) return intB;
    const decremented = decrementInteger(intB);
    if (decremented === null) throw new Error('Cannot go below the smallest order key');
    return decremented;
  }
  const intA = integerPart(before);
  const fracA = before.slice(intA.length);
  if (after === null) {
    const incremented = incrementInteger(intA);
    return incremented === null ? intA + midpoint(fracA, null) : incremented;
  }
  const intB = integerPart(after);
  const fracB = after.slice(intB.length);
  if (intA === intB) return intA + midpoint(fracA, fracB);
  const incremented = incrementInteger(intA);
  if (incremented === null) throw new Error('Cannot go above the largest order key');
  return incremented < after ? incremented : intA + midpoint(fracA, null);
}

/** `count` increasing keys between `before` and `after`. */
export function keysBetween(before: string | null, after: string | null, count: number): string[] {
  const keys: string[] = [];
  let previous = before;
  for (let i = 0; i < count; i++) {
    const key = keyBetween(previous, after);
    keys.push(key);
    previous = key;
  }
  return keys;
}

/** Compares by order key, then id, so every client shows the same order. */
export function compareOrder(
  a: { readonly position: string; readonly id: string },
  b: { readonly position: string; readonly id: string },
): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A fraction strictly between `a` and `b` (b null: above every fraction starting like a). */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`Fractions out of order: ${a} >= ${b}`);
  if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO))) throw new Error('Trailing zero');
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`Invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const length = integerLength(key[0] ?? '');
  if (length > key.length) throw new Error(`Invalid order key: ${key}`);
  return key.slice(0, length);
}

function validateKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error(`Invalid order key: ${key}`);
  const integer = integerPart(key);
  for (const char of key.slice(1)) {
    if (!DIGITS.includes(char)) throw new Error(`Invalid order key: ${key}`);
  }
  if (key.slice(integer.length).endsWith(ZERO)) throw new Error(`Invalid order key: ${key}`);
}

function incrementInteger(integer: string): string | null {
  const head = integer[0]!;
  const digits = integer.slice(1).split('');
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const next = DIGITS.indexOf(digits[i]!) + 1;
    if (next === DIGITS.length) digits[i] = ZERO;
    else {
      digits[i] = DIGITS[next]!;
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join('');
}

function decrementInteger(integer: string): string | null {
  const head = integer[0]!;
  const digits = integer.slice(1).split('');
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const next = DIGITS.indexOf(digits[i]!) - 1;
    if (next === -1) digits[i] = LAST;
    else {
      digits[i] = DIGITS[next]!;
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');
  if (head === 'a') return 'Z' + LAST;
  if (head === 'A') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (nextHead < 'Z') digits.push(LAST);
  else digits.pop();
  return nextHead + digits.join('');
}
