/**
 * The Characters a line symbol can be chosen from (A1568): symbols, then emoji, each with a
 * name and keywords to find it by and a valid glyph by the symbol rules (A743). The list is
 * `data/characters.json`, written by `scripts/characters.mjs` (`task characters`) and loaded
 * only when a picker opens; Android ships the same file as an asset.
 */
import type { Findable } from './glyph-search';

export interface CharacterEntry extends Findable {
  readonly glyph: string;
  /** Where it is listed: Symbols, Smileys and Emotion, People, … Flags. */
  readonly group: string;
}

/** The Characters, from their own chunk. */
export async function loadCharacters(): Promise<readonly CharacterEntry[]> {
  const data = await import('../data/characters.json');
  return data.default;
}
