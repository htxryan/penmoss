/**
 * Title Case, as Penmoss writes it (A938, amended by PEN-137, N16–N18): every title, button,
 * switch or row label, tab, legend, section heading, field label, dialog title (confirmation
 * questions included) and state name. Articles, conjunctions and short prepositions stay lower
 * case unless they come first or last, or follow a colon ("Move to Folder", "Search by Meaning",
 * "Keep at Most"); a verb's particle is capitalised ("Sign In with GitHub"). Words that are code
 * or a name written its own way (penmoss, MCP, GitHub, ⌘K) keep their spelling. Only full
 * sentences, hints and body copy stay in sentence case.
 *
 * The Mac's and the web's checks (`settings-title-case.spec.ts`, `confirm-title-case.test.ts`)
 * and the analytics copy test use this; Android's `TitleCase.kt` follows the same rule.
 */

/** Words kept lower case in the middle of a title. */
export const SHORT_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'nor',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'per',
  'to',
  'with',
]);

/** Verbs whose particle is capitalised: "Sign In", "Turn Off", "Back Up". */
const PARTICLE_VERBS: ReadonlySet<string> = new Set([
  'sign',
  'signed',
  'log',
  'logged',
  'turn',
  'turned',
  'set',
  'back',
  'opt',
  'check',
  'zoom',
]);
const PARTICLES: ReadonlySet<string> = new Set(['in', 'on', 'off', 'up', 'out']);

/** A word written its own way: code, a command, a name with inner capitals, a shortcut. */
function keepsSpelling(raw: string): boolean {
  const word = raw.replace(/^[(“"‘'[]+/u, '');
  return (
    /^[^\p{L}]/u.test(word) || // a number, a symbol (⌘K, ~/.codex), a placeholder ({device}, $x)
    /\p{Lu}/u.test(word.slice(1)) || // GitHub, macOS, MCP, iOS
    /[./_~]/.test(word.replace(/[.…:,;!?)]+$/, '')) || // config.toml, ~/.penmoss
    word === 'penmoss' ||
    word === 'iOS' ||
    word === 'macOS' ||
    word === 'npm' ||
    word === 'git' ||
    word === 'pnpm'
  );
}

function capitalise(word: string): string {
  // Each part of a hyphenated word: "Sans-Serif", "To-Do", "Wi-Fi".
  return word
    .split('-')
    .map((part) => {
      const lead = /^[^\p{L}]*/u.exec(part)![0];
      const rest = part.slice(lead.length);
      return rest ? lead + rest[0]!.toUpperCase() + rest.slice(1) : part;
    })
    .join('-');
}

function bare(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
}

/** `text` in Title Case. */
export function titleCase(text: string): string {
  const words = text.split(/(\s+)/);
  const indices = words.flatMap((word, index) => (/\S/.test(word) ? [index] : []));
  const first = indices[0];
  const last = indices.at(-1);
  return words
    .map((word, index) => {
      if (!/\S/.test(word)) return word;
      if (keepsSpelling(word)) return word;
      const position = indices.indexOf(index);
      const before = position > 0 ? words[indices[position - 1]!]! : '';
      const afterColon = /[:—–]$/.test(before) || before === '—' || before === '–';
      const key = bare(word);
      const isShort =
        SHORT_WORDS.has(key) && /^[\p{L}]+[.…:,;!?)]*$/u.test(word.replace(/^[“"(]/, ''));
      const particle = PARTICLES.has(key) && PARTICLE_VERBS.has(bare(before));
      if (isShort && index !== first && index !== last && !afterColon && !particle) {
        return word.toLowerCase();
      }
      return capitalise(word);
    })
    .join('');
}

/** Whether `text` is in Title Case by the rule above. */
export function isTitleCase(text: string): boolean {
  return titleCase(text) === text;
}

/** Why `text` is not in Title Case: the first word that breaks the rule, or null. */
export function titleCaseProblem(text: string): string | null {
  const want = titleCase(text);
  if (want === text) return null;
  const have = text.split(/\s+/);
  const should = want.split(/\s+/);
  const index = have.findIndex((word, i) => word !== should[i]);
  return `"${have[index]}" should be "${should[index]}" in "${text}"`;
}

// Re-exported for the checks that read a word's case.
