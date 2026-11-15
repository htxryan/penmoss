/**
 * A note's plain text as the Android app's offline index stores it (T40 P6,
 * FD4): `plainText` of the note's document, cut to at most MAX_NOTE_TEXT_BYTES
 * of UTF-8 at a character boundary. The editor page reports the open note's
 * text and headings through `capNoteText`, so the phone's stored copy is cut
 * the same way wherever it came from.
 */

/** The most of a note's text the phone stores: 256 KB of UTF-8. */
export const MAX_NOTE_TEXT_BYTES = 256 * 1024;

const encoder = new TextEncoder();

/** The most of a note's headings (one per line) the phone stores: 64 KB. */
export const MAX_NOTE_HEADINGS_BYTES = 64 * 1024;

/**
 * What a note's text hash covers (T40 P6, FD4, S6): its capped text and its capped headings,
 * apart, hashed with SHA-256 (Android's `textHash` in Kotlin builds the same key).
 */
export function noteTextKey(text: string, headings: string): string {
  return `${text}\u0000${headings}`;
}

/** `text` cut to at most `maxBytes` of UTF-8, never inside a character. */
export function capNoteText(text: string, maxBytes: number = MAX_NOTE_TEXT_BYTES): string {
  // Each UTF-16 unit is at most 3 bytes: short text needs no encoding.
  if (text.length * 3 <= maxBytes) return text;
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Back to the first byte of a character (continuation bytes are 10xxxxxx).
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}
