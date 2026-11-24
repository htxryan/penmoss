/**
 * AI Descriptions (PEN-161): a short description of each note, written by a fast model into the
 * note's `description` frontmatter, so agents can see what a note holds before they read it.
 * This module is the pure part, shared by the apps, the CLI and the MCP server:
 *
 * - The setting (Inherit, On, Off) at four levels: the note (frontmatter `ai-description`), its
 *   folder and the folders above it (`aiDescription` on each folder record), the notebook (its
 *   own setting `ai.description`), and a global On or Off (`ai.description.global`, Off unset).
 *   The closest value that is not Inherit wins (`resolveAiDescription`).
 * - When to describe (`ai.description.when`: after a pause in editing, or at each sync), the
 *   pause, the model and the prompt: synced device settings, read here with their defaults.
 * - The AI provider (`ai.provider`): this device's own choice, never synced. `none` until chosen;
 *   nothing is sent while it is `none`.
 * - The prompt's tokens (`renderPrompt`), the text hash a description is stamped with
 *   (`describedTextHash`), and cutting long notes (`cutForPrompt`).
 * - A tag's description (A1677): its own prompt (`ai.description.tagPrompt`), with tokens for
 *   the tag, the notes carrying it and the other tags on them (`tagPrompt`), written on demand
 *   from the Tags page into the notebook's `tagDescriptions` (PEN-68).
 */

import { describeTags, tagMatches } from './tags';
import { effectiveParents, type FolderRecord } from './workspace/tree';

type Settings = Readonly<Record<string, unknown>>;

/** A level's value. Global is On or Off only. */
export type AiSetting = 'inherit' | 'on' | 'off';
export const AI_SETTINGS: readonly AiSetting[] = ['inherit', 'on', 'off'];

/** The note's frontmatter key for its own value (`on` or `off`; absent is Inherit). */
export const AI_DESCRIPTION_FRONTMATTER = 'ai-description';
/** The notebook's own value (a notebook setting, A827): `on`, `off`, or unset for Inherit. */
export const AI_DESCRIPTION_NOTEBOOK_SETTING = 'ai.description';
/** The global value (synced device setting): `true` is On; anything else is Off. */
export const AI_DESCRIPTION_GLOBAL_SETTING = 'ai.description.global';
/** When to describe: `pause` (the default) or `sync`. */
export const AI_DESCRIPTION_WHEN_SETTING = 'ai.description.when';
/** The pause after the last edit, in seconds (default 120). */
export const AI_DESCRIPTION_PAUSE_SETTING = 'ai.description.pause';
/** The model id (default: the provider's fastest). */
export const AI_DESCRIPTION_MODEL_SETTING = 'ai.description.model';
/** The prompt, with tokens; unset is the built-in default. */
export const AI_DESCRIPTION_PROMPT_SETTING = 'ai.description.prompt';
/** The tag prompt (A1677), with tokens; unset is the built-in default. */
export const AI_TAG_PROMPT_SETTING = 'ai.description.tagPrompt';
/** This device's AI provider (a local setting, never synced): `none`, `anthropic`, `claude-code`. */
export const AI_PROVIDER_SETTING = 'ai.provider';

/** The synced keys this module owns (the provider is local; the notebook's is the notebook's). */
export const AI_DESCRIPTION_SETTING_KEYS: readonly string[] = [
  AI_DESCRIPTION_GLOBAL_SETTING,
  AI_DESCRIPTION_WHEN_SETTING,
  AI_DESCRIPTION_PAUSE_SETTING,
  AI_DESCRIPTION_MODEL_SETTING,
  AI_DESCRIPTION_PROMPT_SETTING,
  AI_TAG_PROMPT_SETTING,
];

export type DescribeWhen = 'pause' | 'sync';
export const DEFAULT_PAUSE_SECONDS = 120;
export const PAUSE_CHOICES_SECONDS: readonly number[] = [30, 60, 120, 300, 600];

/** The providers this build knows. More are added as entries, not new settings. */
export const AI_PROVIDER_IDS = ['none', 'anthropic', 'claude-code'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/** The Anthropic models offered, fastest first; the first is the default. */
export const ANTHROPIC_MODELS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
];
/** Claude Code's model aliases (`claude -p --model <alias>`), fastest first. */
export const CLAUDE_CODE_MODELS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'haiku', label: 'Claude Haiku' },
  { id: 'sonnet', label: 'Claude Sonnet' },
];

/** A description is at most this long once written (agents read many at once). */
export const DESCRIPTION_MAX_CHARS = 600;
/** Notes over this many tokens are cut before they are sent (AD9). */
export const PROMPT_TOKEN_LIMIT = 24_000;
/** About this many characters make a token, for cutting without loading a tokenizer. */
const CHARS_PER_TOKEN = 4;

/** What marks the descriptionOf stamp of a description written by a person or an agent. */
export const HAND_WRITTEN = 'hand';

export const DEFAULT_PROMPT = `Write a description of this note for an AI agent deciding whether to read it.

One or two plain sentences, at most 40 words. Say what the note is about and what it holds (decisions, lists, plans, code, references). No preamble, no quotes, no markdown, and don't start with "This note".

Title: {{title}}
Tags: {{tags}}
Folder: {{folder}}

{{body}}`;

/** The prompt's tokens, in the order Settings offers them. */
export const PROMPT_TOKENS = [
  'title',
  'body',
  'tags',
  'folder',
  'notebook',
  'description',
  'date',
] as const;
export type PromptToken = (typeof PROMPT_TOKENS)[number];

export function parseAiSetting(value: unknown): AiSetting {
  return value === 'on' || value === 'off' ? value : 'inherit';
}

/** Where an effective value came from. */
export type AiSource =
  | { readonly level: 'note' }
  | { readonly level: 'folder'; readonly id: string; readonly name: string }
  | { readonly level: 'notebook'; readonly name: string }
  | { readonly level: 'global' };

export interface AiEffective {
  readonly on: boolean;
  readonly source: AiSource;
}

export interface AiLevels {
  readonly note: AiSetting;
  /** The note's folder first, then each folder above it, up to the top level. */
  readonly folders: readonly {
    readonly id: string;
    readonly name: string;
    readonly value: AiSetting;
  }[];
  readonly notebook: { readonly name: string; readonly value: AiSetting };
  readonly global: boolean;
}

/** The closest value that is not Inherit (AD5); the global On or Off when every level inherits. */
export function resolveAiDescription(levels: AiLevels): AiEffective {
  if (levels.note !== 'inherit') return { on: levels.note === 'on', source: { level: 'note' } };
  for (const folder of levels.folders) {
    if (folder.value !== 'inherit') {
      return {
        on: folder.value === 'on',
        source: { level: 'folder', id: folder.id, name: folder.name },
      };
    }
  }
  if (levels.notebook.value !== 'inherit') {
    return {
      on: levels.notebook.value === 'on',
      source: { level: 'notebook', name: levels.notebook.name },
    };
  }
  return { on: levels.global, source: { level: 'global' } };
}

/**
 * A note's folder and the folders above it, closest first, as `resolveAiDescription` reads them
 * (by the tree every client shows, so a cycle resolves the same way everywhere).
 */
export function folderLevels(
  folders: readonly FolderRecord[],
  folderId: string | null,
): AiLevels['folders'] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const parents = effectiveParents(folders);
  const out: { id: string; name: string; value: AiSetting }[] = [];
  const seen = new Set<string>();
  for (let id = folderId; id !== null && !seen.has(id); id = parents.get(id) ?? null) {
    seen.add(id);
    const folder = byId.get(id);
    if (!folder) break;
    out.push({ id, name: folder.name, value: parseAiSetting(folder.aiDescription) });
  }
  return out;
}

/** The global value: On only for `true`. */
export function aiGlobalOf(settings: Settings): boolean {
  return settings[AI_DESCRIPTION_GLOBAL_SETTING] === true;
}

export function describeWhenOf(settings: Settings): DescribeWhen {
  return settings[AI_DESCRIPTION_WHEN_SETTING] === 'sync' ? 'sync' : 'pause';
}

export function pauseSecondsOf(settings: Settings): number {
  const value = settings[AI_DESCRIPTION_PAUSE_SETTING];
  return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 3600
    ? value
    : DEFAULT_PAUSE_SECONDS;
}

export function aiProviderOf(settings: Settings): AiProviderId {
  const value = settings[AI_PROVIDER_SETTING];
  return AI_PROVIDER_IDS.includes(value as AiProviderId) ? (value as AiProviderId) : 'none';
}

/** The models a provider offers (none for `none`). */
export function modelsOf(provider: AiProviderId): readonly { id: string; label: string }[] {
  if (provider === 'anthropic') return ANTHROPIC_MODELS;
  if (provider === 'claude-code') return CLAUDE_CODE_MODELS;
  return [];
}

/** The model to use with `provider`: the setting when that provider offers it, else its fastest. */
export function modelOf(settings: Settings, provider: AiProviderId): string | null {
  const models = modelsOf(provider);
  const value = settings[AI_DESCRIPTION_MODEL_SETTING];
  const chosen = models.find((model) => model.id === value);
  return chosen?.id ?? models[0]?.id ?? null;
}

/** The prompt: the setting when it has text, else the default. */
export function promptOf(settings: Settings): string {
  const value = settings[AI_DESCRIPTION_PROMPT_SETTING];
  return typeof value === 'string' && value.trim() !== '' ? value : DEFAULT_PROMPT;
}

/** Why `value` cannot be stored as `key`, or null when it can (null always can: it unsets). */
export function aiDescriptionSettingProblem(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (key) {
    case AI_DESCRIPTION_GLOBAL_SETTING:
      return typeof value === 'boolean' ? null : `${key} must be true or false`;
    case AI_DESCRIPTION_NOTEBOOK_SETTING:
      return value === 'on' || value === 'off' ? null : `${key} must be on or off`;
    case AI_DESCRIPTION_WHEN_SETTING:
      return value === 'pause' || value === 'sync' ? null : `${key} must be pause or sync`;
    case AI_DESCRIPTION_PAUSE_SETTING:
      return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 3600
        ? null
        : `${key} must be a whole number of seconds from 5 to 3600`;
    case AI_DESCRIPTION_MODEL_SETTING:
      return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value)
        ? null
        : `${key} must be a model id`;
    case AI_DESCRIPTION_PROMPT_SETTING:
    case AI_TAG_PROMPT_SETTING:
      return typeof value === 'string' && value.length <= 20_000
        ? null
        : `${key} must be text of at most 20,000 characters`;
    case AI_PROVIDER_SETTING:
      return AI_PROVIDER_IDS.includes(value as AiProviderId)
        ? null
        : `${key} must be one of ${AI_PROVIDER_IDS.join(', ')}`;
    default:
      return `${key} is not an AI Descriptions setting`;
  }
}

/** Whether a prompt names the note's body (Settings warns when it does not). */
export const promptHasBody = (prompt: string): boolean => /\{\{\s*body\s*\}\}/.test(prompt);

export type PromptValues = Readonly<Record<PromptToken, string>>;

/** The prompt with its tokens filled in; unknown tokens stay as typed, as templates do (A78). */
export function renderPrompt(prompt: string, values: PromptValues): string {
  return prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name as PromptToken] : whole,
  );
}

/**
 * The body as sent (AD9): whole when it fits the limit, else its start and its end with a marker
 * where text was left out. Counted at about four characters a token.
 */
export function cutForPrompt(body: string, tokenLimit: number = PROMPT_TOKEN_LIMIT): string {
  const limit = tokenLimit * CHARS_PER_TOKEN;
  if (body.length <= limit) return body;
  const marker = '\n\n[… the middle of this note was left out …]\n\n';
  const keep = Math.max(0, limit - marker.length);
  const head = Math.ceil(keep * 0.7);
  return body.slice(0, head) + marker + body.slice(body.length - (keep - head));
}

/**
 * The stamp of the text a description describes (AD6): the title, the tags and the body, never
 * the frontmatter, so writing the description never looks like a change to describe. Two
 * 32-bit FNV-1a hashes, as hex: the same on every device and in every runtime.
 */
export function describedTextHash(title: string, tags: readonly string[], body: string): string {
  const text = `${title}\u0000${[...tags].sort().join(' ')}\u0000${body}`;
  return (
    fnv(text, 0x811c9dc5).toString(16).padStart(8, '0') +
    fnv(text, 0x01000193).toString(16).padStart(8, '0')
  );
}

function fnv(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A model's answer as a description: one paragraph of plain text, without wrapping quotes or a
 * leading label, cut to DESCRIPTION_MAX_CHARS at a word. Null when nothing is left.
 */
export function cleanDescription(answer: string): string | null {
  let text = answer.replace(/\s+/g, ' ').trim();
  text = text.replace(/^(description|summary)\s*:\s*/i, '');
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (text === '') return null;
  if (text.length > DESCRIPTION_MAX_CHARS) {
    const cut = text.slice(0, DESCRIPTION_MAX_CHARS);
    const space = cut.lastIndexOf(' ');
    text = `${(space > DESCRIPTION_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return text;
}

/** A description as an agent's list shows it: one line, at most `max` characters. */
export function descriptionLine(description: string, max = 240): string {
  const line = description.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// --- Tag descriptions (A1677) ---

export const DEFAULT_TAG_PROMPT = `Write a description of a tag for an AI agent choosing tags for a note, or looking for the notes a tag finds.

One or two plain sentences, at most 40 words. Say what the notes with this tag have in common and what the tag is for, beside the other tags they carry. No preamble, no quotes, no markdown, and don't start with "This tag".

Tag: #{{tag}}
Notebook: {{notebook}}
Notes with it: {{count}}
Other tags on these notes: {{tags}}

{{notes}}`;

/** The tag prompt's tokens, in the order Settings offers them. */
export const TAG_PROMPT_TOKENS = [
  'tag',
  'notes',
  'tags',
  'count',
  'notebook',
  'description',
  'date',
] as const;
export type TagPromptToken = (typeof TAG_PROMPT_TOKENS)[number];
export type TagPromptValues = Readonly<Record<TagPromptToken, string>>;

/** The notes listed in a tag's prompt are cut to about this many tokens, newest first. */
export const TAG_PROMPT_TOKEN_LIMIT = 8_000;
/** At most this many notes are listed, newest first; the count and the tags cover them all. */
export const TAG_PROMPT_MAX_NOTES = 100;
/** Each note's description or the start of its text, cut to this many characters. */
export const TAG_NOTE_CHARS = 160;
/** At most this many other tags are named, most used first. */
export const TAG_PROMPT_MAX_TAGS = 60;

/** The tag prompt: the setting when it has text, else the default. */
export function tagPromptOf(settings: Settings): string {
  const value = settings[AI_TAG_PROMPT_SETTING];
  return typeof value === 'string' && value.trim() !== '' ? value : DEFAULT_TAG_PROMPT;
}

/** Whether a tag prompt names the notes (Settings warns when it does not). */
export const promptHasNotes = (prompt: string): boolean => /\{\{\s*notes\s*\}\}/.test(prompt);

/** One note as a tag's prompt sees it. */
export interface TagPromptNote {
  readonly title: string;
  /** Its tags (frontmatter and inline), as stored. */
  readonly tags: readonly string[];
  /** Its description, when it has one: said instead of its text. */
  readonly description?: string | null;
  /** Its text, or the start of it. */
  readonly text?: string;
}

export interface TagPromptInput {
  /** The tag, as stored (`project/penmoss`). */
  readonly tag: string;
  /** The notebook's notes, newest first; those carrying the tag (or one nested under it) count. */
  readonly notes: readonly TagPromptNote[];
  readonly notebook: string;
  /** The tag's description now, if any. */
  readonly description?: string | null;
  /** Today, `YYYY-MM-DD`. */
  readonly date: string;
  /** The notes' budget, in tokens (about four characters each). */
  readonly tokenLimit?: number;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The values of a tag prompt's tokens: the tag, how many notes carry it (it or a tag nested
 * under it, as the Tags page counts), one line per note (its title, then its description or the
 * start of its text; newest first, at most TAG_PROMPT_MAX_NOTES and the token budget, then how
 * many more), and the other tags on those notes with how many carry each (most first).
 */
export function tagPromptValues(input: TagPromptInput): TagPromptValues {
  const carrying = input.notes.filter((note) =>
    note.tags.some((each) => tagMatches(each, input.tag)),
  );
  const counts = new Map<string, number>();
  for (const note of carrying) {
    for (const tag of new Set(note.tags)) {
      if (tag !== input.tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const others = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const named = others.slice(0, TAG_PROMPT_MAX_TAGS).map(([tag, n]) => `#${tag} (${n})`);
  const tags =
    named.length === 0
      ? 'none'
      : named.join(', ') +
        (others.length > named.length ? `, and ${others.length - named.length} more` : '');
  const budget = (input.tokenLimit ?? TAG_PROMPT_TOKEN_LIMIT) * CHARS_PER_TOKEN;
  const lines: string[] = [];
  let used = 0;
  for (const note of carrying) {
    if (lines.length >= TAG_PROMPT_MAX_NOTES) break;
    const title = oneLine(note.title) || 'Untitled';
    const about = oneLine(note.description?.trim() ? note.description : (note.text ?? ''));
    const cut = about.length > TAG_NOTE_CHARS ? `${about.slice(0, TAG_NOTE_CHARS)}…` : about;
    const line = cut ? `- ${title}: ${cut}` : `- ${title}`;
    if (used + line.length + 1 > budget && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  const left = carrying.length - lines.length;
  if (left > 0) lines.push(`- … and ${left} more ${left === 1 ? 'note' : 'notes'}`);
  return {
    tag: input.tag,
    notes: lines.length > 0 ? lines.join('\n') : 'No notes carry it now.',
    tags,
    count: String(carrying.length),
    notebook: input.notebook,
    description: input.description?.trim() ?? '',
    date: input.date,
  };
}

/** The tag prompt with its tokens filled in; unknown tokens stay as typed (A78). */
export function renderTagPrompt(prompt: string, values: TagPromptValues): string {
  return prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name as TagPromptToken] : whole,
  );
}

/** The prompt sent for one tag (`prompt` is the setting's, or the default). */
export function tagPrompt(prompt: string, input: TagPromptInput): string {
  return renderTagPrompt(prompt, tagPromptValues(input));
}

/**
 * The tags Generate All writes a description for, by name: every tag and level the notes carry
 * (as the Tags page lists them), without those described already unless `replace`.
 */
export function tagsToDescribe(
  notes: Iterable<readonly string[]>,
  descriptions: Readonly<Record<string, string>>,
  replace: boolean,
): string[] {
  return describeTags(notes, descriptions)
    .filter((tag) => replace || tag.description === null)
    .map((tag) => tag.name);
}

/**
 * The words the Mac and Android say about descriptions (A1677), kept once here and exported to
 * Android in `apps/android/contract/ai-descriptions-v1.json` (A1646): each prompt's warning
 * without the token that carries the text, Generate All's confirmation, and Choose an AI
 * Provider's body. A `{count}` is filled in by the client.
 */
export const AI_DESCRIPTION_COPY = {
  'notePrompt.missing': 'This prompt has no {{body}} token, so Claude won’t see the note’s text.',
  'tagPrompt.missing': 'This prompt has no {{notes}} token, so Claude won’t see the tag’s notes.',
  'generateAll.none': 'There are no tags to describe.',
  'generateAll.allDescribed': 'Every tag has a description already.',
  'generateAll.replace.one': '1 tag will be described, replacing any description they have.',
  'generateAll.replace.many':
    '{count} tags will be described, replacing any description they have.',
  'generateAll.missing.one': '1 tag has no description.',
  'generateAll.missing.many': '{count} tags have no description.',
  'generateAll.each':
    'Each goes to your AI provider with its notes’ titles and descriptions, two at a time.',
  'chooseProvider.body':
    'Generating a description sends the tag’s notes to your AI provider. Choose one in Settings → AI Descriptions first.',
} as const;

/**
 * What Generate All says it covers before anything is sent (A1677): how many tags, and that each
 * goes to the AI provider; with none, why not.
 */
export function generateAllTagsWords(count: number, replace: boolean): string {
  const copy = AI_DESCRIPTION_COPY;
  if (count === 0) return replace ? copy['generateAll.none'] : copy['generateAll.allDescribed'];
  const lead = replace
    ? count === 1
      ? copy['generateAll.replace.one']
      : copy['generateAll.replace.many']
    : count === 1
      ? copy['generateAll.missing.one']
      : copy['generateAll.missing.many'];
  return `${lead.replace('{count}', String(count))} ${copy['generateAll.each']}`;
}
