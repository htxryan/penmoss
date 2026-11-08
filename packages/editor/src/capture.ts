/**
 * Quick capture (T30): what a capture writes into a note's Yjs document.
 *
 * To today's note, a capture goes at the end of its `## Captures` section,
 * which is added at the end of the note the first time and reused after
 * that (the last one, when two devices each added one offline). The capture starts with its time in bold (`**14:32** Call Sam`), in
 * the synced time zone the daily note itself is chosen by (A77). Headings in
 * the captured text are demoted to level 3, so a capture never ends the
 * Captures section and the next one still lands inside it.
 *
 * The change is the smallest diff against the body as it is (`setBody`, as
 * agent edits are, A120): blocks other devices are editing keep their Yjs
 * items. Pure functions over a Y.Doc, so they run the same in the app, the
 * Mac capture window and tests; nothing here needs the network.
 *
 * Loaded lazily with the markdown codec, like daily-note templates.
 */
import { isEmptyBody, findSection, replaceBlocks } from '@penmoss/core/diff-apply';
import { parseMarkdown, schema } from '@penmoss/core';
import { setBody } from '@penmoss/sync-client/history';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { pmnodeToDelta, ynodeToPmnode } from '@y/prosemirror';
import type * as Y from '@y/y';
import type { Node as PMNode } from '@tiptap/pm/model';

export const CAPTURES_HEADING = 'Captures';
/** Headings above this level would end the Captures section (`##`). */
const LOWEST_CAPTURE_HEADING = 3;

/** `14:32` in `timeZone` (24-hour, the same on every device whatever its locale). */
export function captureTime(date: Date, timeZone: string): string {
  const parts = new Map(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get('hour') ?? '00'}:${parts.get('minute') ?? '00'}`;
}

/** The body as a core-schema document (an empty body is one empty paragraph). */
function bodyOf(doc: Y.Doc): PMNode {
  const root = doc.get(NOTE_ROOT);
  if (root.length === 0) return schema.node('doc', null, [schema.node('paragraph')]);
  return ynodeToPmnode(root, schema);
}

/** A heading that would end the Captures section becomes a level-3 one. */
function demote(block: PMNode): PMNode {
  if (block.type.name !== 'heading') return block;
  const level = Number(block.attrs['level'] ?? 1);
  if (level >= LOWEST_CAPTURE_HEADING) return block;
  return block.type.create({ ...block.attrs, level: LOWEST_CAPTURE_HEADING }, block.content);
}

/**
 * The blocks a capture adds: the markdown's blocks, the first one led by the
 * time in bold when there is one (a paragraph of its own when the capture
 * does not start with text). Empty when there is nothing to capture.
 */
export function captureBlocks(markdown: string, time: string | null): PMNode[] {
  if (markdown.trim() === '') return [];
  const parsed = parseMarkdown(markdown).doc;
  const blocks: PMNode[] = [];
  parsed.forEach((block) => {
    if (!(block.type.name === 'paragraph' && block.content.size === 0)) blocks.push(demote(block));
  });
  if (blocks.length === 0 || time === null) return blocks;
  const stamp = schema.text(time, [schema.marks['bold'].create()]);
  const first = blocks[0]!;
  if (first.type.name === 'paragraph') {
    blocks[0] = first.type.create(first.attrs, [stamp, schema.text(' ')].concat(children(first)));
  } else {
    blocks.unshift(schema.node('paragraph', null, [stamp]));
  }
  return blocks;
}

function children(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((child) => out.push(child));
  return out;
}

/** Writes `next` as the smallest change; false when it equals the body already. */
function write(doc: Y.Doc, next: PMNode): boolean {
  // Only bodies that fit the schema every app opens are written (A159).
  next.check();
  let changed = false;
  doc.transact(() => {
    changed = setBody(doc, pmnodeToDelta(next));
  });
  return changed;
}

/**
 * Appends a capture to the `## Captures` section of a note (today's), adding
 * the heading at the end of the note the first time. Returns whether the
 * note changed (false for an empty capture).
 */
export function appendCapture(doc: Y.Doc, markdown: string, time: string): boolean {
  const next = withCapture(bodyOf(doc), markdown, time);
  return next !== null && write(doc, next);
}

/**
 * The body with a capture added at the end of its `## Captures` section (the
 * heading added at the end the first time), or null for an empty capture.
 * Pure, so the server applies captures the Android app sends (T34) exactly
 * as the apps do.
 */
export function withCapture(body: PMNode, markdown: string, time: string): PMNode | null {
  const blocks = captureBlocks(markdown, time);
  if (blocks.length === 0) return null;
  const lookup = findSection(body, `## ${CAPTURES_HEADING}`);
  // Two `## Captures` headings (two devices each made one offline, then merged): the last one
  // collects captures, on every device, so later captures stay together at the end (A227).
  const section = lookup.ok
    ? lookup.section
    : lookup.reason === 'ambiguous'
      ? lookup.matches.at(-1)!
      : null;
  if (section) return replaceBlocks(body, section.end, section.end, blocks);
  const heading = schema.node('heading', { level: 2 }, [schema.text(CAPTURES_HEADING)]);
  const at = isEmptyBody(body) ? 0 : body.childCount;
  return replaceBlocks(body, at, body.childCount, [heading, ...blocks]);
}

/** Appends markdown to the end of a note's body (a new Inbox note's text). */
export function appendMarkdown(doc: Y.Doc, markdown: string): boolean {
  const next = withMarkdown(bodyOf(doc), markdown);
  return next !== null && write(doc, next);
}

/** The body with markdown added at its end (an empty body replaced), or null when there is none. */
export function withMarkdown(body: PMNode, markdown: string): PMNode | null {
  const blocks = captureBlocks(markdown, null);
  if (blocks.length === 0) return null;
  const at = isEmptyBody(body) ? 0 : body.childCount;
  return replaceBlocks(body, at, body.childCount, blocks);
}

/** The longest title a capture's first line gives a new note. */
export const CAPTURE_TITLE_MAX = 120;

const PICTURE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const LIST_OR_HEADING = /^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;

/**
 * A capture filed as a new note (T30, A227; T34, A343). The first line with
 * words in it is the title (list markers, heading marks and quotes taken off)
 * and the rest is the body, in order. Nothing is ever dropped: a first line
 * longer than {@link CAPTURE_TITLE_MAX} gives a title cut at a word with "…",
 * and stays whole as the body's first block; pictures on the title's line
 * stay in the body. A capture of pictures only is titled "Picture" (or
 * "Pictures"), followed by `day` when given, and keeps all of them as its body.
 */
export function splitCapture(text: string, day?: string): { title: string; body: string } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex(
    (line) => line.trim().replace(LIST_OR_HEADING, '').replace(PICTURE, '').trim() !== '',
  );
  if (first < 0) {
    const body = text.trim();
    if (body === '') return { title: '', body: '' };
    const pictures = body.match(PICTURE)?.length ?? 0;
    const title = (pictures > 1 ? 'Pictures' : 'Picture') + (day ? ` ${day}` : '');
    return { title, body };
  }
  const line = lines[first]!.trim();
  const words = line.replace(LIST_OR_HEADING, '').trim();
  const plain = words.replace(PICTURE, ' ').replace(/\s+/g, ' ').trim();
  const title = shorten(plain);
  // The line stays in the body when the title does not hold all of it.
  const kept = title === words ? [] : [line];
  const body = [...lines.slice(0, first), ...kept, ...lines.slice(first + 1)].join('\n').trim();
  return { title, body };
}

/** At most {@link CAPTURE_TITLE_MAX} characters, cut at a word with "…" when longer. */
function shorten(words: string): string {
  if (words.length <= CAPTURE_TITLE_MAX) return words;
  let cut = words.slice(0, CAPTURE_TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  if (space >= CAPTURE_TITLE_MAX / 2) cut = cut.slice(0, space);
  // Never half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
