/**
 * Local attachment storage (T10). DOM-free types shared by NoteStore
 * (IndexedDB) and the upload queue. An attachment is stored once, under the
 * SHA-256 of its bytes; an upload record exists while the server lacks it.
 */

/** What is known about a stored attachment; kept apart from its bytes so updates stay small. */
export interface AttachmentMeta {
  readonly sha256: string;
  /** The sniffed type, e.g. `image/png`, `application/pdf` or `application/octet-stream`. */
  readonly type: string;
  readonly size: number;
  readonly createdAt: number;
  /** The server has these bytes (uploaded from here, or downloaded from it). */
  readonly uploaded: boolean;
  /** Fetched from the server for display (a cache entry that may be evicted). */
  readonly downloaded?: boolean;
  /** When it was last shown (ms), for evicting the least recently used downloads. */
  readonly lastUsedAt?: number;
}

export interface StoredAttachment extends AttachmentMeta {
  readonly bytes: Uint8Array;
}

export interface PendingUpload {
  readonly sha256: string;
  /** The note the image was first added to (recorded by the server's index). */
  readonly noteId: string | null;
  readonly attempts: number;
  /** When to try again (ms since the epoch); 0 means now. */
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  /** The server refused the file for good (type or size); it is not retried. */
  readonly failed: boolean;
  /** A generic file's extension (T13), so the server names it as the note does. */
  readonly ext?: string;
}

export type UploadUpdater = (current: PendingUpload | undefined) => PendingUpload | null;

/** What the upload queue and the attachment cache need; NoteStore implements it. */
export interface AttachmentStore {
  getAttachment(sha256: string): Promise<StoredAttachment | undefined>;
  /**
   * Stores an attachment and, when given, its upload record, in one
   * transaction. Resolves with whether the hash was new. A hash already
   * stored is stored once: if the server has it, nothing changes; if not, the
   * bytes are replaced (a re-paste repairs a damaged copy) and a failed
   * upload record starts over.
   */
  saveAttachment(attachment: StoredAttachment, upload: PendingUpload | null): Promise<boolean>;
  /** Records that an attachment was shown (metadata only). */
  touchAttachment(sha256: string, at: number): Promise<void>;
  /**
   * Drops downloaded attachments, least recently used first, until the
   * downloaded ones total at most `budgetBytes`. Images not yet uploaded,
   * images added on this device and those in `keep` are never evicted.
   * Resolves with the evicted hashes.
   */
  evictDownloads(budgetBytes: number, keep: ReadonlySet<string>): Promise<string[]>;
  listUploads(): Promise<PendingUpload[]>;
  /** Read-modify-write of one upload record in a single transaction (null leaves it). */
  updateUpload(sha256: string, fn: UploadUpdater): Promise<PendingUpload | null>;
  /** The server has the bytes: drops the upload record and marks the attachment uploaded (metadata only). */
  completeUpload(sha256: string): Promise<void>;
}
