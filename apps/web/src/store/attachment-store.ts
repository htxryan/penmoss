/**
 * Local attachment storage (T10): the DOM-free types `Attachments` stores through, which
 * NoteStore (IndexedDB) implements. An attachment is stored once, under the SHA-256 of its bytes.
 */

/** What is known about a stored attachment; kept apart from its bytes so updates stay small. */
export interface AttachmentMeta {
  readonly sha256: string;
  /** The sniffed type, e.g. `image/png`, `application/pdf` or `application/octet-stream`. */
  readonly type: string;
  readonly size: number;
  readonly createdAt: number;
}

export interface StoredAttachment extends AttachmentMeta {
  readonly bytes: Uint8Array;
}

/** What `Attachments` needs; NoteStore implements it. */
export interface AttachmentStore {
  getAttachment(sha256: string): Promise<StoredAttachment | undefined>;
  /**
   * Stores an attachment in one transaction. Resolves with whether the hash was new. A hash
   * already stored keeps its metadata, and its bytes are written again (a re-paste repairs a
   * damaged copy).
   */
  saveAttachment(attachment: StoredAttachment): Promise<boolean>;
}
