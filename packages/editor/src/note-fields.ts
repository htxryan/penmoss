/**
 * The frontmatter fields a device writes for a note (T11, T15): what the
 * source view shows above the body, and what Copy as Markdown puts above a
 * whole note, so a copy matches the source. Shared by the web app and the
 * Android editor page (T40 P8), so the two cannot drift.
 */
import { readIdentity, readTitle } from '@penmoss/sync-client/note';
import { frontmatterTags } from '@penmoss/sync-client/tags';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import type { NoteFields } from './clipboard/markdown';

export function noteFields(noteId: string, replica: Yjs14Replica): NoteFields {
  const identity = readIdentity(replica.doc);
  const title = readTitle(replica.doc);
  // Inline tags stay in the body; frontmatter lists the ones set there (T18).
  const tags = frontmatterTags(replica.doc);
  return {
    id: noteId,
    ...(title ? { title } : {}),
    ...(identity.created ? { created: identity.created } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(identity.kind && identity.kind !== 'note' ? { type: identity.kind } : {}),
  };
}
