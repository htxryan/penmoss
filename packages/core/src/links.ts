/**
 * Wikilinks and embeds as data (T16, T13): what a note links to, with the
 * text around each link, for the D1 `links` index, the Backlinks panel, the
 * graph and embeds. DOM-free and Yjs-free: it reads ProseMirror JSON, which
 * the server gets from `PMNode.toJSON()` and clients from the replica's delta
 * (sync-client `yjs14.ts`).
 *
 * A link's context keeps each wikilink in it as a reference, not as text, so
 * the Backlinks panel shows every link with its target's current title, even
 * after a rename (`contextText`).
 */

import { findHeading } from './line-symbols';

/** The part of ProseMirror's JSON form that link extraction reads. */
export interface DocJson {
  readonly type?: string;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
  readonly content?: readonly DocJson[] | undefined;
  readonly text?: string | undefined;
  readonly marks?:
    | readonly { readonly type: string; readonly attrs?: Readonly<Record<string, unknown>> }[]
    | undefined;
}

/** A wikilink or embed as stored: `noteId` is null while the link is unresolved. */
export interface LinkRef {
  readonly noteId: string | null;
  /** The target as written (the title when it was linked); shown when the note is unknown. */
  readonly target: string;
  readonly heading: string | null;
  readonly alias: string | null;
}

/** Text, or a link shown by its target's current title. */
export type ContextPart = string | LinkRef;

export interface NoteLink extends LinkRef {
  /** `![[…]]`: the note (or section) is embedded, not linked. */
  readonly embed: boolean;
  /** The text of the block holding the link, trimmed around it. */
  readonly context: readonly ContextPart[];
}

/** Characters of context kept on each side of a link in a long block. */
export const CONTEXT_RADIUS = 100;

/**
 * Links kept in a context on each side of its own (T37 review): links cost
 * no characters, so without a limit a paragraph of thousands of adjacent
 * links would store every one of them in every link's context, and the
 * index and the Backlinks panel would grow with its square.
 */
export const CONTEXT_LINKS = 10;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function linkRefOf(attrs: Readonly<Record<string, unknown>> | undefined): LinkRef {
  return {
    noteId: str(attrs?.['noteId']) || null,
    target: str(attrs?.['target']) ?? '',
    heading: str(attrs?.['heading']),
    alias: str(attrs?.['alias']),
  };
}

/** Every wikilink and embed in a document, in document order. */
export function extractLinks(doc: DocJson): NoteLink[] {
  const links: NoteLink[] = [];
  const visit = (node: DocJson) => {
    if (node.type === 'embed') {
      const ref = linkRefOf(node.attrs);
      links.push({ ...ref, embed: true, context: [ref] });
      return;
    }
    const children = node.content ?? [];
    if (children.some((child) => child.type === 'text' || child.type === 'wikilink')) {
      textblockLinks(children, links);
      return;
    }
    for (const child of children) visit(child);
  };
  visit(doc);
  return links;
}

/** Links in one textblock, each with the block's text as context. */
function textblockLinks(children: readonly DocJson[], out: NoteLink[]): void {
  const parts: ContextPart[] = [];
  const at: number[] = [];
  for (const child of children) {
    if (child.type === 'wikilink') {
      at.push(parts.length);
      parts.push(linkRefOf(child.attrs));
    } else if (typeof child.text === 'string') {
      const last = parts.at(-1);
      if (typeof last === 'string') parts[parts.length - 1] = last + child.text;
      else parts.push(child.text);
    } else if (child.type === 'hardBreak') {
      const last = parts.at(-1);
      if (typeof last === 'string') parts[parts.length - 1] = `${last} `;
      else parts.push(' ');
    }
  }
  for (const index of at) {
    const ref = parts[index] as LinkRef;
    out.push({ ...ref, embed: false, context: trimContext(parts, index) });
  }
}

/**
 * The parts around `index`, with the text runs at either end cut to
 * CONTEXT_RADIUS and at most CONTEXT_LINKS links on each side.
 */
function trimContext(parts: readonly ContextPart[], index: number): ContextPart[] {
  const before: ContextPart[] = [];
  let budget = CONTEXT_RADIUS;
  let links = 0;
  for (let i = index - 1; i >= 0 && budget > 0; i--) {
    const part = parts[i]!;
    if (typeof part !== 'string') {
      if (links === CONTEXT_LINKS) {
        before.push('…');
        break;
      }
      links++;
      before.push(part);
      continue;
    }
    if (part.length <= budget) {
      before.push(part);
      budget -= part.length;
    } else {
      before.push(`…${cutWord(part.slice(part.length - budget), 'start')}`);
      budget = 0;
    }
  }
  const out: ContextPart[] = before.reverse();
  out.push(parts[index]!);
  budget = CONTEXT_RADIUS;
  links = 0;
  for (let i = index + 1; i < parts.length && budget > 0; i++) {
    const part = parts[i]!;
    if (typeof part !== 'string') {
      if (links === CONTEXT_LINKS) {
        out.push('…');
        break;
      }
      links++;
      out.push(part);
      continue;
    }
    if (part.length <= budget) {
      out.push(part);
      budget -= part.length;
    } else {
      out.push(`${cutWord(part.slice(0, budget), 'end')}…`);
      budget = 0;
    }
  }
  return out;
}

/** Drops a partial word at the cut end of a trimmed run. */
function cutWord(text: string, side: 'start' | 'end'): string {
  if (side === 'start') {
    const space = text.search(/\s/);
    return space > 0 && space < 20 ? text.slice(space + 1) : text;
  }
  const space = text.search(/\s\S*$/);
  return space > text.length - 20 && space > 0 ? text.slice(0, space) : text;
}

/** How a link reads: its alias, else the target's title (or the written target) and heading. */
export function linkLabel(ref: LinkRef, title: string | null): string {
  if (ref.alias) return ref.alias;
  const name = title ?? ref.target;
  return ref.heading ? `${name} › ${ref.heading}` : name;
}

/** A context as plain text, each link shown with `title` (its current title, or null when unknown). */
export function contextText(
  context: readonly ContextPart[],
  title: (noteId: string) => string | null,
): string {
  return context
    .map((part) =>
      typeof part === 'string' ? part : linkLabel(part, part.noteId ? title(part.noteId) : null),
    )
    .join('');
}

/** The headings of a document, in order (`[[Title#Heading]]` completion). */
export function headingsOf(doc: DocJson): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  for (const node of doc.content ?? []) {
    if (node.type !== 'heading') continue;
    const level = Number(node.attrs?.['level'] ?? 1);
    out.push({ level, text: inlineText(node) });
  }
  return out;
}

function inlineText(node: DocJson): string {
  return (node.content ?? [])
    .map(
      (child) =>
        child.text ?? (child.type === 'wikilink' ? linkLabel(linkRefOf(child.attrs), null) : ''),
    )
    .join('');
}

/**
 * The top-level blocks of `doc` that `heading` names (with or without its leading symbols): the heading and what
 * follows it up to the next heading of the same or a higher level. The whole
 * body when `heading` is null; null when no heading matches.
 */
export function sectionOf(doc: DocJson, heading: string | null): DocJson[] | null {
  const blocks = doc.content ?? [];
  if (heading === null || heading.trim() === '') return [...blocks];
  // With or without its leading symbols (T44, A748): `## ? Open questions` is "Open questions".
  const headings = blocks.flatMap((block, index) =>
    block.type === 'heading' ? [{ index, text: inlineText(block) }] : [],
  );
  const found = findHeading(
    headings.map((entry) => entry.text),
    heading,
  );
  if (found === -1) return null;
  const start = headings[found]!.index;
  const level = Number(blocks[start]!.attrs?.['level'] ?? 1);
  let end = start + 1;
  while (end < blocks.length) {
    const block = blocks[end]!;
    if (block.type === 'heading' && Number(block.attrs?.['level'] ?? 1) <= level) break;
    end++;
  }
  return blocks.slice(start, end);
}
