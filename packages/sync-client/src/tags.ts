/**
 * A note's tags in its Yjs document (T18): frontmatter tags live in `meta`,
 * one attribute per tag (`tags/<name>` = true), so two devices adding tags
 * concurrently keep both (a single list value would keep one device's list).
 * Inline `#tags` are read from the body's text, outside code. The same code
 * runs on clients (records, the tag pane) and in the NoteDoc (the index).
 */
import {
  cleanTags,
  inlineTagEdits,
  inlineTags,
  normaliseTag,
  renamedTag,
} from '@penmoss/core/tags';
import * as Y from '@y/y';
import { NOTE_META } from './note';
import { NOTE_ROOT } from './replica';

export const META_TAG_PREFIX = 'tags/';

/** Blocks whose text is code, not prose: `#` there is never a tag. */
const CODE_BLOCKS = new Set(['codeBlock', 'blockMath']);

interface DeltaOp {
  readonly insert?: string | DeltaNode[];
  readonly format?: Record<string, unknown> | null;
}
interface DeltaNode {
  readonly name?: string;
  readonly children?: DeltaOp[];
}

/** A run is inline code when it carries the code mark (its attribute may have a hash suffix). */
const isCode = (format: DeltaOp['format']) =>
  Boolean(
    format && Object.keys(format).some((key) => key.replace(/--[A-Za-z0-9+/=]{8}$/, '') === 'code'),
  );

/** A Yjs node's name (typed loosely by Yjs 14's generics). */
const nodeName = (node: Y.Node): string | undefined => {
  const name: unknown = (node as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
};

/** The frontmatter tags (sorted). */
export function frontmatterTags(doc: Y.Doc): string[] {
  const tags: string[] = [];
  for (const [key, value] of doc.get(NOTE_META).attrEntries()) {
    const name = String(key);
    if (value === true && name.startsWith(META_TAG_PREFIX)) {
      tags.push(name.slice(META_TAG_PREFIX.length));
    }
  }
  return cleanTags(tags);
}

/** Adds or removes one frontmatter tag; returns the canonical tag, or null if invalid. */
export function setFrontmatterTag(
  doc: Y.Doc,
  raw: string,
  on: boolean,
  origin: unknown = null,
): string | null {
  const tag = normaliseTag(raw);
  if (!tag) return null;
  doc.transact(() => {
    const meta = doc.get(NOTE_META);
    if (on) meta.setAttr(`${META_TAG_PREFIX}${tag}`, true);
    else meta.deleteAttr(`${META_TAG_PREFIX}${tag}`);
  }, origin);
  return tag;
}

/** A block's own text as tag detection reads it, and where each text run sits in it. */
interface BlockText {
  /** Inline code blanked out (its `#` never makes a tag); each embedded node is one space. */
  readonly text: string;
  readonly runs: ReadonlyArray<{ readonly start: number; readonly format: DeltaOp['format'] }>;
  /** Child nodes (embedded inline, or nested blocks) and their offsets. */
  readonly children: ReadonlyArray<{ readonly index: number; readonly node: DeltaNode }>;
}

/**
 * One block's text, read the same way for detection and renaming (T18): runs
 * joined, so a tag whose marks change part-way is one tag and `#` straight
 * after a word in another run is none. Offsets match the Yjs node's indices
 * (a character per UTF-16 unit, one per child node).
 */
function blockText(node: DeltaNode): BlockText {
  let text = '';
  const runs: Array<{ start: number; format: DeltaOp['format'] }> = [];
  const children: Array<{ index: number; node: DeltaNode }> = [];
  for (const op of node.children ?? []) {
    if (typeof op.insert === 'string') {
      runs.push({ start: text.length, format: op.format ?? null });
      text += isCode(op.format) ? ' '.repeat(op.insert.length) : op.insert;
    } else if (Array.isArray(op.insert)) {
      for (const child of op.insert) {
        children.push({ index: text.length, node: child });
        text += ' ';
      }
    }
  }
  return { text, runs, children };
}

/** Text of each prose block (see `blockText`), never code blocks. */
function proseRuns(node: DeltaNode, out: string[]): void {
  if (node.name && CODE_BLOCKS.has(node.name)) return;
  const { text, children } = blockText(node);
  for (const child of children) proseRuns(child.node, out);
  if (text.trim()) out.push(text);
}

/** The inline tags in the body. */
export function bodyTags(doc: Y.Doc): string[] {
  const runs: string[] = [];
  proseRuns(doc.get(NOTE_ROOT).toDeltaDeep().toJSON() as DeltaNode, runs);
  return cleanTags(runs.flatMap(inlineTags));
}

/** Every tag of the note: frontmatter and inline, sorted, without duplicates. */
export function noteTags(doc: Y.Doc): string[] {
  return cleanTags([...frontmatterTags(doc), ...bodyTags(doc)]);
}

/** The tags of a stored note's merged update (records written before T18). */
export function tagsOfUpdate(update: Uint8Array): string[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return noteTags(doc);
  } catch {
    return [];
  } finally {
    doc.destroy();
  }
}

/**
 * Renames (or, when `to` already exists, merges) a tag in one note, in one
 * transaction: frontmatter attributes and inline `#from` / `#from/…` in the
 * body's text, edited in place so concurrent edits elsewhere survive.
 * Returns whether anything changed.
 */
export function renameTagInDoc(
  doc: Y.Doc,
  from: string,
  to: string,
  origin: unknown = null,
): boolean {
  let changed = false;
  doc.transact(() => {
    const meta = doc.get(NOTE_META);
    for (const tag of frontmatterTags(doc)) {
      const renamed = renamedTag(tag, from, to);
      if (renamed === null || renamed === tag) continue;
      meta.deleteAttr(`${META_TAG_PREFIX}${tag}`);
      meta.setAttr(`${META_TAG_PREFIX}${renamed}`, true);
      changed = true;
    }
    const visit = (node: Y.Node, name: string | undefined) => {
      if (name && CODE_BLOCKS.has(name)) return;
      const block = blockText(node.toDelta().toJSON() as DeltaNode);
      // Children first: this node's text edits would shift their indices.
      for (const { index } of block.children) {
        const child: unknown = node.get(index);
        if (child instanceof Y.Node) visit(child, nodeName(child));
      }
      // The same text detection reads, so exactly the tags it sees are renamed; each name
      // keeps the marks of its first character. Applied from the end, so offsets stay valid.
      const edits = inlineTagEdits(block.text, from, to);
      for (const edit of edits.reverse()) {
        const run = block.runs.findLast((candidate) => candidate.start <= edit.index);
        node.delete(edit.index, edit.length);
        node.insert(edit.index, edit.text, run?.format ?? {});
        changed = true;
      }
    };
    visit(doc.get(NOTE_ROOT), undefined);
  }, origin);
  return changed;
}
