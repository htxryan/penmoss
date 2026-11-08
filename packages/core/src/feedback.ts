/**
 * In-app feedback (T49, D41): what a client sends to `POST /api/feedback` and how the Worker
 * writes it into a GitHub issue. Shared by the Worker, which builds the issue, and the web and
 * Mac clients, whose form previews the captured context exactly as the issue will hold it
 * (A791, A794). The Android app renders the same markdown in Kotlin; both follow
 * `apps/android/contract/feedback-v1.json`.
 *
 * The captured context is metadata only, in six groups (A791): never a note's body text,
 * excerpts, search queries or other notes' text. Each group is a small table of strings, so the
 * Worker can check its shape and size without knowing what a client collects.
 */

/** The groups, in the order the issue lists them. */
export const FEEDBACK_GROUP_IDS = ['app', 'where', 'sync', 'note', 'edits', 'errors'] as const;
export type FeedbackGroupId = (typeof FEEDBACK_GROUP_IDS)[number];

export const FEEDBACK_GROUP_TITLES: Readonly<Record<FeedbackGroupId, string>> = {
  app: 'App',
  where: 'Where you are',
  sync: 'Sync',
  note: 'This note',
  edits: 'Recent edits to this note',
  errors: 'Recent errors',
};

/** A group of named values: two columns, one row per value. */
export const FIELD_COLUMNS: readonly string[] = ['Field', 'Value'];
/** The recent-edits table's columns (group 5). */
export const EDIT_COLUMNS: readonly string[] = ['Time', 'Actor', 'Kind', 'Change'];
/** The recent-errors table's columns (group 6). */
export const ERROR_COLUMNS: readonly string[] = ['Time', 'Message', 'Stack'];

export interface FeedbackGroup {
  readonly id: FeedbackGroupId;
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<readonly string[]>;
}

export interface FeedbackContext {
  readonly groups: readonly FeedbackGroup[];
}

export const FEEDBACK_TYPES = ['bug', 'feature'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_TYPE_LABELS: Readonly<Record<FeedbackType, string>> = {
  bug: 'Bug report',
  feature: 'Feature request',
};

export const FEEDBACK_PRIORITIES = [1, 2, 3, 4] as const;
export type FeedbackPriority = (typeof FEEDBACK_PRIORITIES)[number];

/** How the form names each priority (P1 Highest … P4 Lowest). */
export const FEEDBACK_PRIORITY_LABELS: Readonly<Record<FeedbackPriority, string>> = {
  1: 'P1 Highest',
  2: 'P2 High',
  3: 'P3 Normal',
  4: 'P4 Lowest',
};

export const FEEDBACK_CLIENTS = ['web', 'mac', 'android'] as const;
export type FeedbackClient = (typeof FEEDBACK_CLIENTS)[number];

/** How the footer names each client. */
export const FEEDBACK_CLIENT_NAMES: Readonly<Record<FeedbackClient, string>> = {
  web: 'web',
  mac: 'Mac',
  android: 'Android',
};

/** The limits every client and the Worker share (A792). */
export const FEEDBACK_LIMITS = {
  titleMax: 256,
  descriptionMax: 20_000,
  versionMax: 80,
  screenshots: 6,
  /** Each image before it is scaled down and encoded again on the device. */
  screenshotBytes: 10 * 1024 * 1024,
  /** The whole request. */
  requestBytes: 40 * 1024 * 1024,
  perHour: 20,
  /** Images are scaled down to at most this many pixels on their long side. */
  longSide: 2560,
  jpegQuality: 0.85,
  groupRows: 40,
  columns: 6,
  cell: 400,
  /** Recent edits and recent errors keep this many each. */
  recent: 10,
} as const;

/** The images GitHub takes as issue attachments, and the extension each must be named with. */
export const FEEDBACK_IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** The labels an issue gets (A794): the feedback label, its type and its priority. */
export function feedbackLabels(type: FeedbackType, priority: FeedbackPriority): string[] {
  return ['in-app feedback', type === 'bug' ? 'bug' : 'feature request', `P${priority}`];
}

/**
 * A group of named values; a value of null or undefined is left out. Each value is cut to
 * FEEDBACK_LIMITS.cell (the Worker refuses a longer cell) and the group to groupRows rows.
 */
export function fieldGroup(
  id: FeedbackGroupId,
  fields: ReadonlyArray<readonly [string, string | number | boolean | null | undefined]>,
): FeedbackGroup {
  const rows: string[][] = [];
  for (const [name, value] of fields) {
    if (value === null || value === undefined) continue;
    if (rows.length === FEEDBACK_LIMITS.groupRows) break;
    const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
    rows.push([clipCell(name), clipCell(text)]);
  }
  return { id, columns: FIELD_COLUMNS, rows };
}

/**
 * Text GitHub would turn into a mention or a cross-reference (`@ryan`, `#100`, `GH-12`) made
 * inert: a zero-width joiner after the sign. A tag named `#100` must not link pull request 100.
 */
export function inertReferences(text: string): string {
  return text
    .replace(/@(?=[\p{L}\p{N}_])/gu, '@\u200d')
    .replace(/#(?=\d)/g, '#\u200d')
    .replace(/\bGH-(?=\d)/g, 'GH\u200d-');
}

const isFieldGroup = (group: FeedbackGroup) =>
  group.columns.length === 2 &&
  group.columns[0] === FIELD_COLUMNS[0] &&
  group.columns[1] === FIELD_COLUMNS[1];

/** A table cell: one line, its pipes escaped, no HTML; a dash when empty. */
function cell(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat === '') return '—';
  return inertReferences(flat.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;'));
}

function table(columns: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [
    line(columns),
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => line(columns.map((_, index) => row[index] ?? ''))),
  ].join('\n');
}

/** The context as JSON for agents: a group of named values as an object, a table as a list. */
export function contextJson(context: FeedbackContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const group of context.groups) {
    if (isFieldGroup(group)) {
      out[group.id] = Object.fromEntries(group.rows.map((row) => [row[0] ?? '', row[1] ?? '']));
    } else {
      out[group.id] = group.rows.map((row) =>
        Object.fromEntries(group.columns.map((column, index) => [column, row[index] ?? ''])),
      );
    }
  }
  return out;
}

/** A code fence longer than any run of backticks in `text`. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The captured context as the issue holds it (A794): a `<details>` block with a table per group,
 * then a fenced JSON copy. Empty when no group is sent. The form shows exactly this (A791).
 */
export function contextMarkdown(context: FeedbackContext): string {
  if (context.groups.length === 0) return '';
  const parts = ['<details><summary>Captured context</summary>'];
  for (const group of context.groups) {
    parts.push(`#### ${FEEDBACK_GROUP_TITLES[group.id]}`);
    parts.push(group.rows.length === 0 ? '_None_' : table(group.columns, group.rows));
  }
  const json = JSON.stringify(contextJson(context), null, 2);
  const fence = fenceFor(json);
  parts.push(`${fence}json\n${json}\n${fence}`);
  parts.push('</details>');
  return parts.join('\n\n');
}

export interface FeedbackIssueInput {
  readonly description: string;
  /** Uploaded screenshots, in the form's order. */
  readonly screenshots: ReadonlyArray<{ readonly name: string; readonly url: string }>;
  readonly context: FeedbackContext;
  readonly client: FeedbackClient;
  readonly version: string;
  readonly submissionId: string;
}

/**
 * A client's version as the footer shows it: letters, digits, spaces and `. _ ( ) + : -` only,
 * one line, 80 characters at most; `unknown` when nothing is left. It is the client's word, so
 * nothing in it may format, mention or link.
 */
export function footerVersion(version: string): string {
  const safe = version
    .replace(/[^A-Za-z0-9 ._()+:-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FEEDBACK_LIMITS.versionMax)
    .trim();
  return safe || 'unknown';
}

/**
 * The issue's body (A794): the description, the screenshots, the captured context, and the
 * footer `Sent from Penmoss <client> <version> · submission <id>`.
 */
export function feedbackIssueBody(input: FeedbackIssueInput): string {
  const parts: string[] = [];
  const description = input.description.trim();
  if (description) parts.push(description);
  if (input.screenshots.length > 0) {
    parts.push(
      input.screenshots
        .map(({ name, url }) => `![${name.replace(/[[\]\n]/g, '')}](${url})`)
        .join('\n\n'),
    );
  }
  const context = contextMarkdown(input.context);
  if (context) parts.push(context);
  const version = footerVersion(input.version);
  parts.push(
    `Sent from Penmoss ${FEEDBACK_CLIENT_NAMES[input.client]} ${version} · submission ${input.submissionId}`,
  );
  return `${parts.join('\n\n')}\n`;
}

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * A context as a client sent it, checked (the Worker's side of A791): known groups once each in
 * any order, string cells within the limits. Null when anything is off. The order of the issue
 * is the order sent; the clients send FEEDBACK_GROUP_IDS' order.
 */
export function parseFeedbackContext(value: unknown): FeedbackContext | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const groups = (value as { groups?: unknown }).groups;
  if (!Array.isArray(groups) || groups.length > FEEDBACK_GROUP_IDS.length) return null;
  const seen = new Set<string>();
  const out: FeedbackGroup[] = [];
  for (const raw of groups as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { id, columns, rows } = raw as Record<string, unknown>;
    if (!isString(id) || !(FEEDBACK_GROUP_IDS as readonly string[]).includes(id) || seen.has(id)) {
      return null;
    }
    seen.add(id);
    if (!Array.isArray(columns) || columns.length < 1 || columns.length > FEEDBACK_LIMITS.columns)
      return null;
    if (!columns.every((column) => isString(column) && column.length <= 40)) return null;
    if (!Array.isArray(rows) || rows.length > FEEDBACK_LIMITS.groupRows) return null;
    const checked: string[][] = [];
    for (const row of rows as unknown[]) {
      if (!Array.isArray(row) || row.length !== columns.length) return null;
      if (!row.every((item) => isString(item) && item.length <= FEEDBACK_LIMITS.cell)) return null;
      checked.push(row as string[]);
    }
    out.push({ id: id as FeedbackGroupId, columns: columns as string[], rows: checked });
  }
  return { groups: out };
}

/** The context without the groups the person left out (the form's per-group checkboxes). */
export function withoutGroups(
  context: FeedbackContext,
  omitted: ReadonlySet<FeedbackGroupId>,
): FeedbackContext {
  return { groups: context.groups.filter((group) => !omitted.has(group.id)) };
}

/** The longest a cell may be, cut with "…" (never half a surrogate pair). */
export function clipCell(value: string, max: number = FEEDBACK_LIMITS.cell): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// --- redaction (A791: recent errors) ---

/** What a removed name or quotation becomes, as on Android (ErrorReporter.SCRUBBED). */
export const REDACTED = '‹name›';
const TOKEN = /\bpm[sda]_[A-Za-z0-9_-]{8,}/g;
const BEARER = /\bBearer\s+\S+/gi;
/** GitHub's tokens (classic, OAuth, app and fine-grained), now that a device holds one (A1010). */
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/**
 * A URL's query and fragment can hold search text or codes: any scheme's (`https:`,
 * `penmoss://`, `app://`) and a path's from the root (`/notes/…?q=…`).
 */
const URL_TAIL = /((?:\b[a-z][a-z0-9+.-]*:\/\/|(?<![\w.:/])\/)[^\s?#"'<>()]*)[?#][^\s"'<>()]*/gi;
/** The part of a JSON parse error that quotes what it could not read. */
const JSON_INPUT = /JSON input:[\s\S]*/;
/**
 * Quoted text, whatever it holds (Android's QUOTED): curly and straight double quotes, a quote
 * left open running to the end; single quotes only when closed, so an apostrophe does not eat
 * the rest.
 */
const QUOTED = /“[^”]*”?|"(?:[^"\\]|\\.)*"?|'(?:[^'\\\n]|\\.){2,}'/g;
/** Names shorter than this are not removed: "a" or "To" would eat the message. */
const MIN_NAME = 3;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An error message or stack line made safe to send (the redaction Android's error reports get,
 * A427, A791): tokens, bearer credentials, email addresses, URL queries, quoted text and every
 * note title or folder name in `names` (whole words) are removed.
 */
export function redactText(text: string, names: readonly string[] = []): string {
  let out = text
    .replace(JSON_INPUT, `JSON input: ${REDACTED}`)
    .replace(TOKEN, '[token removed]')
    .replace(BEARER, 'Bearer [token removed]')
    .replace(EMAIL, '[email removed]')
    .replace(URL_TAIL, '$1');
  const usable = [...new Set(names.map((name) => name.trim()))]
    .filter((name) => name.length >= MIN_NAME)
    .sort((a, b) => b.length - a.length);
  for (const name of usable) {
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'giu'),
      REDACTED,
    );
  }
  return out.replace(QUOTED, REDACTED);
}

/**
 * `text` with Penmoss and GitHub tokens and bearer credentials removed: the Worker's last check on
 * everything it posts to GitHub (A791), the description and title included.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(TOKEN, '[token removed]')
    .replace(GITHUB_TOKEN, '[token removed]')
    .replace(BEARER, 'Bearer [token removed]');
}

/** The context with `redactSecrets` applied to every cell. */
export function contextWithoutSecrets(context: FeedbackContext): FeedbackContext {
  return {
    groups: context.groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => row.map(redactSecrets)),
    })),
  };
}

/** How many characters of a note's text in a row count as quoting it. */
export const QUOTE_WINDOW = 24;

/**
 * Whether `text` quotes the note's text (A791: an error that does is dropped, not redacted): any
 * run of QUOTE_WINDOW characters (spaces folded) that appears in `noteText`, or a quotation of 8
 * characters or more that does.
 */
export function quotesNoteText(text: string, noteText: string): boolean {
  if (!noteText) return false;
  const fold = (value: string) => value.replace(/\s+/g, ' ').toLowerCase();
  const haystack = fold(noteText);
  const needle = fold(text);
  for (const match of needle.matchAll(/“([^”]{8,})”|"([^"]{8,})"|'([^']{8,})'/g)) {
    const quoted = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (quoted.length >= 8 && haystack.includes(quoted)) return true;
  }
  if (needle.length < QUOTE_WINDOW || haystack.length < QUOTE_WINDOW) return false;
  for (let start = 0; start + QUOTE_WINDOW <= needle.length; start += 4) {
    const window = needle.slice(start, start + QUOTE_WINDOW);
    if (window.trim().length < QUOTE_WINDOW / 2) continue;
    if (haystack.includes(window)) return true;
  }
  return false;
}
