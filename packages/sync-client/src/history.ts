/**
 * Version history on a note's Yjs document (T21, A3, A5): bringing an old
 * state back as a new change. Shared by the NoteDoc (restore and revert on the
 * server) and tests; no editor and no markdown codec here.
 *
 * A restore never replaces the document. The body is diffed, node by node and
 * then by line, word and character (`lib0/delta`'s `diff`, the same diff the
 * @y/prosemirror binding uses), against the old state and only the
 * difference is applied: blocks the old state shares with the current one
 * keep their Yjs items, so an edit another device makes to them concurrently
 * survives. The title gets the smallest text edit, and the frontmatter tags
 * one attribute each. Identity (`id`, `created`, `kind`, `period`) and the
 * trash flag are never touched. The epoch stays the same (A5): a restore is
 * an ordinary edit that syncs everywhere.
 */
import * as delta from 'lib0/delta';
import * as Y from '@y/y';
import { NOTE_META, readTitle, setTitle } from './note';
import { NOTE_ROOT } from './replica';
import { META_TAG_PREFIX } from './tags';

type AnyDelta = ReturnType<Y.Node['toDeltaDeep']>;

/** The change that turns the body `from` into the body `to` (empty when they are equal). */
export function bodyDiff(from: Y.Node, to: AnyDelta): AnyDelta {
  return delta.diff(from.toDeltaDeep(), to);
}

/** Makes the body equal `target` (a deep delta, e.g. from another document) with the smallest change. */
export function setBody(doc: Y.Doc, target: AnyDelta): boolean {
  const root = doc.get(NOTE_ROOT);
  const change = bodyDiff(root, target);
  if (change.isEmpty()) return false;
  root.applyDelta(change);
  return true;
}

/** The frontmatter tag attributes (`tags/<name>`) of a document. */
function tagKeys(doc: Y.Doc): Set<string> {
  const attrs = doc.get(NOTE_META).getAttrs() as Record<string, unknown>;
  return new Set(
    Object.keys(attrs).filter((key) => key.startsWith(META_TAG_PREFIX) && attrs[key] === true),
  );
}

/** Makes the frontmatter tags equal `keys` (attribute names), one attribute per change. */
export function setTagKeys(doc: Y.Doc, keys: ReadonlySet<string>): void {
  const meta = doc.get(NOTE_META);
  const current = tagKeys(doc);
  for (const key of current) if (!keys.has(key)) meta.deleteAttr(key);
  for (const key of keys) if (!current.has(key)) meta.setAttr(key, true);
}

/**
 * Applies the content of `version` (body, title, frontmatter tags) to `doc` as
 * one new change. Returns whether anything changed.
 */
export function restoreContent(doc: Y.Doc, version: Y.Doc, origin: unknown = null): boolean {
  let changed = false;
  const off = (update: Uint8Array) => {
    if (update.byteLength > 2) changed = true;
  };
  doc.on('update', off);
  try {
    doc.transact(() => {
      setBody(doc, version.get(NOTE_ROOT).toDeltaDeep());
      setTitle(doc, readTitle(version));
      setTagKeys(doc, tagKeys(version));
    }, origin);
  } finally {
    doc.off('update', off);
  }
  return changed;
}

/** The frontmatter tag attribute names of a document (for a three-way merge of tags). */
export function frontmatterTagKeys(doc: Y.Doc): ReadonlySet<string> {
  return tagKeys(doc);
}
