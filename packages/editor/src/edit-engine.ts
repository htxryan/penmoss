/**
 * The agent edit engine (T24, A3, A120–A126): operations an agent (or the
 * app, for tag renames) asks the server to make to one note. Each operation
 * is planned against the note as it is now, then applied as the smallest
 * change: the target body is built from the live blocks (untouched blocks
 * are the live blocks themselves, `reuseBlocks` keeps unchanged ones the
 * agent sent back), turned into a Yjs delta and diffed against the live body
 * (`setBody`). Only what the operation changed gets new Yjs items, so a
 * human typing elsewhere in the note at the same moment loses nothing.
 *
 * Pure functions over Yjs documents: the NoteDoc runs them inside one
 * transaction under the agent's own client id, then versions the result.
 */
import {
  frontmatterKeys,
  parseMarkdown,
  readNoteMeta,
  schema,
  serializeMarkdown,
  type LinkResolver,
} from '@penmoss/core';
import {
  blocksOf,
  findSection,
  isEmptyBody,
  markdownOccurrences,
  replaceBlocks,
  reuseBlocks,
  sectionMarkdown,
  sectionsOf,
  type SectionLookup,
} from '@penmoss/core/diff-apply';
import { cleanTags, normaliseTag } from '@penmoss/core/tags';
import { withCapture, withMarkdown } from './capture';
import { reanchorAcrossEdit } from '@penmoss/sync-client/comments';
import { setBody } from '@penmoss/sync-client/history';
import { readTitle, setTitle } from '@penmoss/sync-client/note';
import {
  changeTagInDoc,
  frontmatterTags,
  renameTagInDoc,
  setFrontmatterTag,
} from '@penmoss/sync-client/tags';
import type * as Y from '@y/y';
import type { Node as PMNode } from '@tiptap/pm/model';
import { bodyDelta, noteBody, unfitBody } from './markdown';

/** What find-and-replace may match: prose only (the default), or the whole markdown. */
export type ReplaceScope = 'text' | 'markdown';

/** Where `section` content goes: in place of the section's body, or at its start or end. */
export type SectionMode = 'replace' | 'prepend' | 'append';

/** One operation on an existing note (create is separate: it has no live note). */
export type EditOp =
  | { readonly op: 'append'; readonly markdown: string; readonly heading?: string | undefined }
  | {
      readonly op: 'section';
      readonly heading: string;
      readonly markdown: string;
      readonly mode: SectionMode;
    }
  | {
      readonly op: 'replace';
      readonly find: string;
      readonly replace: string;
      readonly all: boolean;
      /**
       * `text` (the default): only prose, never a link's address or title, a
       * wikilink or embed, an image or a link definition; `markdown`: anywhere.
       */
      readonly scope?: ReplaceScope;
    }
  | {
      readonly op: 'properties';
      readonly title?: string | undefined;
      readonly tags?: readonly string[] | undefined;
    }
  | {
      readonly op: 'tag';
      readonly add: readonly string[];
      readonly remove: readonly string[];
    }
  | { readonly op: 'rename-tag'; readonly from: string; readonly to: string }
  /** Removes a tag and those nested under it; an inline tag keeps its word, without its `#`. */
  | { readonly op: 'delete-tag'; readonly tag: string }
  | {
      /**
       * A quick capture from a client that never reads Yjs (the Android app, T34, A335): added
       * as the apps add one (`@penmoss/editor/capture`, T30), at the end of `## Captures` led
       * by its time, or, with no time, at the end of the note (a new Inbox note's text).
       */
      readonly op: 'capture';
      readonly markdown: string;
      readonly time: string | null;
    };

/** A refusal, with the HTTP status the API answers with. */
export interface EditFailure {
  readonly ok: false;
  readonly status: 400 | 403 | 404 | 409 | 422 | 429;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

const fail = (
  status: EditFailure['status'],
  code: string,
  message: string,
  details?: Record<string, unknown>,
): EditFailure => ({ ok: false, status, code, message, ...(details ? { details } : {}) });

/** At most this much of each text a 409 shows (review): the agent reads the note again anyway. */
export const MAX_CONFLICT_TEXT = 4000;

function clip(text: string): string {
  return text.length > MAX_CONFLICT_TEXT ? `${text.slice(0, MAX_CONFLICT_TEXT)}…` : text;
}

/** A note's headings as edits name them (`## Plans`), in order. */
export function headingRefs(body: PMNode): string[] {
  return sectionsOf(body).map((section) => `${'#'.repeat(section.level)} ${section.text}`);
}

/** The properties a note keeps (A16, A73): all an agent may set, on create or afterwards. */
export const NOTE_PROPERTIES: readonly string[] = ['title', 'tags'];

/** 422 for properties a note does not keep, on create (frontmatter) and in `properties` alike. */
export function unknownProperties(keys: readonly string[]): EditFailure {
  return fail(
    422,
    'unknown_properties',
    `Only title and tags can be set (not ${keys.join(', ')})`,
    { keys: [...keys] },
  );
}

/** What an operation will do, computed before anything is written. */
export interface EditPlan {
  readonly ok: true;
  /** The body to diff in, when the body changes. */
  readonly body?: PMNode;
  readonly title?: string;
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
  /** Replaces the frontmatter tags with exactly these. */
  readonly setTags?: readonly string[];
  readonly renameTag?: { readonly from: string; readonly to: string };
  readonly deleteTag?: string;
  /** For the version's summary, e.g. `Replaced section “Plans”`. */
  readonly label: string;
}

/** The wikilink and embed targets written in markdown, so the caller can resolve them first. */
export function linkTargets(markdown: string): string[] {
  const targets = new Set<string>();
  parseMarkdown(markdown, {
    links: {
      resolve: (target) => {
        if (target.trim()) targets.add(target.trim());
        return null;
      },
      linkText: () => null,
    },
  });
  return [...targets];
}

/** The markdown an operation brings in (its links need resolving before planning). */
export function incomingMarkdown(op: EditOp): string {
  switch (op.op) {
    case 'append':
    case 'section':
      return op.markdown;
    case 'replace':
      return op.replace;
    default:
      return '';
  }
}

/** Parses an agent's markdown body; frontmatter belongs in `properties`. */
function parseBody(markdown: string, links: LinkResolver): PMNode[] | EditFailure {
  const parsed = parseMarkdown(markdown, { links });
  if (parsed.frontmatter) {
    return fail(
      400,
      'invalid_request',
      'Frontmatter is only accepted when creating a note; set the title and tags with properties',
    );
  }
  return isEmptyBody(parsed.doc) ? [] : blocksOf(parsed.doc);
}

function sectionFailure(lookup: Extract<SectionLookup, { ok: false }>, heading: string) {
  const headings = lookup.matches.map((match) => `${'#'.repeat(match.level)} ${match.text}`);
  return lookup.reason === 'ambiguous'
    ? fail(
        422,
        'heading_ambiguous',
        `More than one heading reads “${heading}”; add its level (e.g. “## ${heading}”)`,
        { headings },
      )
    : fail(422, 'heading_not_found', `No heading reads “${heading}”`, { headings });
}

/** The body markdown of a document, links written as the resolver says. */
export function bodyText(body: PMNode, links: LinkResolver): string {
  return serializeMarkdown({ frontmatter: null, doc: body }, { links });
}

/**
 * 422 when a planned body would not open in the apps (A159). The codec only
 * builds bodies that fit (its property tests), so this is a backstop: the
 * agent hears why, and nothing is written.
 */
export function unopenableBody(body: PMNode): EditFailure | null {
  const problem = unfitBody(body);
  return problem === null
    ? null
    : fail(
        422,
        'unsupported_markdown',
        'The markdown would make a note the apps cannot open; nothing was changed. Write it more plainly',
        { problem },
      );
}

/**
 * Works out what `op` does to `live` (nothing is written). `links` resolves
 * wikilinks in the incoming markdown and writes the live ones the way agents
 * read them, so find-and-replace matches the markdown an agent was shown.
 */
export function planEdit(live: Y.Doc, op: EditOp, links: LinkResolver): EditPlan | EditFailure {
  const plan = planOp(live, op, links);
  return (plan.ok && plan.body && unopenableBody(plan.body)) || plan;
}

function planOp(live: Y.Doc, op: EditOp, links: LinkResolver): EditPlan | EditFailure {
  switch (op.op) {
    case 'append': {
      const body = noteBody(live);
      const blocks = parseBody(op.markdown, links);
      if (!Array.isArray(blocks)) return blocks;
      if (blocks.length === 0) return fail(400, 'invalid_request', 'Nothing to append');
      if (op.heading !== undefined) {
        const lookup = findSection(body, op.heading);
        if (!lookup.ok) return sectionFailure(lookup, op.heading);
        return {
          ok: true,
          body: replaceBlocks(body, lookup.section.end, lookup.section.end, blocks),
          label: `Added to “${lookup.section.text}”`,
        };
      }
      // A new note's empty paragraph is replaced, not kept as a blank first line.
      const at = isEmptyBody(body) ? 0 : body.childCount;
      return {
        ok: true,
        body: replaceBlocks(body, at, body.childCount, blocks),
        label: 'Appended',
      };
    }
    case 'section': {
      const body = noteBody(live);
      const lookup = findSection(body, op.heading);
      if (!lookup.ok) return sectionFailure(lookup, op.heading);
      const blocks = parseBody(op.markdown, links);
      if (!Array.isArray(blocks)) return blocks;
      const { section } = lookup;
      if (op.mode === 'replace') {
        const current: PMNode[] = [];
        for (let i = section.start; i < section.end; i++) current.push(body.child(i));
        return {
          ok: true,
          body: replaceBlocks(
            body,
            section.start,
            section.end,
            reuseBlocks(blocks, current, links),
          ),
          label: `Replaced section “${section.text}”`,
        };
      }
      if (blocks.length === 0) return fail(400, 'invalid_request', 'Nothing to insert');
      const at = op.mode === 'prepend' ? section.start : section.end;
      return {
        ok: true,
        body: replaceBlocks(body, at, at, blocks),
        label: `Added to “${section.text}”`,
      };
    }
    case 'replace': {
      if (!op.find) return fail(400, 'invalid_request', 'find must not be empty');
      const body = noteBody(live);
      const text = bodyText(body, links);
      const textOnly = (op.scope ?? 'text') === 'text';
      const found = markdownOccurrences(text, op.find, { textOnly });
      if (found.length === 0) {
        const inLinks = textOnly && markdownOccurrences(text, op.find).length > 0;
        return fail(
          422,
          'text_not_found',
          inLinks
            ? 'The text is only in link addresses or [[targets]]; pass scope "markdown" to replace it there'
            : 'The text to replace is not in the note',
        );
      }
      if (found.length > 1 && !op.all) {
        return fail(
          422,
          'text_ambiguous',
          `The text appears ${found.length} times; make it unique or replace all`,
          { occurrences: found.length },
        );
      }
      const next = spliceAll(text, op.all ? found : found.slice(0, 1), op);
      const parsed = parseMarkdown(next, { links });
      if (parsed.frontmatter) {
        return fail(
          400,
          'invalid_request',
          'The replacement would start the note with frontmatter',
        );
      }
      return {
        ok: true,
        body: schema.node('doc', null, reuseBlocks(blocksOf(parsed.doc), blocksOf(body), links)),
        label: `Replaced ${found.length === 1 ? 'text' : `${found.length} matches`}`,
      };
    }
    case 'properties': {
      if (op.title === undefined && op.tags === undefined) {
        return fail(400, 'invalid_request', 'Set title or tags');
      }
      const tags = op.tags === undefined ? undefined : validTags(op.tags);
      if (tags && !Array.isArray(tags)) return tags;
      return {
        ok: true,
        ...(op.title !== undefined ? { title: op.title } : {}),
        ...(tags ? { setTags: tags } : {}),
        label: 'Set properties',
      };
    }
    case 'tag': {
      const add = validTags(op.add);
      if (!Array.isArray(add)) return add;
      const remove = validTags(op.remove);
      if (!Array.isArray(remove)) return remove;
      if (add.length + remove.length === 0) return fail(400, 'invalid_request', 'No tags given');
      return { ok: true, addTags: add, removeTags: remove, label: 'Tagged' };
    }
    case 'rename-tag': {
      const from = normaliseTag(op.from);
      const to = normaliseTag(op.to);
      if (!from || !to) return fail(400, 'invalid_request', 'Invalid tag');
      return { ok: true, renameTag: { from, to }, label: `Renamed #${from} to #${to}` };
    }
    case 'delete-tag': {
      const tag = normaliseTag(op.tag);
      if (!tag) return fail(400, 'invalid_request', 'Invalid tag');
      return { ok: true, deleteTag: tag, label: `Deleted #${tag}` };
    }
    case 'capture': {
      const current = noteBody(live);
      const body =
        op.time === null
          ? withMarkdown(current, op.markdown)
          : withCapture(current, op.markdown, op.time);
      if (!body) return fail(400, 'invalid_request', 'Nothing to capture');
      return { ok: true, body, label: 'Captured' };
    }
  }
}

/** `text` with `op.find` at each of `at` (left to right, not overlapping) replaced. */
function spliceAll(
  text: string,
  at: readonly { readonly index: number }[],
  op: Extract<EditOp, { op: 'replace' }>,
): string {
  let out = '';
  let from = 0;
  for (const { index } of at) {
    out += text.slice(from, index) + op.replace;
    from = index + op.find.length;
  }
  return out + text.slice(from);
}

function validTags(raw: readonly string[]): string[] | EditFailure {
  const out: string[] = [];
  for (const tag of raw) {
    const clean = normaliseTag(tag.replace(/^#/, ''));
    if (!clean) return fail(400, 'invalid_request', `Not a valid tag: “${tag}”`);
    out.push(clean);
  }
  return cleanTags(out);
}

/** Applies a plan to the live document. Call inside one transaction. */
export function applyPlan(live: Y.Doc, plan: EditPlan): void {
  // A thread on words the edit rewrote moves onto the new words (A1096).
  const body = plan.body;
  if (body) reanchorAcrossEdit(live, () => setBody(live, bodyDelta(body)));
  if (plan.title !== undefined) setTitle(live, plan.title);
  if (plan.setTags) {
    const wanted = new Set(plan.setTags);
    for (const tag of frontmatterTags(live))
      if (!wanted.has(tag)) setFrontmatterTag(live, tag, false);
    for (const tag of wanted) setFrontmatterTag(live, tag, true);
  }
  for (const tag of plan.removeTags ?? []) setFrontmatterTag(live, tag, false);
  for (const tag of plan.addTags ?? []) setFrontmatterTag(live, tag, true);
  if (plan.renameTag) renameTagInDoc(live, plan.renameTag.from, plan.renameTag.to);
  if (plan.deleteTag) changeTagInDoc(live, { from: plan.deleteTag, to: null });
}

/**
 * Whether what `op` targets changed between the version the agent read
 * (`base`) and now (A121): the section it edits, the lines around the text it
 * replaces, the properties it sets. Appending to the end of a note and adding
 * or removing tags target nothing that can go stale. Null when the operation
 * may go ahead.
 */
export function baseConflict(
  base: Y.Doc,
  live: Y.Doc,
  op: EditOp,
  links: LinkResolver,
): EditFailure | null {
  const conflict = (target: string, was: string, now: string) =>
    fail(409, 'conflict', `${target} changed since the base version; read the note again`, {
      target,
      base: clip(was),
      current: clip(now),
      ...(was.length > MAX_CONFLICT_TEXT || now.length > MAX_CONFLICT_TEXT
        ? { truncated: true }
        : {}),
    });
  const heading = op.op === 'section' ? op.heading : op.op === 'append' ? op.heading : undefined;
  if (heading !== undefined) {
    const now = noteBody(live);
    const was = noteBody(base);
    const current = findSection(now, heading);
    const before = findSection(was, heading);
    if (!current.ok) return null; // Planning reports the missing heading.
    const label = `The section “${current.section.text}”`;
    const nowText = sectionMarkdown(now, current.section);
    if (!before.ok) return conflict(label, '', nowText);
    const wasText = sectionMarkdown(was, before.section);
    return wasText === nowText ? null : conflict(label, wasText, nowText);
  }
  if (op.op === 'replace') {
    const scope = { textOnly: (op.scope ?? 'text') === 'text' };
    const lines = (doc: Y.Doc) =>
      markdownOccurrences(bodyText(noteBody(doc), links), op.find, scope).map((o) => o.lines);
    const now = lines(live);
    const was = lines(base);
    return now.join('\n\u0000') === was.join('\n\u0000')
      ? null
      : conflict('The text around the match', was.join('\n'), now.join('\n'));
  }
  if (op.op === 'properties') {
    if (op.title !== undefined && readTitle(base) !== readTitle(live)) {
      return conflict('The title', readTitle(base), readTitle(live));
    }
    if (op.tags !== undefined) {
      const was = frontmatterTags(base).join(' ');
      const now = frontmatterTags(live).join(' ');
      if (was !== now) return conflict('The tags', was, now);
    }
  }
  return null;
}

/** A new note's content from create's input: markdown (with optional frontmatter), title and tags. */
export function planCreate(
  input: {
    readonly title?: string | undefined;
    readonly markdown: string;
    readonly tags: readonly string[];
  },
  links: LinkResolver,
): { ok: true; body: PMNode | null; title: string; tags: string[] } | EditFailure {
  const parsed = parseMarkdown(input.markdown, { links });
  if (parsed.frontmatter) {
    // Only what the note keeps (A16, A73); anything else is refused, never dropped (review #10).
    const keys = frontmatterKeys(parsed.frontmatter);
    const unknown = keys?.filter((key) => !NOTE_PROPERTIES.includes(key)) ?? null;
    if (unknown === null) {
      return fail(422, 'unknown_properties', 'Frontmatter must be a map of title and tags');
    }
    if (unknown.length > 0) return unknownProperties(unknown);
  }
  const meta = parsed.frontmatter ? readNoteMeta(parsed.frontmatter) : {};
  const tags = validTags([...(meta.tags ?? []), ...input.tags]);
  if (!Array.isArray(tags)) return tags;
  const title = (input.title ?? meta.title ?? '').replace(/[\r\n]+/g, ' ').trim();
  const unopenable = unopenableBody(parsed.doc);
  if (unopenable) return unopenable;
  return { ok: true, body: isEmptyBody(parsed.doc) ? null : parsed.doc, title, tags };
}
