/**
 * A note's description and its AI Descriptions value in the Yjs document (PEN-161), in `meta`:
 *
 * - `description`: the text, rendered as frontmatter `description`. Absent: none.
 * - `aiDescription`: the note's own value, `on` or `off` (absent is Inherit), rendered as
 *   frontmatter `ai-description`.
 * - `descriptionOf`: the stamp of the text the description describes (`describedTextHash`), or
 *   `hand` when a person or an agent wrote it (AD6, AD12). Never rendered.
 * - `descriptionAsk`: set when a hand edit is waiting for Keep Mine or Let Claude Update It (AD12).
 *
 * Each is one attribute, so it merges on its own.
 */
import {
  HAND_WRITTEN,
  describedTextHash,
  parseAiSetting,
  type AiSetting,
} from '@penmoss/core/ai-description';
import * as Y from '@y/y';
import { readTitle, NOTE_META } from './note';
import { frontmatterTags } from './tags';
import { noteBodyForDisplay } from './markdown';
import { serializeMarkdown } from '@penmoss/core';

export const META_DESCRIPTION = 'description';
export const META_AI_DESCRIPTION = 'aiDescription';
export const META_DESCRIPTION_OF = 'descriptionOf';
export const META_DESCRIPTION_ASK = 'descriptionAsk';

/** The description, or null when the note has none. */
export function readDescription(doc: Y.Doc): string | null {
  const value: unknown = doc.get(NOTE_META).getAttr(META_DESCRIPTION);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The note's own value (Inherit when unset). */
export function readAiSetting(doc: Y.Doc): AiSetting {
  return parseAiSetting(doc.get(NOTE_META).getAttr(META_AI_DESCRIPTION));
}

/** The stamp of the described text, `hand`, or null when the note has no stamp. */
export function readDescriptionOf(doc: Y.Doc): string | null {
  const value: unknown = doc.get(NOTE_META).getAttr(META_DESCRIPTION_OF);
  return typeof value === 'string' ? value : null;
}

/** Whether a hand edit waits for Keep Mine or Let Claude Update It. */
export function descriptionAsks(doc: Y.Doc): boolean {
  return doc.get(NOTE_META).getAttr(META_DESCRIPTION_ASK) === true;
}

/** Who wrote the description: AI Descriptions, a person or an agent, or nobody yet. */
export function descriptionAuthor(doc: Y.Doc): 'ai' | 'hand' | null {
  if (readDescription(doc) === null) return null;
  return readDescriptionOf(doc) === HAND_WRITTEN ? 'hand' : 'ai';
}

/** Sets the note's own value (Inherit removes it). */
export function setAiSetting(doc: Y.Doc, value: AiSetting, origin: unknown = null): void {
  const meta = doc.get(NOTE_META);
  if (readAiSetting(doc) === value) return;
  doc.transact(() => {
    if (value === 'inherit') meta.deleteAttr(META_AI_DESCRIPTION);
    else meta.setAttr(META_AI_DESCRIPTION, value);
  }, origin);
}

/**
 * Writes a description by hand (a person in the Metadata tab, or an agent): marked `hand`, so AI
 * Descriptions never overwrites it, and asking Keep Mine or Let Claude Update It when `ask` (the
 * note's effective value is On). An empty text clears the description.
 */
export function setHandDescription(
  doc: Y.Doc,
  text: string,
  options: { readonly ask?: boolean } = {},
  origin: unknown = null,
): void {
  const clean = text.replace(/\s+/g, ' ').trim();
  const meta = doc.get(NOTE_META);
  doc.transact(() => {
    if (clean === '') {
      meta.deleteAttr(META_DESCRIPTION);
      meta.deleteAttr(META_DESCRIPTION_OF);
      meta.deleteAttr(META_DESCRIPTION_ASK);
      return;
    }
    if (readDescription(doc) !== clean) meta.setAttr(META_DESCRIPTION, clean);
    meta.setAttr(META_DESCRIPTION_OF, HAND_WRITTEN);
    if (options.ask) meta.setAttr(META_DESCRIPTION_ASK, true);
  }, origin);
}

/** Writes AI Descriptions' answer, stamped with the hash of the text it describes (AD6). */
export function setAiDescription(
  doc: Y.Doc,
  text: string,
  hash: string,
  origin: unknown = null,
): void {
  const meta = doc.get(NOTE_META);
  doc.transact(() => {
    meta.setAttr(META_DESCRIPTION, text);
    meta.setAttr(META_DESCRIPTION_OF, hash);
    meta.deleteAttr(META_DESCRIPTION_ASK);
  }, origin);
}

/** Removes the description and its stamp (Clear). The note's value is kept. */
export function clearDescription(doc: Y.Doc, origin: unknown = null): void {
  const meta = doc.get(NOTE_META);
  doc.transact(() => {
    meta.deleteAttr(META_DESCRIPTION);
    meta.deleteAttr(META_DESCRIPTION_OF);
    meta.deleteAttr(META_DESCRIPTION_ASK);
  }, origin);
}

/**
 * Answers the hand-edit question (AD12): Keep Mine turns the note Off and keeps the text; Let
 * Claude Update It drops the `hand` mark so the next change (or Describe Now) describes it.
 */
export function answerDescriptionAsk(
  doc: Y.Doc,
  answer: 'keep' | 'update',
  origin: unknown = null,
): void {
  const meta = doc.get(NOTE_META);
  doc.transact(() => {
    meta.deleteAttr(META_DESCRIPTION_ASK);
    if (answer === 'keep') meta.setAttr(META_AI_DESCRIPTION, 'off');
    else meta.deleteAttr(META_DESCRIPTION_OF);
  }, origin);
}

/** The stamp of the note's text now: its title, frontmatter tags and body as markdown. */
export function noteTextHash(doc: Y.Doc): string {
  const body = serializeMarkdown({ frontmatter: null, doc: noteBodyForDisplay(doc) });
  return describedTextHash(readTitle(doc), frontmatterTags(doc), body);
}

/**
 * Whether the note's text differs from what its description describes: true when it has no
 * stamp; never for a description written by hand, which AI Descriptions leaves alone.
 */
export function needsDescription(doc: Y.Doc): boolean {
  const of = readDescriptionOf(doc);
  if (of === HAND_WRITTEN) return false;
  return of !== noteTextHash(doc);
}
