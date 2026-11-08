import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { NOTE_ROOT } from '../src/replica';
import {
  bodyTags,
  frontmatterTags,
  noteTags,
  renameTagInDoc,
  setFrontmatterTag,
} from '../src/tags';

/** A body laid out as the @y/prosemirror binding does it. */
function docWith(build: (root: Y.Node) => void): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => build(doc.get(NOTE_ROOT)));
  return doc;
}

function paragraph(parent: Y.Node, ...runs: Array<string | [string, Record<string, unknown>]>) {
  const node = new Y.Node('paragraph');
  parent.push([node]);
  let at = 0;
  for (const run of runs) {
    const [text, format] = typeof run === 'string' ? [run, undefined] : run;
    node.insert(at, text, format);
    at += text.length;
  }
  return node;
}

const text = (doc: Y.Doc) => JSON.stringify(doc.get(NOTE_ROOT).toDeltaDeep().toJSON());

describe('tags in a note document (T18)', () => {
  it('reads inline tags from prose, never from code', () => {
    const doc = docWith((root) => {
      paragraph(root, 'Plan #garden and ', ['#notcode', { code: {} }], ' #Area/Cooking');
      const list = new Y.Node('bulletList');
      root.push([list]);
      const item = new Y.Node('listItem');
      list.push([item]);
      paragraph(item, 'nested #todo');
      const code = new Y.Node('codeBlock');
      root.push([code]);
      code.insert(0, '#include <stdio.h>');
    });
    expect(bodyTags(doc)).toEqual(['area/cooking', 'garden', 'todo']);
  });

  it('keeps frontmatter tags as one attribute each, so concurrent additions merge', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    setFrontmatterTag(a, '#Penmoss', true);
    setFrontmatterTag(b, 'architecture', true);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(frontmatterTags(a)).toEqual(['architecture', 'penmoss']);
    expect(frontmatterTags(b)).toEqual(['architecture', 'penmoss']);
    expect(setFrontmatterTag(a, 'not a tag', true)).toBeNull();
    setFrontmatterTag(a, 'penmoss', false);
    expect(frontmatterTags(a)).toEqual(['architecture']);
  });

  it('unifies frontmatter and inline tags', () => {
    const doc = docWith((root) => paragraph(root, 'see #inbox'));
    setFrontmatterTag(doc, 'inbox', true);
    setFrontmatterTag(doc, 'project', true);
    expect(noteTags(doc)).toEqual(['inbox', 'project']);
  });

  it('renames inline and frontmatter tags in place, keeping marks and code', () => {
    const doc = docWith((root) => {
      paragraph(root, 'Cook #area/cooking ', ['in #area', { bold: {} }], ' ', [
        '#area',
        { code: {} },
      ]);
    });
    setFrontmatterTag(doc, 'area', true);
    expect(renameTagInDoc(doc, 'area', 'home')).toBe(true);
    expect(noteTags(doc)).toEqual(['home', 'home/cooking']);
    expect(text(doc)).toContain('"insert":"Cook #home/cooking "');
    expect(text(doc)).toContain('"insert":"in #home","format":{"bold":{}}');
    expect(text(doc)).toContain('"insert":"#area","format":{"code":{}}');
    expect(renameTagInDoc(doc, 'area', 'home')).toBe(false);
  });

  it('merges into an existing tag', () => {
    const doc = docWith((root) => paragraph(root, '#recipes and #cooking'));
    setFrontmatterTag(doc, 'recipes', true);
    setFrontmatterTag(doc, 'cooking', true);
    renameTagInDoc(doc, 'recipes', 'cooking');
    expect(noteTags(doc)).toEqual(['cooking']);
    expect(frontmatterTags(doc)).toEqual(['cooking']);
  });

  it('merges a rename with a concurrent edit to the same paragraph', () => {
    const a = docWith((root) => paragraph(root, 'Weekend #chores list'));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    renameTagInDoc(a, 'chores', 'home/chores');
    (b.get(NOTE_ROOT).get(0) as Y.Node).insert(0, 'Long ');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(text(a)).toBe(text(b));
    expect(text(a)).toContain('Long Weekend #home/chores list');
  });

  it('renames exactly the tags detection sees, across runs and marks (per block)', () => {
    const doc = docWith((root) => {
      // A tag whose name changes marks part-way: one tag to detection, so one rename.
      paragraph(root, 'Do ', ['#cho', { bold: {} }], 'res now');
      // `#` straight after a word in another run is not a tag, so it stays.
      paragraph(root, 'word', ['#chores', { italic: {} }]);
      // After inline code it is (the code reads as blank), and the code stays as it is.
      paragraph(root, ['x', { code: {} }], '#chores');
    });
    expect(bodyTags(doc)).toEqual(['chores']);
    expect(renameTagInDoc(doc, 'chores', 'home')).toBe(true);
    expect(bodyTags(doc)).toEqual(['home']);
    const json = text(doc);
    expect(json).toContain('"insert":"Do "');
    expect(json).toContain('"insert":"#home","format":{"bold":{}}');
    expect(json).toContain('"insert":" now"');
    expect(json).toContain('"insert":"#chores","format":{"italic":{}}');
    expect(json).toContain('"insert":"x","format":{"code":{}}');
    expect(json).toContain('"insert":"#home"}');
    expect(renameTagInDoc(doc, 'chores', 'home')).toBe(false);
  });
});
