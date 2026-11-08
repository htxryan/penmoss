import { describe, expect, it } from 'vitest';
import {
  cleanTags,
  inlineTagEdits,
  inlineTagRanges,
  inlineTags,
  normaliseTag,
  renamedTag,
  tagAncestors,
  tagMatches,
  tagTree,
} from '../src/tags';
import { fixtures } from './support/fixtures';

describe('inline tags (T18)', () => {
  it('reads the codec fixture the way it documents itself', () => {
    const text = fixtures.find((fixture) => fixture.name === 'tags')!.input;
    expect(inlineTags(text)).toEqual(['inbox', 'tags', 'nested/tags']);
  });

  it('needs a non-digit, a boundary before the #, and keeps nested levels', () => {
    expect(inlineTags('#2026 C# issue #12 x#y #a1 #area/cooking (#paren)')).toEqual([
      'a1',
      'area/cooking',
      'paren',
    ]);
    expect(inlineTags('## Heading')).toEqual([]);
    expect(inlineTags('#Café and #CAFÉ')).toEqual(['café']);
  });

  it('finds where each tag is, for highlighting', () => {
    expect(inlineTagRanges('a #Inbox, (#x/y) C#no')).toEqual([
      { index: 2, length: 6, tag: 'inbox' },
      { index: 11, length: 4, tag: 'x/y' },
    ]);
  });

  it('normalises user input', () => {
    expect(normaliseTag('  #Area//Cooking/ ')).toBe('area/cooking');
    expect(normaliseTag('has space')).toBeNull();
    expect(normaliseTag('2026')).toBeNull();
    expect(normaliseTag('log/2026')).toBe('log/2026');
    expect(cleanTags(['b', '#A', 'a', 'bad tag'])).toEqual(['a', 'b']);
  });
});

describe('nested tags', () => {
  it('lists the levels above a tag and matches descendants', () => {
    expect(tagAncestors('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(tagMatches('a/b', 'a')).toBe(true);
    expect(tagMatches('ab', 'a')).toBe(false);
  });

  it('counts each note once per level in the tree', () => {
    const tree = tagTree([['area/cooking', 'area'], ['area/garden'], ['inbox']]);
    expect(tree.map((node) => [node.tag, node.count])).toEqual([
      ['area', 2],
      ['inbox', 1],
    ]);
    expect(tree[0]!.children.map((node) => [node.name, node.count])).toEqual([
      ['cooking', 1],
      ['garden', 1],
    ]);
  });

  it('never files a top-level tag under one a letter shorter (T41: #info and #infox)', () => {
    const tree = tagTree([['info', 'infox'], ['notes']]);
    expect(tree.map((node) => [node.tag, node.children.length])).toEqual([
      ['info', 0],
      ['infox', 0],
      ['notes', 0],
    ]);
  });
});

describe('renaming', () => {
  it('moves descendants along and leaves others', () => {
    expect(renamedTag('a', 'a', 'x')).toBe('x');
    expect(renamedTag('a/b', 'a', 'x/y')).toBe('x/y/b');
    expect(renamedTag('ab', 'a', 'x')).toBeNull();
  });

  it('edits only the matching inline tags in text', () => {
    const text = 'Cook #area/cooking and #area, not #areas or C#area';
    const edits = inlineTagEdits(text, 'area', 'home');
    expect(edits).toEqual([
      { index: 6, length: 12, text: 'home/cooking' },
      { index: 24, length: 4, text: 'home' },
    ]);
    let out = text;
    for (const edit of [...edits].reverse()) {
      out = out.slice(0, edit.index) + edit.text + out.slice(edit.index + edit.length);
    }
    expect(out).toBe('Cook #home/cooking and #home, not #areas or C#area');
  });
});
