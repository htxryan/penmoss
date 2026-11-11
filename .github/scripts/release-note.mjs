#!/usr/bin/env node
// The pull request's Release note (PEN-104, A1294): the one source of Penmoss's release notes,
// read here, by the factory and by the release jobs. A section `## Release note` in the PR body
// holds one line per user-facing change, `New|Improved|Fixed[ (Mac|Android)]: A sentence.`, or
// `none` for a change nobody using Penmoss would notice.
//
// Run by .github/workflows/release-note.yml on a pull request: reads the event from
// GITHUB_EVENT_PATH (the body is never passed through the shell), writes what it found to
// GITHUB_STEP_SUMMARY, and exits 1 when the section needs a fix.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @typedef {'new' | 'improved' | 'fixed'} Kind */
/** @typedef {'mac' | 'android'} Platform */
/** @typedef {{ kind: Kind, platform: Platform | null, text: string }} Note */
/** @typedef {{ ok: boolean, none: boolean, notes: Note[], errors: string[] }} ReleaseNote */

export const KINDS = /** @type {const} */ (['new', 'improved', 'fixed']);
export const PLATFORMS = /** @type {const} */ (['mac', 'android']);
/** Longer than this and it is a paragraph, not a note. */
export const MAX_NOTE = 200;

const HEADING = /^#{2,3}[ \t]+release[ \t]+notes?[ \t]*$/im;
const NEXT_HEADING = /^#{1,6}[ \t]/m;
const NOTE = /^([a-z]+)(?:[ \t]*\(([^)]*)\))?[ \t]*:[ \t]*(.*)$/i;
const NONE = /^`?none`?\.?$/i;

const FORMAT =
  'Write one line per user-facing change, such as `New: Settings → Updates shows what changed in each version.` or `Fixed (Android): The keyboard no longer hides the last line.`, or `none` for a change nobody using Penmoss would notice.';

const label = (/** @type {string} */ word) => word.charAt(0).toUpperCase() + word.slice(1);

/** @param {string} line @param {number} n */
const quote = (line, n) => `Line ${n} ("${line.length > 60 ? `${line.slice(0, 57)}…` : line}")`;

/**
 * Reads the Release note section of a pull request's body.
 * @param {string | null | undefined} body
 * @returns {ReleaseNote}
 */
export function parseReleaseNote(body) {
  const text = (body ?? '').replace(/\r\n?/g, '\n');
  const heading = HEADING.exec(text);
  if (!heading) {
    return fail([`The pull request has no "## Release note" section. ${FORMAT}`]);
  }
  const rest = text.slice(heading.index + heading[0].length);
  const end = NEXT_HEADING.exec(rest);
  const lines = (end ? rest.slice(0, end.index) : rest)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split('\n')
    .map((line) => line.trim().replace(/^[-*+][ \t]+/, ''))
    .filter(Boolean);
  if (lines.length === 0) {
    return fail([`The "## Release note" section is empty: write a note, or \`none\`. ${FORMAT}`]);
  }
  if (lines.some((line) => NONE.test(line))) {
    return lines.length === 1
      ? { ok: true, none: true, notes: [], errors: [] }
      : fail(['`none` stands alone: remove it, or remove the notes beside it.']);
  }
  /** @type {Note[]} */
  const notes = [];
  /** @type {string[]} */
  const errors = [];
  lines.forEach((line, i) => {
    const result = parseLine(line);
    if (typeof result === 'string') errors.push(`${quote(line, i + 1)}: ${result}`);
    else notes.push(result);
  });
  return errors.length ? fail(errors) : { ok: true, none: false, notes, errors: [] };
}

/** @param {string} line @returns {Note | string} a note, or what is wrong with the line */
function parseLine(line) {
  const match = NOTE.exec(line);
  const kind = match?.[1]?.toLowerCase();
  if (!match || !KINDS.includes(/** @type {Kind} */ (kind))) {
    return 'start with New, Improved or Fixed and a colon, such as "Fixed: …".';
  }
  const platform = match[2]?.trim().toLowerCase() || null;
  if (match[2] !== undefined && !PLATFORMS.includes(/** @type {Platform} */ (platform))) {
    return 'a platform is (Mac) or (Android); leave it out when the change is everywhere.';
  }
  const sentence = match[3]?.trim() ?? '';
  if (!/[\p{L}\p{N}]/u.test(sentence)) return 'write a sentence after the colon.';
  if (!sentence.endsWith('.')) return 'end with a full stop.';
  if (sentence.length > MAX_NOTE) {
    return `keep it to ${MAX_NOTE} characters or fewer (this one is ${sentence.length}).`;
  }
  return {
    kind: /** @type {Kind} */ (kind),
    platform: /** @type {Platform | null} */ (platform),
    text: sentence,
  };
}

/** A workflow command's message, escaped as GitHub's toolkit does. @param {string} text */
const escapeCommand = (text) =>
  text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

/** @param {string[]} errors @returns {ReleaseNote} */
const fail = (errors) => ({ ok: false, none: false, notes: [], errors });

/** A note as people write it: `Fixed (Mac): The window keeps its size.` @param {Note} note */
export const formatNote = (note) =>
  `${label(note.kind)}${note.platform ? ` (${note.platform === 'mac' ? 'Mac' : 'Android'})` : ''}: ${note.text}`;

/** The job summary for a parsed section, in Markdown. @param {ReleaseNote} result */
export function summary(result) {
  if (result.ok && result.none) {
    return '### Release note: OK\n\n`none`: no user-facing change, so no release note.\n';
  }
  if (result.ok) {
    return `### Release note: OK\n\n${result.notes.map((note) => `- ${formatNote(note)}`).join('\n')}\n`;
  }
  return [
    '### Release note: needs a fix',
    '',
    ...result.errors.map((error) => `- ${error}`),
    '',
    'The section, in the pull request description:',
    '',
    '```markdown',
    '## Release note',
    '',
    'New: Settings → Updates shows what changed in each version.',
    'Fixed (Android): The keyboard no longer hides the last line.',
    '```',
    '',
    'Each line is New, Improved or Fixed, then (Mac) or (Android) if the change is only there, a colon and one sentence ending in a full stop. Write `none` for a change nobody using Penmoss would notice (CI, tests, contributor docs, the factory). Edit the description and this check runs again.',
    '',
  ].join('\n');
}

/**
 * Checks the pull request in GitHub's event file and writes the job summary.
 * @param {Record<string, string | undefined>} env
 * @returns {boolean} whether the section is good
 */
export function checkEvent(env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set');
  /** @type {{ pull_request?: { body?: string | null } }} */
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  if (!event.pull_request) throw new Error('not a pull_request event');
  const result = parseReleaseNote(event.pull_request.body);
  const text = summary(result);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  console.log(text);
  for (const error of result.errors)
    console.log(`::error title=Release note::${escapeCommand(error)}`);
  return result.ok;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (!checkEvent(process.env)) process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
