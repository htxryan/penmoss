/**
 * Renders a note's Yjs document as markdown with frontmatter (T3 codec). On the
 * server it runs inside the NoteDoc, never in a Worker request (A13): a
 * 10,000-word note takes ~25 ms to serialise, more than a Free-plan request
 * may use. Shared since T50 G1 (A832): git notebooks render with it too.
 */
import {
  createFrontmatter,
  parseMarkdown,
  schema,
  serializeMarkdown,
  type LinkResolver,
} from '@penmoss/core';
import { parseAttachmentPath } from '@penmoss/core/attachments';
import { blocksOf, reuseBlocks } from '@penmoss/core/diff-apply';
import type { DocJson } from '@penmoss/core/links';
import { noteHeadings, noteSections, type NoteSection } from '@penmoss/core/search';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { readIdentity, readTitle } from '@penmoss/sync-client/note';
import { frontmatterTags, noteTags } from '@penmoss/sync-client/tags';
import type * as Y from '@y/y';
import { pmnodeToDelta, ynodeToPmnode } from '@y/prosemirror';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface RenderedNote {
  readonly title: string;
  readonly markdown: string;
  /** Body text only, one line per block (search and excerpts). */
  readonly text: string;
  /** Every tag (frontmatter and inline, T18), sorted, lower-case. */
  readonly tags: string[];
  /** The headings, one per line: the FTS `headings` column (T22). */
  readonly headings: string;
  /** The heading sections semantic search embeds (T23). */
  readonly sections: NoteSection[];
}

/** What a render reads from the Yjs document, read in one go so a render sees one state. */
export interface NoteState {
  readonly identity: ReturnType<typeof readIdentity>;
  readonly title: string;
  /** `noteBody(doc)`. */
  readonly body: PMNode;
  /** Tags set in frontmatter only (`frontmatterTags`); inline tags stay in the body (T18). */
  readonly listedTags: string[];
  /** Every tag, frontmatter and inline (`noteTags`, T18). */
  readonly tags: string[];
}

export function readNoteState(doc: Y.Doc): NoteState {
  return {
    identity: readIdentity(doc),
    title: readTitle(doc),
    body: noteBody(doc),
    listedTags: frontmatterTags(doc),
    tags: noteTags(doc),
  };
}

/**
 * A note's frontmatter time (A209): ISO 8601 to the second, in the offset of
 * `like` (the note's `created`, as the device that made it wrote it), or UTC
 * (`Z`) when that has none. `created` and `updated` so read alike, and the
 * same instant is always written the same way.
 */
export function noteStamp(at: number, like: string | null | undefined): string {
  const match = like ? /(?:([+-])(\d{2}):(\d{2})|Z)$/.exec(like) : null;
  const sign = match?.[1];
  const offset = sign ? (sign === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  const local = new Date(Math.floor(at / 1000) * 1000 + offset * 60_000).toISOString().slice(0, 19);
  return sign ? `${local}${sign}${match[2]}:${match[3]}` : `${local}Z`;
}

/**
 * `changedAt` is the note's last content change (epoch ms; the NoteDoc's
 * `changed_at`, 0 when it has none), written as `updated` (A209): never the
 * time of the render, so a note nobody edited renders the same every time.
 * `links` writes each wikilink with its target's current title (T16);
 * `assetUrl` rewrites image and file URLs (the git mirror's relative paths, T27).
 */
export function renderNote(
  state: NoteState,
  noteId: string,
  changedAt: number,
  options: { readonly links?: LinkResolver; readonly assetUrl?: (url: string) => string } = {},
): RenderedNote {
  const { identity, title, body, tags } = state;
  const updated = changedAt > 0 ? noteStamp(changedAt, identity.created) : identity.created;
  // Inline tags stay in the body; frontmatter lists only the tags set there (T18).
  const listed = state.listedTags;
  const frontmatter = createFrontmatter({
    id: noteId,
    ...(title ? { title } : {}),
    ...(identity.created ? { created: identity.created } : {}),
    ...(updated ? { updated } : {}),
    ...(listed.length > 0 ? { tags: listed } : {}),
    ...(identity.kind && identity.kind !== 'note' ? { type: identity.kind } : {}),
  });
  return {
    title,
    markdown: serializeMarkdown(
      { frontmatter, doc: body },
      {
        ...(options.links ? { links: options.links } : {}),
        ...(options.assetUrl ? { assetUrl: options.assetUrl } : {}),
      },
    ),
    text: blockText(body),
    tags,
    ...searchParts(body),
  };
}

/** How a mirror names the notes a note links to: the file name and the title (A10). */
export type MirrorLink = (
  noteId: string,
) => { readonly name: string; readonly title: string } | null;

/**
 * A note as a git mirror writes it (T27, A204, A205): links written by the mirror's file names
 * (`[[name|Title]]` when the name is not the title) and attachment paths made relative to the
 * note's folder by `assetPrefix` (`../` per folder level). The server's mirror and git notebooks
 * both write through this (T50, A832), so the same note renders to the same bytes in both.
 */
export function mirrorMarkdown(
  state: NoteState,
  noteId: string,
  changedAt: number,
  target: { readonly link: MirrorLink; readonly assetPrefix: string },
): RenderedNote {
  const links: LinkResolver = {
    resolve: () => null,
    linkText: (id) => target.link(id)?.name ?? null,
    title: (id) => target.link(id)?.title ?? null,
  };
  const assetUrl = (url: string) => {
    const file = localAttachment(url);
    return file ? `${target.assetPrefix}attachments/${file.sha256}.${file.ext}` : url;
  };
  return renderNote(state, noteId, changedAt, { links, assetUrl });
}

/** What search reads besides the text (T22, T23), from the body as JSON like clients read it. */
function searchParts(body: PMNode): { headings: string; sections: NoteSection[] } {
  const json = body.toJSON() as DocJson;
  return { headings: noteHeadings(json), sections: noteSections(json) };
}

/**
 * A note as compared between versions (T21): its title and frontmatter tags
 * as frontmatter, then the body. No id or dates, so only content differs.
 */
export function versionMarkdown(doc: Y.Doc): string {
  const title = readTitle(doc);
  const tags = frontmatterTags(doc);
  const frontmatter = createFrontmatter({
    ...(title ? { title } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  });
  return serializeMarkdown({ frontmatter, doc: noteBody(doc) });
}

/** The body alone as markdown (T21's three-way revert works on its lines). */
export function bodyMarkdown(doc: Y.Doc): string {
  return serializeMarkdown({ frontmatter: null, doc: noteBody(doc) });
}

/**
 * The body a revert's merged markdown stands for (T21, A81), as a delta ready
 * to diff against `doc.get(NOTE_ROOT)`. Markdown does not carry everything a
 * block holds (a wikilink's note id, a table's column widths), so a top-level
 * block whose markdown equals a block of one of `sources` (the note now
 * first, then the versions) is taken from that document as it is. Only
 * blocks the merge combined are parsed, their links resolved by the targets
 * as written in `sources`.
 */
export function mergedBodyDelta(
  markdown: string,
  sources: readonly Y.Doc[],
): ReturnType<Y.Node['toDeltaDeep']> {
  const bodies = sources.map(noteBody);
  const targets = new Map<string, string>();
  for (const body of bodies) {
    body.descendants((node) => {
      const noteId = node.attrs['noteId'] as unknown;
      if ((node.type.name === 'wikilink' || node.type.name === 'embed') && noteId) {
        const target = (node.attrs['target'] as string).trim();
        if (!targets.has(target)) targets.set(target, noteId as string);
      }
      return true;
    });
  }
  const links: LinkResolver = {
    resolve: (target) => targets.get(target.trim()) ?? null,
    linkText: () => null,
  };
  const parsed = parseMarkdown(markdown, { links }).doc;
  const children = reuseBlocks(blocksOf(parsed), bodies.flatMap(blocksOf));
  return bodyDelta(children.length > 0 ? schema.node('doc', null, children) : parsed);
}

/**
 * Why `body` cannot be written into a note, or null when it can (A159): it
 * must be a document of the core schema that fits it throughout. The
 * editor's schema is core's, node for node (A9, A157, its CI test), so such a
 * body opens in every app; one that does not fit would fail to open there,
 * or have the misfit dropped from the note by the first editor to bind it.
 */
export function unfitBody(body: PMNode): string | null {
  if (body.type.schema !== schema || body.type !== schema.topNodeType) {
    return 'not a core-schema document';
  }
  try {
    body.check();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * `body` as the delta `setBody` writes, checked first (A159). Every body the
 * server writes from a ProseMirror document goes through here; a misfit
 * throws, so the change is not made (callers refuse it earlier, with a
 * reason, when they can).
 */
export function bodyDelta(body: PMNode): ReturnType<typeof pmnodeToDelta> {
  const problem = unfitBody(body);
  if (problem) throw new RangeError(`A note body must fit the schema the apps open: ${problem}`);
  return pmnodeToDelta(body);
}

/** The attachments a body uses (images and file links under `attachments/`), by SHA-256, sorted. */
export function attachmentRefs(body: PMNode): string[] {
  const found = new Set<string>();
  body.descendants((node) => {
    const path =
      node.type.name === 'image'
        ? (node.attrs['src'] as string)
        : node.type.name === 'attachment'
          ? (node.attrs['href'] as string)
          : null;
    const parsed = path ? parseAttachmentPath(path) : null;
    if (parsed) found.add(parsed.sha256);
    return true;
  });
  return [...found].sort();
}

/**
 * The attachment files a body uses, as the git mirror names them
 * (`attachments/<sha256>.<ext>`, T27): images, file links and links to them.
 */
export function attachmentFiles(body: PMNode): Array<{ sha256: string; ext: string }> {
  const found = new Map<string, { sha256: string; ext: string }>();
  const add = (path: unknown) => {
    const parsed = typeof path === 'string' ? localAttachment(path) : null;
    if (parsed)
      found.set(`${parsed.sha256}.${parsed.ext}`, { sha256: parsed.sha256, ext: parsed.ext });
  };
  body.descendants((node) => {
    if (node.type.name === 'image') add(node.attrs['src']);
    else if (node.type.name === 'attachment') add(node.attrs['href']);
    for (const mark of node.marks) if (mark.type.name === 'link') add(mark.attrs['href']);
    return true;
  });
  return [...found.keys()].sort().map((key) => found.get(key)!);
}

/**
 * The attachment a URL names when it is a path inside the workspace
 * (`attachments/<sha256>.<ext>`, with any `../` before it); null for anything
 * else, including a web address that happens to end the same way.
 */
export function localAttachment(url: string): { sha256: string; ext: string } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('/')) return null;
  return parseAttachmentPath(url);
}

/** The body as a core-schema document; an empty body is one empty paragraph. */
export function noteBody(doc: Y.Doc): PMNode {
  const root = doc.get(NOTE_ROOT);
  if (root.length === 0) return emptyDoc();
  try {
    return ynodeToPmnode(root, schema);
  } catch (error) {
    // Content the core schema rejects at the top level; surfaced in logs, never silently lost:
    // the Durable Object still holds the Yjs state.
    console.error('[markdown] body does not fit the core schema', error);
    return emptyDoc();
  }
}

function emptyDoc(): PMNode {
  return schema.node('doc', null, [schema.node('paragraph')]);
}

function blockText(doc: PMNode): string {
  const lines: string[] = [];
  doc.descendants((node) => {
    if (node.isTextblock) {
      lines.push(node.textContent);
      return false;
    }
    return true;
  });
  return lines.filter(Boolean).join('\n');
}
