import { describe, expect, it } from 'vitest';
import {
  GENERIC_TYPE,
  attachmentPath,
  fileExtension,
  filePath,
  formatBytes,
  isImageType,
  isInlineType,
  isSha256,
  parseAttachmentPath,
  sha256Hex,
  sniffFileType,
  sniffImageType,
} from '../src/attachments';

const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('attachments', () => {
  it('hashes bytes to lower-case hex SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(HASH);
  });

  it('names an image by its hash and type', () => {
    expect(attachmentPath(HASH, 'image/png')).toBe(`attachments/${HASH}.png`);
    expect(attachmentPath(HASH, 'image/jpeg')).toBe(`attachments/${HASH}.jpg`);
  });

  it('reads the hash back from a stored or note-relative path', () => {
    expect(parseAttachmentPath(`attachments/${HASH}.png`)).toEqual({ sha256: HASH, ext: 'png' });
    expect(parseAttachmentPath(`../../attachments/${HASH}.webp`)).toEqual({
      sha256: HASH,
      ext: 'webp',
    });
    expect(parseAttachmentPath(`https://example.com/i.png`)).toBeNull();
    expect(parseAttachmentPath(`attachments/${HASH.toUpperCase()}.png`)).toBeNull();
    expect(parseAttachmentPath(`myattachments/${HASH}.png`)).toBeNull();
  });

  it('checks hashes and types strictly', () => {
    expect(isSha256(HASH)).toBe(true);
    expect(isSha256(HASH.slice(1))).toBe(false);
    expect(isImageType('image/png')).toBe(true);
    expect(isImageType('image/svg+xml')).toBe(false);
    expect(isImageType('toString')).toBe(false);
  });

  it('sniffs image types from magic numbers, not names', () => {
    const ascii = (text: string) => new Uint8Array([...text].map((char) => char.charCodeAt(0)));
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(sniffImageType(ascii('GIF87a...'))).toBe('image/gif');
    expect(sniffImageType(ascii('RIFF\0\0\0\0WAVE'))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe('file attachments (T13)', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('sniffs PDFs, and stores every other non-image as a generic file', () => {
    expect(sniffFileType(bytes('%PDF-1.7\n%âãÏÓ'))).toBe('application/pdf');
    expect(sniffFileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    // HTML, SVG and scripts are files to download, never documents to render.
    expect(sniffFileType(bytes('<!doctype html><script>alert(1)</script>'))).toBe(GENERIC_TYPE);
    expect(sniffFileType(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(GENERIC_TYPE);
    expect(sniffFileType(bytes(' %PDF-1.7'))).toBe(GENERIC_TYPE);
  });

  it('shows only images and PDFs inline', () => {
    expect(isInlineType('image/webp')).toBe(true);
    expect(isInlineType('application/pdf')).toBe(true);
    expect(isInlineType('text/html')).toBe(false);
    expect(isInlineType('image/svg+xml')).toBe(false);
    expect(isInlineType(GENERIC_TYPE)).toBe(false);
  });

  it('names a file by its hash, with an extension from its type or its name', () => {
    const sha = 'a'.repeat(64);
    expect(filePath(sha, 'application/pdf', 'Report.PDF.exe')).toBe(`attachments/${sha}.pdf`);
    expect(filePath(sha, 'image/jpeg', 'photo.png')).toBe(`attachments/${sha}.jpg`);
    expect(filePath(sha, GENERIC_TYPE, 'Budget 2026.XLSX')).toBe(`attachments/${sha}.xlsx`);
    expect(filePath(sha, GENERIC_TYPE, 'notes')).toBe(`attachments/${sha}.bin`);
    expect(filePath(sha, GENERIC_TYPE, 'weird.ex e')).toBe(`attachments/${sha}.bin`);
    expect(filePath(sha, GENERIC_TYPE, 'archive.verylongextension')).toBe(`attachments/${sha}.bin`);
    expect(fileExtension('a.tar.gz')).toBe('gz');
  });

  it('formats sizes for a chip', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatBytes(1.25 * 1024 * 1024 * 1024)).toBe('1.3 GB');
  });
});
