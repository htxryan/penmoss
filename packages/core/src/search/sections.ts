/**
 * What search reads from a note body besides its plain text: the headings
 * (the FTS `headings` column, T22) and the heading sections that semantic
 * search embeds (T23). Both read ProseMirror JSON, which the NoteDoc renders
 * on the server and clients read from their replica (`bodyJson`), so the
 * two sides index the same headings.
 */
import { headingsOf, linkLabel, linkRefOf, type DocJson } from '../links';

/** The headings column: one heading per line. */
export function noteHeadings(doc: DocJson): string {
  return headingsOf(doc)
    .map((heading) => heading.text)
    .join('\n');
}

export interface NoteSection {
  /** The section's own heading; null for the text before the first heading. */
  readonly heading: string | null;
  /** The headings it sits under, outermost first, ending with its own. */
  readonly path: readonly string[];
  /** Its blocks' text, one line per text block (links read as their labels). */
  readonly text: string;
}

/** A heading and what follows it up to the next heading of any level. */
export function noteSections(doc: DocJson): NoteSection[] {
  const sections: Array<{ heading: string | null; path: string[]; lines: string[] }> = [
    { heading: null, path: [], lines: [] },
  ];
  const trail: Array<{ level: number; text: string }> = [];
  for (const block of doc.content ?? []) {
    if (block.type === 'heading') {
      const level = Number(block.attrs?.['level'] ?? 1);
      const text = inlineText(block);
      while (trail.length > 0 && trail.at(-1)!.level >= level) trail.pop();
      trail.push({ level, text });
      sections.push({ heading: text, path: trail.map((entry) => entry.text), lines: [] });
      continue;
    }
    blockLines(block, sections.at(-1)!.lines);
  }
  return sections
    .filter((section, index) => index > 0 || section.lines.length > 0)
    .map((section) => ({
      heading: section.heading,
      path: section.path,
      text: section.lines.join('\n'),
    }));
}

function inlineText(node: DocJson): string {
  return (node.content ?? [])
    .map(
      (child) =>
        child.text ?? (child.type === 'wikilink' ? linkLabel(linkRefOf(child.attrs), null) : ''),
    )
    .join('');
}

/** Text blocks' text, in document order, empty ones left out. */
function blockLines(node: DocJson, out: string[]): void {
  const children = node.content ?? [];
  if (children.some((child) => child.type === 'text' || child.type === 'wikilink')) {
    const line = inlineText(node).trim();
    if (line) out.push(line);
    return;
  }
  for (const child of children) blockLines(child, out);
}

/** Longest chunk body embedded at once; longer sections are split. bge-m3 reads far more. */
export const CHUNK_MAX_CHARS = 2000;
const PREVIEW_LENGTH = 200;
const TRAIL_SEPARATOR = ' › ';

export interface NoteChunk {
  /** The section's heading (opens the note there); null before the first heading. */
  readonly heading: string | null;
  /** What is embedded: the title and heading trail, then the section's text. */
  readonly text: string;
  /** The start of the section's text, for a result's snippet. */
  readonly preview: string;
}

/**
 * The chunks semantic search embeds (T23): one per section that has text,
 * longer ones split at line and then word boundaries, each led by its
 * heading trail. Only the first chunk carries the title (A115), so renaming
 * a note embeds one chunk again, not all of them; a note's hits keep its
 * best chunk, so the title still finds the note. A note with no body text is
 * one chunk of its title, so it can still be found.
 */
export function chunkNote(title: string, sections: readonly NoteSection[]): NoteChunk[] {
  const chunks: NoteChunk[] = [];
  for (const section of sections) {
    if (!section.text.trim()) continue;
    for (const piece of split(section.text, CHUNK_MAX_CHARS)) {
      const trail = chunks.length === 0 ? [title.trim(), ...section.path] : section.path;
      const head = trail.filter(Boolean).join(TRAIL_SEPARATOR);
      chunks.push({
        heading: section.heading,
        text: head ? `${head}\n\n${piece}` : piece,
        preview: piece.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH),
      });
    }
  }
  if (chunks.length === 0 && title.trim()) {
    chunks.push({ heading: null, text: title.trim(), preview: '' });
  }
  return chunks;
}

/** `text` in pieces of at most `max` characters, cut at line breaks, then at spaces. */
function split(text: string, max: number): string[] {
  const pieces: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = '';
  };
  for (const line of text.split('\n')) {
    for (const part of splitLine(line, max)) {
      if (current && current.length + 1 + part.length > max) push();
      current = current ? `${current}\n${part}` : part;
    }
  }
  push();
  return pieces;
}

function splitLine(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
