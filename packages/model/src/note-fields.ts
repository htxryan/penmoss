/**
 * The frontmatter fields a device writes for a note (T11, T15): what the
 * source view shows above the body, and what Copy as Markdown puts above a
 * whole note, so a copy matches the source. Shared by the web app and the
 * Android editor page (T40 P8), so the two cannot drift.
 */
import { readIdentity, readTitle } from './note';
import { frontmatterTags } from './tags';
import { readAiSetting, readDescription } from './description';
import type { Yjs14Replica } from './yjs14';
import type { createFrontmatter } from '@penmoss/core';
import { AI_DESCRIPTION_FRONTMATTER } from '@penmoss/core/ai-description';

/** Fields for a whole note's frontmatter (Copy as Markdown with nothing selected). */
export type NoteFields = Parameters<typeof createFrontmatter>[0];

export function noteFields(noteId: string, replica: Yjs14Replica): NoteFields {
  const identity = readIdentity(replica.doc);
  const title = readTitle(replica.doc);
  // Inline tags stay in the body; frontmatter lists the ones set there (T18).
  const tags = frontmatterTags(replica.doc);
  const description = readDescription(replica.doc);
  const ai = readAiSetting(replica.doc);
  return {
    id: noteId,
    ...(title ? { title } : {}),
    ...(identity.created ? { created: identity.created } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(identity.kind && identity.kind !== 'note' ? { type: identity.kind } : {}),
    ...(description ? { description } : {}),
    ...(ai !== 'inherit' ? { [AI_DESCRIPTION_FRONTMATTER]: ai } : {}),
  };
}
