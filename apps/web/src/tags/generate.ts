/**
 * What Generate All covers on the Tags page (A1677): each notebook's tags with no description
 * (or every tag), and the words that say so before anything is sent. Pure, so the dialog and its
 * tests share it.
 */
import { tagsToDescribe } from '@penmoss/core/ai-description';
import type { TagDescriberSource, TagGroup } from '../notes/describer';

/** What Generate All says it covers (the phone's `generateAllWords`). */
export function generateAllWords(count: number, replace: boolean): string {
  if (count === 0)
    return replace ? 'There are no tags to describe.' : 'Every tag has a description already.';
  const each =
    'Each goes to your AI provider with its notes’ titles and descriptions, two at a time.';
  if (replace) {
    return `${count === 1 ? '1 tag' : `${count} tags`} will be described, replacing any description they have. ${each}`;
  }
  return `${count === 1 ? '1 tag has' : `${count} tags have`} no description. ${each}`;
}

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
