/**
 * Images and files in notes (T10, T13), kept on this device (T59, A1032).
 *
 * Adding an image hashes it (SHA-256), stores the bytes in IndexedDB once per hash and returns
 * its note path (`attachments/<sha256>.<ext>`) at once. Images are shown from local bytes through
 * object URLs (A30): each URL is shared per image and counted, `url` acquires it, `release` lets
 * it go, and the last release revokes it. Other files take the same path: `addFile` stores a PDF
 * or any other file up to 50 MB, typed by its bytes; `info` tells a chip its size.
 *
 * There is no upload queue any more: the Penmoss server is gone (D49). A git notebook is where
 * attachments go and come from (A1032): `elsewhere.kept` hands each one added to the engine's own
 * store, which commits it with the note as `attachments/<sha256>.<ext>`, and `elsewhere.fetch`
 * reads one this device has no copy of (another writer's) from the engine's store or the clone,
 * kept here once it checks out against its hash.
 */
import {
  GENERIC_TYPE,
  MAX_ATTACHMENT_BYTES,
  SNIFF_BYTES,
  attachmentPath,
  filePath,
  isInlineType,
  parseAttachmentPath,
  sha256Hex,
  sniffFileType,
  sniffImageType,
  type FileType,
  type ImageType,
} from '@penmoss/core/attachments';
import type { AttachmentStore } from './attachment-store';

/**
 * Where a notebook's attachments live besides this device's store (a git notebook, A1032).
 * `file` is the name under `attachments/`: `<sha256>.<ext>`.
 */
export interface AttachmentsElsewhere {
  /** Keeps an attachment just added where the notebook commits it from. */
  kept(file: string, bytes: Uint8Array): Promise<void>;
  /** An attachment this device has no copy of; null when the notebook has none either. */
  fetch(file: string): Promise<Uint8Array | null>;
}

export interface AttachmentsOptions {
  readonly store: () => Promise<Pick<AttachmentStore, 'getAttachment' | 'saveAttachment'>>;
  readonly elsewhere?: AttachmentsElsewhere;
  readonly now?: () => number;
  /** Makes a URL an `<img>` can show (`URL.createObjectURL` of a Blob). */
  readonly createUrl?: (bytes: Uint8Array<ArrayBuffer>, type: string) => string;
  /** Frees such a URL (`URL.revokeObjectURL`). */
  readonly revokeUrl?: (url: string) => void;
}

export interface AddedAttachment {
  readonly sha256: string;
  readonly type: ImageType;
  /** What the note stores: `attachments/<sha256>.<ext>`. */
  readonly path: string;
  /** False when this image was stored already (a duplicate). */
  readonly added: boolean;
}

export interface AddedFile {
  readonly sha256: string;
  readonly type: FileType;
  /** What the note stores: `attachments/<sha256>.<ext>`. */
  readonly path: string;
  readonly added: boolean;
}

/** A stored file's size and type, for an attachment chip. */
export interface FileInfo {
  readonly size: number;
  readonly type: string;
}

/** The image cannot be added (wrong type or too large); the message says why. */
export class AttachmentRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentRejected';
  }
}

/** Refuses a file over 50 MB before anything reads it (T13). */
export function assertFileSize(name: string, bytes: number): void {
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentRejected(`“${name}” is over 50 MB, the largest file Penmoss stores`);
  }
}

interface Loaded {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly type: string;
}

export class Attachments {
  private readonly now: () => number;
  private readonly createUrl: (bytes: Uint8Array<ArrayBuffer>, type: string) => string;
  private readonly revokeUrl: (url: string) => void;
  /** Object URLs in use, by hash, with how many views hold each. */
  private readonly urls = new Map<string, { readonly url: string; refs: number }>();
  /** Fetches from `elsewhere` under way, by hash: one per attachment however many views ask. */
  private readonly fetching = new Map<string, Promise<Loaded | null>>();

  constructor(private readonly options: AttachmentsOptions) {
    this.now = options.now ?? Date.now;
    this.createUrl =
      options.createUrl ?? ((bytes, type) => URL.createObjectURL(new Blob([bytes], { type })));
    this.revokeUrl = options.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  /** Stores an image locally (once per hash). Resolves as soon as the bytes are in IndexedDB. */
  async add(bytes: Uint8Array<ArrayBuffer>): Promise<AddedAttachment> {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentRejected('Images over 50 MB cannot be added');
    }
    const type = sniffImageType(bytes.subarray(0, SNIFF_BYTES));
    if (!type) {
      throw new AttachmentRejected('Only PNG, JPEG, GIF, WebP and AVIF images can be added');
    }
    const sha256 = await sha256Hex(bytes);
    const store = await this.options.store();
    const added = await store.saveAttachment(
      { sha256, type, bytes, size: bytes.byteLength, createdAt: this.now(), uploaded: false },
      null,
    );
    const path = attachmentPath(sha256, type);
    await this.keep(path, bytes);
    return { sha256, type, path, added };
  }

  /**
   * Stores any file (a PDF, a spreadsheet, …) locally, like `add` does for images. Its type comes
   * from its bytes; the note path keeps the extension of `name` for files that are not images or
   * PDFs.
   */
  async addFile(bytes: Uint8Array<ArrayBuffer>, name: string): Promise<AddedFile> {
    assertFileSize(name, bytes.byteLength);
    const type = sniffFileType(bytes.subarray(0, SNIFF_BYTES));
    const sha256 = await sha256Hex(bytes);
    const store = await this.options.store();
    const added = await store.saveAttachment(
      { sha256, type, bytes, size: bytes.byteLength, createdAt: this.now(), uploaded: false },
      null,
    );
    const path = filePath(sha256, type, name);
    await this.keep(path, bytes);
    return { sha256, type, path, added };
  }

  /**
   * An attachment's bytes, from this device's copy or the notebook (T68: copied into another
   * notebook with the notes that show it). Null for a path that is not an attachment or that
   * neither has.
   */
  async bytes(src: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const parsed = parseAttachmentPath(src);
    if (!parsed) return null;
    const loaded =
      (await this.local(parsed.sha256)) ?? (await this.fetch(parsed.sha256, parsed.ext));
    return loaded?.bytes ?? null;
  }

  /**
   * Keeps another notebook's attachment here under the same path (T68), so a copied note's
   * body needs no change. Refused (false) when the bytes do not hash to the path's name.
   */
  async copyIn(src: string, bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
    const parsed = parseAttachmentPath(src);
    if (!parsed || (await sha256Hex(bytes)) !== parsed.sha256) return false;
    const store = await this.options.store();
    const type = sniffFileType(bytes.subarray(0, SNIFF_BYTES));
    await store.saveAttachment(
      {
        sha256: parsed.sha256,
        type,
        bytes,
        size: bytes.byteLength,
        createdAt: this.now(),
        uploaded: false,
      },
      null,
    );
    await this.keep(src, bytes);
    return true;
  }

  /** A file's size and type from this device's copy (fetched first if need be); null if none. */
  async info(src: string): Promise<FileInfo | null> {
    const parsed = parseAttachmentPath(src);
    if (!parsed) return null;
    const store = await this.options.store();
    const local = await store.getAttachment(parsed.sha256);
    if (local) return { size: local.size, type: local.type };
    const fetched = await this.fetch(parsed.sha256, parsed.ext);
    return fetched ? { size: fetched.bytes.byteLength, type: fetched.type } : null;
  }

  /**
   * An object URL for an attachment path, from memory, IndexedDB or the notebook. Each URL handed
   * out must be given back with `release`. Null for a path that is not an attachment, when
   * neither this device nor the notebook has it, or when `signal` aborted first.
   */
  async url(src: string, signal?: AbortSignal): Promise<string | null> {
    const parsed = parseAttachmentPath(src);
    if (!parsed) return null;
    const { sha256 } = parsed;
    const known = this.urls.get(sha256);
    if (known) {
      known.refs++;
      return known.url;
    }
    if (signal?.aborted) return null;
    const loaded = (await this.local(sha256)) ?? (await this.fetch(sha256, parsed.ext));
    if (!loaded || signal?.aborted) return null;
    return this.acquire(sha256, loaded);
  }

  /** Gives back a URL from `url`; the last release revokes it. */
  release(src: string): void {
    const parsed = parseAttachmentPath(src);
    const entry = parsed ? this.urls.get(parsed.sha256) : undefined;
    if (!parsed || !entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.urls.delete(parsed.sha256);
    this.revokeUrl(entry.url);
  }

  private acquire(sha256: string, loaded: Loaded): string {
    let entry = this.urls.get(sha256);
    if (!entry) {
      // Object URLs share this page's origin: a stored type other than an image or a PDF (an
      // older build's copy, anything else writing this IndexedDB) must never make one a page,
      // so it is a file to download.
      const type = isInlineType(loaded.type) ? loaded.type : GENERIC_TYPE;
      entry = { url: this.createUrl(loaded.bytes, type), refs: 0 };
      this.urls.set(sha256, entry);
    }
    entry.refs++;
    return entry.url;
  }

  /** Hands an attachment just added to the notebook (A1032), before its path is in a note. */
  private async keep(path: string, bytes: Uint8Array): Promise<void> {
    const parsed = parseAttachmentPath(path);
    if (!parsed || !this.options.elsewhere) return;
    await this.options.elsewhere.kept(`${parsed.sha256}.${parsed.ext}`, bytes);
  }

  /**
   * An attachment this device lacks, from the notebook (A1032), kept here once its bytes hash to
   * its name: a file that does not is nobody's attachment, and is not shown.
   */
  private fetch(sha256: string, ext: string): Promise<Loaded | null> {
    const elsewhere = this.options.elsewhere;
    if (!elsewhere) return Promise.resolve(null);
    let pending = this.fetching.get(sha256);
    if (!pending) {
      pending = (async (): Promise<Loaded | null> => {
        const found = await elsewhere.fetch(`${sha256}.${ext}`).catch(() => null);
        if (!found) return null;
        const bytes = new Uint8Array(found);
        if ((await sha256Hex(bytes)) !== sha256) return null;
        const type = sniffFileType(bytes.subarray(0, SNIFF_BYTES));
        const store = await this.options.store();
        await store
          .saveAttachment(
            { sha256, type, bytes, size: bytes.byteLength, createdAt: this.now(), uploaded: true },
            null,
          )
          .catch(() => false);
        return { bytes, type };
      })().finally(() => this.fetching.delete(sha256));
      this.fetching.set(sha256, pending);
    }
    return pending;
  }

  private async local(sha256: string): Promise<Loaded | null> {
    const store = await this.options.store();
    const local = await store.getAttachment(sha256);
    return local ? { bytes: local.bytes as Uint8Array<ArrayBuffer>, type: local.type } : null;
  }
}
