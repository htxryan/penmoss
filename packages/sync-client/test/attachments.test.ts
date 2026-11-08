/**
 * Images and files in a git notebook (T59, A1032): each one added is kept on this device and
 * handed to the notebook, which commits it with the note; one this device lacks (another
 * writer's) comes from the notebook, once, and only if its bytes hash to its name.
 */
import { sha256Hex } from '@penmoss/core/attachments';
import { describe, expect, it, vi } from 'vitest';
import type { StoredAttachment } from '../src/attachment-store';
import { Attachments, type AttachmentsElsewhere } from '../src/attachments';

/** One pixel of PNG: its signature is all the sniffing reads. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode('%PDF-1.7 a small file');

function memoryStore() {
  const kept = new Map<string, StoredAttachment>();
  return {
    kept,
    getAttachment: (sha256: string) => Promise.resolve(kept.get(sha256)),
    saveAttachment: (attachment: StoredAttachment) => {
      const added = !kept.has(attachment.sha256);
      kept.set(attachment.sha256, attachment);
      return Promise.resolve(added);
    },
  };
}

function setup(elsewhere?: AttachmentsElsewhere) {
  const store = memoryStore();
  let made = 0;
  const attachments = new Attachments({
    store: () => Promise.resolve(store),
    createUrl: () => `blob:${++made}`,
    revokeUrl: () => undefined,
    ...(elsewhere ? { elsewhere } : {}),
  });
  return { attachments, store };
}

/** A notebook holding `files` (name → bytes), recording what it was handed. */
function notebook(files: Record<string, Uint8Array> = {}) {
  const handed = new Map<string, Uint8Array>();
  const fetch = vi.fn((file: string) => Promise.resolve(files[file] ?? handed.get(file) ?? null));
  return {
    handed,
    fetch,
    elsewhere: {
      kept: (file: string, bytes: Uint8Array) => {
        handed.set(file, bytes);
        return Promise.resolve();
      },
      fetch,
    } satisfies AttachmentsElsewhere,
  };
}

describe('attachments in a git notebook (A1032)', () => {
  it('keeps an image and a file here and hands each to the notebook before giving its path', async () => {
    const nb = notebook();
    const { attachments, store } = setup(nb.elsewhere);
    const image = await attachments.add(new Uint8Array(PNG));
    expect(image.path).toBe(`attachments/${image.sha256}.png`);
    expect(store.kept.has(image.sha256)).toBe(true);
    expect(nb.handed.get(`${image.sha256}.png`)).toEqual(PNG);

    const file = await attachments.addFile(new Uint8Array(PDF), 'Plan.pdf');
    expect(nb.handed.get(`${file.sha256}.pdf`)).toEqual(PDF);
    // Added again: stored once, handed again (the notebook may have lost it).
    nb.handed.clear();
    expect((await attachments.add(new Uint8Array(PNG))).added).toBe(false);
    expect(nb.handed.has(`${image.sha256}.png`)).toBe(true);
  });

  it('shows another writer’s image from the notebook, fetched once and kept here', async () => {
    const sha256 = await sha256Hex(new Uint8Array(PNG));
    const nb = notebook({ [`${sha256}.png`]: PNG });
    const { attachments, store } = setup(nb.elsewhere);
    const src = `attachments/${sha256}.png`;
    const [first, second] = await Promise.all([attachments.url(src), attachments.url(src)]);
    expect(first).toBe('blob:1');
    expect(second).toBe('blob:1');
    expect(nb.fetch).toHaveBeenCalledTimes(1);
    expect(store.kept.get(sha256)).toMatchObject({ type: 'image/png', uploaded: true });
    expect(await attachments.info(src)).toEqual({ size: PNG.byteLength, type: 'image/png' });
    expect(nb.fetch).toHaveBeenCalledTimes(1);
  });

  it('tells a file chip its size from the notebook', async () => {
    const sha256 = await sha256Hex(new Uint8Array(PDF));
    const nb = notebook({ [`${sha256}.pdf`]: PDF });
    const { attachments } = setup(nb.elsewhere);
    expect(await attachments.info(`attachments/${sha256}.pdf`)).toEqual({
      size: PDF.byteLength,
      type: 'application/pdf',
    });
  });

  it('shows nothing for bytes that do not hash to their name, or a file nobody has', async () => {
    const sha256 = await sha256Hex(new Uint8Array(PNG));
    const nb = notebook({ [`${sha256}.png`]: PDF });
    const { attachments, store } = setup(nb.elsewhere);
    expect(await attachments.url(`attachments/${sha256}.png`)).toBeNull();
    expect(store.kept.size).toBe(0);
    expect(await attachments.url(`attachments/${'0'.repeat(64)}.png`)).toBeNull();
    // A notebook that cannot be read is no copy either.
    const broken = setup({
      kept: () => Promise.resolve(),
      fetch: () => Promise.reject(new Error('git failed')),
    });
    expect(await broken.attachments.url(`attachments/${sha256}.png`)).toBeNull();
  });

  it('without a notebook, keeps attachments on this device only', async () => {
    const { attachments } = setup();
    const image = await attachments.add(new Uint8Array(PNG));
    expect(await attachments.url(image.path)).toBe('blob:1');
    expect(await attachments.url(`attachments/${'1'.repeat(64)}.png`)).toBeNull();
  });
});
