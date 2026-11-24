/**
 * What Generate All covers on the Tags page (A1677): each notebook's tags with no description
 * (or every tag), and the words that say so before anything is sent. Pure, so the dialog and its
 * tests share it.
 */
import { generateAllTagsWords, tagsToDescribe } from '@penmoss/core/ai-description';
import type { TagDescriberSource, TagGroup } from '../notes/describer';

/** What Generate All says it covers: core's words, the phone's too (A1646). */
export const generateAllWords = generateAllTagsWords;

/** Each notebook's tags Generate All covers, by the notes and descriptions they have now. */
export function generateGroups(
  sources: readonly TagDescriberSource[],
  replace: boolean,
): TagGroup[] {
  return sources
    .map((source) => ({
      source,
      tags: tagsToDescribe(
        source.notes.list().map((note) => note.tags),
        source.workspace.getState().snapshot.tagDescriptions ?? {},
        replace,
      ),
    }))
    .filter((group) => group.tags.length > 0);
}
