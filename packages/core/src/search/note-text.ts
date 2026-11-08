/**
 * A note's plain text as the Android app's offline index stores it (T40 P6,
 * FD4): the text the server indexes (`plainText` of the note's document),
 * cut to at most MAX_NOTE_TEXT_BYTES of UTF-8 at a character boundary. The
 * server sends it in `/sync/batch` replies and the editor page reports the
 * open note's, both through `capNoteText`, so a phone's stored copy and the
 * server's hash agree on the same note.
 */

/** The most of a note's text the phone stores and the server sends: 256 KB of UTF-8. */
export const MAX_NOTE_TEXT_BYTES = 256 * 1024;

const encoder = new TextEncoder();

/** The most of a note's headings (one per line) the phone stores and the server sends: 64 KB. */
export const MAX_NOTE_HEADINGS_BYTES = 64 * 1024;

/**
 * What a note's text hash covers (T40 P6, FD4, S6): its capped text and its capped headings,
 * apart. The server hashes it with SHA-256; the phone compares its own copy's.
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
