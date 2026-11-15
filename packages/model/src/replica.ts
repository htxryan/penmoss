import type { NoteLink } from '@penmoss/core/links';
import type { EngineName } from './protocol';

/**
 * Name of the shared root type that holds a note's ProseMirror document.
 * The @y/prosemirror binding is configured to use it.
 */
export const NOTE_ROOT = 'prosemirror';

/** What an update changed, beyond its bytes. */
export interface UpdateInfo {
  /**
   * It changed the note's comments and nothing else (T48, A770): not an edit, so it bumps no
   * `updated` time and no place in Recent.
   */
  readonly commentsOnly: boolean;
}

export type UpdateListener = (update: Uint8Array, origin: unknown, info?: UpdateInfo) => void;

/**
 * One replica of a note's Yjs document. The replica keeper, the IndexedDB store
 * and the git engine only speak this interface, which keeps them
 * independent of the Yjs version behind it (ADR 0003).
 */
export interface Replica {
  readonly engine: EngineName;
  readonly clientId: number;
  applyUpdate(update: Uint8Array, origin?: unknown): void;
  encodeStateAsUpdate(stateVector?: Uint8Array): Uint8Array;
  encodeStateVector(): Uint8Array;
  /** Fires after every transaction that changed the document, local or remote. */
  onUpdate(listener: UpdateListener): () => void;
  /** Visible text, one line per text block (for search, previews and IndexedDB). */
  plainText(): string;
  /** The note's wikilinks and embeds (T16), for the local backlinks and graph index. */
  links?(): NoteLink[];
  destroy(): void;
}
