/**
 * Today's Penmoss code the spike runs (bundled by lib/penmoss.mjs, never shipped): the server
 * mirror's render (`renderNote`, A204/A205) and paths (A201/A212), the note and WorkspaceDoc
 * helpers, and the periodic-note builder (A4/A76). Importing it rather than copying it keeps the
 * spike honest: the bytes it writes are the bytes the mirror would write.
 */
export * as Y from '@y/y';
export { docToDelta, ynodeToPmnode } from '@y/prosemirror';
export { parseMarkdown, schema, ulid } from '@penmoss/core';
export { parse as parseYaml } from 'yaml';
export { effectiveParents, keyBetween } from '@penmoss/core/workspace';
export { periodicNoteId, journalFolderId } from '@penmoss/core/periodic';
export { localAttachment, noteBody, readNoteState, renderNote } from '../../../packages/editor/src/markdown';
export {
  assetPrefix,
  assignFolders,
  folderDirs,
  nameKey,
  noteName,
  notePath,
  uniqueName,
  type FolderName,
  type MirrorFolder,
} from '../../../packages/core/src/mirror/paths';
export { NOTE_ROOT } from '@penmoss/sync-client/replica';
export { initNote, isDeleted, readIdentity, readTitle, setDeleted, setTitle } from '@penmoss/sync-client/note';
export {
  createFolder,
  moveFolder,
  moveNote,
  readWorkspace,
  registerNote,
  renameFolder,
} from '@penmoss/sync-client/workspace';
export { periodicNote } from '../../../packages/editor/src/periodic';
