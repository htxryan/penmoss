import { Document, isMap, isScalar, isSeq, parseDocument, type ToStringOptions } from 'yaml';

/**
 * A note's YAML frontmatter. It wraps a `yaml` Document so comments, key order,
 * quoting and unknown keys survive edits. Frontmatter that was never modified
 * serialises back to its source byte for byte.
 */
export interface Frontmatter {
  /** The YAML text between the `---` fences, as read. */
  readonly source: string;
  readonly document: Document;
  /** True once fields were set; serialisation then re-prints the document. */
  readonly modified: boolean;
  /** YAML parse errors. Invalid frontmatter is kept verbatim and never re-printed. */
  readonly errors: readonly string[];
}

/** The frontmatter keys Penmoss reads and writes, in canonical order. */
export const KNOWN_FRONTMATTER_KEYS = [
  'id',
  'title',
  'created',
  'updated',
  'tags',
  'aliases',
  'type',
] as const;

export interface NoteMeta {
  id?: string;
  title?: string;
  created?: string;
  updated?: string;
  tags?: string[];
  aliases?: string[];
  type?: string;
}

const TO_STRING: ToStringOptions = { lineWidth: 0, flowCollectionPadding: false };

export function parseFrontmatter(source: string): Frontmatter {
  const document = parseDocument(source);
  return {
    source,
    document,
    modified: false,
    errors: document.errors.map((error) => error.message),
  };
}

/** Builds frontmatter from note metadata, with known keys in canonical order. */
export function createFrontmatter(meta: NoteMeta): Frontmatter {
  return setFrontmatterFields(parseFrontmatter(''), canonicalOrder(meta));
}

/** The YAML text to place between `---` fences: empty, or ending in a newline. */
export function serializeFrontmatter(frontmatter: Frontmatter): string {
  if (!frontmatter.modified || frontmatter.errors.length > 0) {
    return ensureFinalNewline(frontmatter.source);
  }
  const contents = frontmatter.document.contents;
  if (contents === null || (isMap(contents) && contents.items.length === 0)) {
    return frontmatter.document.commentBefore ? frontmatter.document.toString(TO_STRING) : '';
  }
  return frontmatter.document.toString(TO_STRING);
}

/**
 * Returns new frontmatter with `fields` set. Existing keys keep their position,
 * new keys are appended, and `undefined` removes a key. Lists are written in
 * flow style (`[a, b]`). The input is not mutated.
 */
export function setFrontmatterFields(
  frontmatter: Frontmatter,
  fields: Readonly<Record<string, unknown>>,
): Frontmatter {
  if (frontmatter.errors.length > 0) {
    throw new Error(`Cannot edit invalid frontmatter: ${frontmatter.errors.join('; ')}`);
  }
  const document = frontmatter.document.clone();
  if (!isMap(document.contents)) {
    document.contents = document.createNode({});
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      document.delete(key);
      continue;
    }
    const node = document.createNode(value);
    if (isSeq(node)) node.flow = true;
    document.set(key, node);
  }
  return { source: frontmatter.source, document, modified: true, errors: [] };
}

/**
 * Every top-level key, as written (known or not), so a caller that keeps only
 * some can refuse the rest rather than drop them. Null when the frontmatter is
 * malformed or is not a map of keys; an empty block has none.
 */
export function frontmatterKeys(frontmatter: Frontmatter): string[] | null {
  const contents = frontmatter.document.contents;
  if (frontmatter.errors.length > 0) return null;
  if (contents === null) return [];
  if (!isMap(contents)) return null;
  return contents.items.map((pair) => String(isScalar(pair.key) ? pair.key.value : pair.key));
}

/** Reads the known keys; values of the wrong shape are omitted, never coerced. */
export function readNoteMeta(frontmatter: Frontmatter): NoteMeta {
  const meta: NoteMeta = {};
  const contents = frontmatter.document.contents;
  if (frontmatter.errors.length > 0 || !isMap(contents)) return meta;

  for (const key of ['id', 'title', 'created', 'updated', 'type'] as const) {
    const value = scalarString(contents.get(key, true));
    if (value !== undefined) meta[key] = value;
  }
  for (const key of ['tags', 'aliases'] as const) {
    const value = stringList(contents.get(key, true));
    if (value !== undefined) meta[key] = value;
  }
  return meta;
}

function scalarString(node: unknown): string | undefined {
  if (!isScalar(node) || node.value === null) return undefined;
  const value = node.value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(node.source ?? value);
  return undefined;
}

function stringList(node: unknown): string[] | undefined {
  if (isSeq(node)) {
    const items: string[] = [];
    for (const item of node.items) {
      const value = scalarString(item);
      if (value === undefined) return undefined;
      items.push(value);
    }
    return items;
  }
  const single = scalarString(node);
  return single === undefined ? undefined : [single];
}

function canonicalOrder(meta: NoteMeta): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of KNOWN_FRONTMATTER_KEYS) {
    if (meta[key] !== undefined) ordered[key] = meta[key];
  }
  return ordered;
}

function ensureFinalNewline(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}
