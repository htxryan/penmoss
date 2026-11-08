/**
 * Editing helpers for Yjs 14 replicas. Documents mimic the binding layout: a
 * root of block nodes, each holding text.
 */
import * as Y from '@y/y';
import { NOTE_ROOT } from '../../src/replica';
import { createYjs14Replica, type Yjs14Replica } from '../../src/yjs14';

export const createReplica = (): Yjs14Replica => createYjs14Replica();

export function appendParagraph(replica: Yjs14Replica, text: string): void {
  replica.doc.transact(() => {
    const paragraph = new Y.Node('paragraph');
    replica.doc.get(NOTE_ROOT).push([paragraph]);
    paragraph.insert(0, text);
  });
}

export function insertText(
  replica: Yjs14Replica,
  block: number,
  offset: number,
  text: string,
): void {
  (replica.doc.get(NOTE_ROOT).get(block) as Y.Node).insert(offset, text);
}

export function deleteText(
  replica: Yjs14Replica,
  block: number,
  offset: number,
  length: number,
): void {
  (replica.doc.get(NOTE_ROOT).get(block) as Y.Node).delete(offset, length);
}

/** Appends a paragraph `before [[link]] after`, laid out as the binding writes an inline atom. */
export function appendLinkParagraph(
  replica: Yjs14Replica,
  before: string,
  link: { noteId: string | null; target: string; heading?: string | null; alias?: string | null },
  after: string,
): void {
  replica.doc.transact(() => {
    const paragraph = new Y.Node('paragraph');
    replica.doc.get(NOTE_ROOT).push([paragraph]);
    const atom = new Y.Node('wikilink');
    paragraph.insert(0, before);
    paragraph.insert(before.length, [atom]);
    paragraph.insert(before.length + 1, after);
    atom.setAttr('noteId', link.noteId);
    atom.setAttr('target', link.target);
    atom.setAttr('heading', link.heading ?? null);
    atom.setAttr('alias', link.alias ?? null);
  });
}

export function appendHeading(replica: Yjs14Replica, level: number, text: string): void {
  replica.doc.transact(() => {
    const heading = new Y.Node('heading');
    replica.doc.get(NOTE_ROOT).push([heading]);
    heading.setAttr('level', level);
    heading.insert(0, text);
  });
}

/** Appends an embed block `![[target#heading]]`, as the binding writes a block atom. */
export function appendEmbed(
  replica: Yjs14Replica,
  embed: { noteId: string | null; target: string; heading?: string | null },
): void {
  replica.doc.transact(() => {
    const node = new Y.Node('embed');
    replica.doc.get(NOTE_ROOT).push([node]);
    node.setAttr('noteId', embed.noteId);
    node.setAttr('target', embed.target);
    node.setAttr('heading', embed.heading ?? null);
    node.setAttr('alias', null);
  });
}
