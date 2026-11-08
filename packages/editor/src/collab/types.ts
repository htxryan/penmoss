import type { Editor } from '@tiptap/core';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';

/** A TipTap editor bound to a note replica, with Yjs-aware undo. */
export interface CollabEditor {
  readonly editor: Editor;
  readonly replica: Yjs14Replica;
  /** Undoes this editor's last change only; remote changes are untouched. */
  undo(): boolean;
  redo(): boolean;
  destroy(): void;
}
