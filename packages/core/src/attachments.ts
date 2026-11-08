/**
 * Content-addressed attachments (T10, A10). A file is named by the SHA-256 of
 * its bytes, so the same image pasted twice, or on two devices, is one file.
 * Notes reference it as `attachments/<sha256>.<ext>`; the git mirror (T27)
 * rewrites that path relative to each note's folder on export. DOM-free: the
 * Worker, the sync client and the editor share these rules.
 */

/** Image types T10 accepts, with their file extensions. SVG is excluded: it can carry script. */
export const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
} as const;

export type ImageType = keyof typeof IMAGE_TYPES;

/** Files over this size are refused (A10). */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/**
 * Files over this size are stored in R2 but kept out of the git mirror (A10,
 * T27). 10 MB, not A10's 20, so an upload fits a Durable Object's memory with
 * room to spare (A213).
 */
export const GIT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** `attachments/<sha256>.<ext>` at the end of a path, after any folder prefix (`../../`). */
const ATTACHMENT_PATH = /(?:^|\/)attachments\/([0-9a-f]{64})\.([a-z0-9]{1,10})$/;

export function isSha256(value: string): boolean {
  return SHA256_HEX.test(value);
}

export function isImageType(value: string): value is ImageType {
  return Object.hasOwn(IMAGE_TYPES, value);
}

/** The path a note stores for an attachment: `attachments/<sha256>.<ext>`. */
export function attachmentPath(sha256: string, type: ImageType): string {
  return `attachments/${sha256}.${IMAGE_TYPES[type]}`;
}

/** The hash and extension of an attachment path (relative prefixes allowed), or null. */
export function parseAttachmentPath(path: string): { sha256: string; ext: string } | null {
  const match = ATTACHMENT_PATH.exec(path);
  return match ? { sha256: match[1]!, ext: match[2]! } : null;
}

const startsWith = (bytes: Uint8Array, offset: number, signature: readonly number[]) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** Bytes `sniffImageType` needs to see (enough for an AVIF `ftyp` box's brand list). */
export const SNIFF_BYTES = 64;

const AVIF_BRANDS = new Set(['avif', 'avis']);

/**
 * Whether an ISO-BMFF `ftyp` box names AVIF as its major brand or as a
 * compatible brand (MIAF files often have major brand `mif1`).
 */
function isAvif(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, 4, ascii('ftyp'))) return false;
  const brand = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  if (AVIF_BRANDS.has(brand(8))) return true;
  // Compatible brands follow the major brand and minor version.
  const end = Math.min(boxSize, bytes.length);
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (AVIF_BRANDS.has(brand(offset))) return true;
  }
  return false;
}

/**
 * The image type a file's first bytes declare (its magic number), or null for
 * anything else. Declared content types are not trusted.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, 0, ascii('GIF87a')) || startsWith(bytes, 0, ascii('GIF89a'))) {
    return 'image/gif';
  }
  if (startsWith(bytes, 0, ascii('RIFF')) && startsWith(bytes, 8, ascii('WEBP'))) {
    return 'image/webp';
  }
  if (isAvif(bytes)) return 'image/avif';
  return null;
}

/**
 * Files other than images (T13, A64). A PDF is recognised by its magic
 * number and shown inline; every other file is stored and served as
 * `application/octet-stream`, to download, whatever it claims to be: HTML,
 * SVG and scripts never render from our origin.
 */
export const PDF_TYPE = 'application/pdf';
export const GENERIC_TYPE = 'application/octet-stream';

export type FileType = ImageType | typeof PDF_TYPE | typeof GENERIC_TYPE;

/** The type a file is stored and served as, from its first bytes (`SNIFF_BYTES`). */
export function sniffFileType(bytes: Uint8Array): FileType {
  const image = sniffImageType(bytes);
  if (image) return image;
  if (startsWith(bytes, 0, ascii('%PDF-'))) return PDF_TYPE;
  return GENERIC_TYPE;
}

/** Types shown in the page (images, and PDFs in the browser's viewer); the rest download. */
export function isInlineType(type: string): boolean {
  return isImageType(type) || type === PDF_TYPE;
}

const EXTENSION = /\.([a-z0-9]{1,10})$/;

/** A file name's extension, lower-cased, or null when it has none we keep. */
export function fileExtension(name: string): string | null {
  return EXTENSION.exec(name.trim().toLowerCase())?.[1] ?? null;
}

/**
 * The path a note stores for a file: `attachments/<sha256>.<ext>`, the
 * extension from the sniffed type (images, PDFs) or else the file's name.
 */
export function filePath(sha256: string, type: FileType, name: string): string {
  const ext = isImageType(type)
    ? IMAGE_TYPES[type]
    : type === PDF_TYPE
      ? 'pdf'
      : (fileExtension(name) ?? 'bin');
  return `attachments/${sha256}.${ext}`;
}

/** A size for people: `512 B`, `1.5 KB`, `20 MB`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${units[unit]}`;
}

/** Lower-case hex SHA-256 of `bytes` (Web Crypto: browsers, Node and workerd). */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
