/// <reference types="node" />
/**
 * The tag browser's tree (T40 P6, TG1, A467): apps/android/contract/tag-tree-v1.json holds
 * notes' tags and the tree core's `tagTree` builds from them (nested by `/`, each counting the
 * notes tagged with it or anything under it, sorted by name), and which notes `tagMatches`
 * puts under a tag. The Kotlin `TagTreeTest` builds the same trees from the same notes, so the
 * phone's counts are the web tag pane's.
 *
 * After changing core's rules, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test tag-tree-contract`,
 * then `pnpm exec prettier --write apps/android/contract/tag-tree-v1.json`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tagMatches, tagTree } from '@penmoss/core/tags';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/tag-tree-v1.json';

/** Each note's tags, as `/sync/changes` sends them (canonical, sorted). */
const NOTES: ReadonlyArray<readonly string[]> = [
  ['area/cooking', 'soup'],
  ['area/cooking/italian', 'area/garden'],
  ['area'],
  ['soup'],
  // Two tags under one parent: the parent counts the note once.
  ['log/2026', 'log/2026/10'],
  [],
  ['café', 'zebra', 'éclair'],
  ['a-b', 'a_b', 'a/b'],
  ['日本語'],
];

const FILTERS = ['area', 'area/cooking', 'soup', 'log', 'a', 'a-b', 'missing'];

function tagTreeContract() {
  return {
    version: 1,
    notes: NOTES,
    tree: tagTree(NOTES),
    tagged: FILTERS.map((tag) => ({
      tag,
      notes: NOTES.flatMap((tags, index) =>
        tags.some((each) => tagMatches(each, tag)) ? [index] : [],
      ),
    })),
  };
}

describe('tag tree contract v1', () => {
  it('is core’s tagTree and tagMatches over the notes, exactly', () => {
    const expected = tagTreeContract();
    if (process.env['PENMOSS_WRITE_CONTRACTS']) {
      // Run from the package, as `pnpm --filter` does.
      writeFileSync(
        resolve(process.cwd(), '../contract/tag-tree-v1.json'),
        `${JSON.stringify(expected, null, 2)}\n`,
      );
    }
    expect(contract).toEqual(expected);
  });

  it('counts a note once under a parent, however many of its tags sit there', () => {
    const log = tagTree(NOTES).find((node) => node.tag === 'log');
    expect(log?.count).toBe(1);
  });
});
