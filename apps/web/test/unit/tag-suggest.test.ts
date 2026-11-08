import { describe, expect, it } from 'vitest';
import { tagSuggestions } from '../../src/tags/suggest';

// T42 item 8 (A577): typing a tag suggests every tag that exists on any note.
describe('tagSuggestions', () => {
  const notes = [
    ['garden', 'area/cooking'],
    ['gardening', 'garden'],
    ['garden', 'reading'],
    ['wildgarden'],
    ['area/garden-tools'],
  ];

  it('suggests tags from every note, starting-with first, then by how many notes carry them', () => {
    expect(tagSuggestions(notes, 'gard')).toEqual([
      'garden',
      'gardening',
      'area/garden-tools',
      'wildgarden',
    ]);
  });

  it('matches a level of a nested tag, and ignores a typed # and case', () => {
    expect(tagSuggestions(notes, '#Cook')).toEqual(['area/cooking']);
  });

  it('leaves out the note’s own tags', () => {
    expect(tagSuggestions(notes, 'gard', ['garden'])).toEqual([
      'gardening',
      'area/garden-tools',
      'wildgarden',
    ]);
  });

  it('suggests nothing before anything is typed, and at most the limit', () => {
    expect(tagSuggestions(notes, '  ')).toEqual([]);
    expect(tagSuggestions(notes, 'a', [], 2)).toHaveLength(2);
  });
});
