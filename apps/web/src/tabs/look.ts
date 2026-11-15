import { badgeOfSource } from '../sources/badge';
import type { Source } from '../sources/registry';

/** What a tab carries while dragged along the strip (its id), beside its note's. */
export const TAB_DRAG_TYPE = 'application/x-penmoss-tab';

/** How a notebook's badge looks, for telling two same-titled tabs apart (AC8). */
export const badgeLook = (source: Source): string => {
  const badge = badgeOfSource(source);
  return `${badge.color}|${badge.glyph.kind}|${badge.glyph.value}`;
};
