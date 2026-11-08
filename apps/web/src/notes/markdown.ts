/**
 * The open note as stored markdown (T11's source view): frontmatter plus the
 * body, rendered on this device by the core codec, the same way the NoteDoc
 * renders the R2 snapshot (apps/server/src/do/markdown.ts) except `updated`,
 * which the indexer stamps (A16). The codec loads on first use, so notes that
 * never open the source view do not download it.
 */
import type { LinkResolver } from '@penmoss/core';
import { noteFields } from '@penmoss/editor/note-fields';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';

/** The frontmatter fields this device writes for the note (shared with the Android page). */
export { noteFields } from '@penmoss/editor/note-fields';

/**
 * `body` is the editor's document as JSON (`editor.getJSON()`), which fits the
 * core schema (A9). `links` writes each wikilink with its target's current
 * title, as the NoteDoc does (T16).
 */
export async function noteMarkdown(
  noteId: string,
  replica: Yjs14Replica,
  body: unknown,
  links?: LinkResolver,
): Promise<string> {
  const { createFrontmatter, schema, serializeMarkdown } = await import('@penmoss/core');
  const frontmatter = createFrontmatter(noteFields(noteId, replica));
  return serializeMarkdown({ frontmatter, doc: schema.nodeFromJSON(body) }, links ? { links } : {});
}

/** The source view's two parts: the frontmatter, read-only, and the body, which is edited. */
export interface MarkdownParts {
  /** `---` fences and YAML, and the blank line after them. */
  frontmatter: string;
  body: string;
}

/** The note's markdown cut where the frontmatter ends (Quanta feedback 3, item 4; A1133). */
export function splitMarkdown(markdown: string): MarkdownParts {
  const fence = /^---\n[\s\S]*?\n?---\n\n?/.exec(markdown);
  if (!fence) return { frontmatter: '', body: markdown };
  return { frontmatter: fence[0], body: markdown.slice(fence[0].length) };
}

/**
 * The editor document (JSON, as `editor.getJSON()`) a body of markdown reads as. It is read
 * after a frontmatter, so a leading `---` stays a rule, as it is written in the file.
 */
export async function markdownDoc(body: string, links?: LinkResolver): Promise<unknown> {
  const { parseMarkdown } = await import('@penmoss/core');
  return parseMarkdown(`---\n---\n\n${body}`, links ? { links } : {}).doc.toJSON();
}
