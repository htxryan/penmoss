import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { NOTE_ROOT } from '../src/replica';
import {
  bodyTags,
  changeTagInDoc,
  frontmatterTags,
  noteTags,
  renameTagInDoc,
  revertTagEdit,
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

describe('deleting, merging and undoing a tag change (the Tags page)', () => {
  it('deletes a tag: frontmatter goes, an inline tag keeps its word, nested tags go too', () => {
    const doc = docWith((root) => {
      paragraph(root, 'A ', ['#garden', { bold: {} }], ' bed and #garden/herbs, not ', [
        '#garden',
        { code: {} },
      ]);
      paragraph(root, 'Also #gardening and #other');
    });
    setFrontmatterTag(doc, 'garden', true);
    setFrontmatterTag(doc, 'garden/beds', true);
    setFrontmatterTag(doc, 'keep', true);
    const log = changeTagInDoc(doc, { from: 'garden', to: null });
    expect(log).not.toBeNull();
    expect(noteTags(doc)).toEqual(['gardening', 'keep', 'other']);
    const json = text(doc);
    expect(json).toContain('"insert":"A "');
    expect(json).toContain('"insert":"garden","format":{"bold":{}}');
    expect(json).toContain('"insert":" bed and garden/herbs, not "');
    expect(json).toContain('"insert":"#garden","format":{"code":{}}');
    expect(json).toContain('Also #gardening and #other');
    expect(changeTagInDoc(doc, { from: 'garden', to: null })).toBeNull();
  });

  it('deletes only the tag itself when nested is false', () => {
    const doc = docWith((root) => paragraph(root, '#garden and #garden/herbs'));
    changeTagInDoc(doc, { from: 'garden', to: null, nested: false });
    expect(noteTags(doc)).toEqual(['garden/herbs']);
  });

  it('renames only the tag itself when nested is false', () => {
    const doc = docWith((root) => paragraph(root, '#penmoss and #penmoss/review'));
    setFrontmatterTag(doc, 'penmoss/factory', true);
    setFrontmatterTag(doc, 'penmoss', true);
    changeTagInDoc(doc, { from: 'penmoss', to: 'app', nested: false });
    expect(noteTags(doc)).toEqual(['app', 'penmoss/factory', 'penmoss/review']);
  });

  it('undoes a delete exactly, through an edit made since elsewhere in the paragraph', () => {
    const doc = docWith((root) => paragraph(root, 'Plant the #garden bed'));
    setFrontmatterTag(doc, 'garden', true);
    const log = changeTagInDoc(doc, { from: 'garden', to: null })!;
    expect(text(doc)).toContain('Plant the garden bed');
    (doc.get(NOTE_ROOT).get(0) as Y.Node).insert(0, 'Today: ');
    expect(revertTagEdit(doc, log)).toBe(true);
    expect(text(doc)).toContain('Today: Plant the #garden bed');
    expect(noteTags(doc)).toEqual(['garden']);
    expect(frontmatterTags(doc)).toEqual(['garden']);
  });

  it('undoes a merge into a tag the note had, leaving that tag where it was', () => {
    const doc = docWith((root) => paragraph(root, '#cf workers, #cloudflare R2'));
    setFrontmatterTag(doc, 'cf', true);
    setFrontmatterTag(doc, 'cloudflare', true);
    const log = changeTagInDoc(doc, { from: 'cf', to: 'cloudflare' })!;
    expect(noteTags(doc)).toEqual(['cloudflare']);
    expect(log.added).toEqual([]);
    expect(log.removed).toEqual(['cf']);
    revertTagEdit(doc, log);
    expect(text(doc)).toContain('#cf workers, #cloudflare R2');
    expect(frontmatterTags(doc)).toEqual(['cf', 'cloudflare']);
  });

  it('undoes several changes in reverse, and leaves a tag edited since as it is', () => {
    const doc = docWith((root) => paragraph(root, '#dev and #devs'));
    setFrontmatterTag(doc, 'dev', true);
    const first = changeTagInDoc(doc, { from: 'dev', to: 'development' })!;
    const second = changeTagInDoc(doc, { from: 'devs', to: 'development' })!;
    expect(noteTags(doc)).toEqual(['development']);
    expect(text(doc)).toContain('#development and #development');
    // Someone retypes the second tag before the undo.
    const block = doc.get(NOTE_ROOT).get(0) as Y.Node;
    block.delete('#development and '.length, '#development'.length);
    block.insert('#development and '.length, '#elsewhere');
    revertTagEdit(doc, second);
    revertTagEdit(doc, first);
    expect(text(doc)).toContain('#dev and #elsewhere');
    expect(frontmatterTags(doc)).toEqual(['dev']);
  });

  it('undoes in a copy of the note made from its stored state', () => {
    const doc = docWith((root) => paragraph(root, 'See #recipes'));
    const log = changeTagInDoc(doc, { from: 'recipes', to: 'cooking' })!;
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    expect(revertTagEdit(copy, JSON.parse(JSON.stringify(log)) as typeof log)).toBe(true);
    expect(bodyTags(copy)).toEqual(['recipes']);
  });
});
