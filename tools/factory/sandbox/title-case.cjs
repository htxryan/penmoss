'use strict';
/**
 * The app's Title Case (A938, as Ryan applies it): every word capitalised but short articles,
 * conjunctions and prepositions, which stay lower case unless first or last ("Move to Folder",
 * "Keep at Most", "Attach Logs from the Last", "Sign In with GitHub"). A capitalised short word
 * is never wrong, since a verb's particle is capitalised ("Sign In Again", "Back Up Now"), so only
 * a lower-case word that should be capitalised is reported, and "Id" for "ID".
 *
 * Plain CommonJS with no dependencies: the host requires it to check the planning session's
 * mockups (design-check.ts), and the validator's Playwright tests require it, through
 * ui-audit.cjs, inside the gate's sandbox.
 */

/** Words that stay lower case inside a title. */
const MINOR = new Set(
  (
    'a an the and but or nor for so yet as at by in of off on per to up via vs from into onto ' +
    'with over than out'
  ).split(' '),
);

/** Lower-case words that are names, not prose: kept as written. */
const NAMES = new Set([
  'penmoss',
  'iOS',
  'macOS',
  'npm',
  'pnpm',
  'git',
  'gh',
  'adb',
  'e.g.',
  'i.e.',
]);

/**
 * Whether a label is a title, and so should be in Title Case: short, and not a sentence. A
 * label that ends in a full stop, a colon or a semicolon, or that has more than nine words, is
 * prose, which stays in sentence case.
 */
function isTitleLike(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length < 2 || !/[A-Za-z]/.test(t)) return false;
  if (/[.:;]$/.test(t) && !/\.\.\.$|…$/.test(t)) return false;
  if (/[.!?]\s+\S/.test(t)) return false;
  return t.split(' ').length <= 9;
}

/** Splits a title into its words, keeping what isn't one (numbers, code, paths) out. */
function words(text) {
  return String(text)
    .replace(/[“”"()[\]{}]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[‘'¿¡]+|[’'?!,…]+$|\.{3}$/g, ''))
    .filter(Boolean);
}

/** A word that isn't prose: has a digit, a symbol inside it, or is a code name. */
function isCode(word) {
  return (
    /\d/.test(word) ||
    /[#@/\\~_=<>`$%&*+|]/.test(word) ||
    /\.\w/.test(word) ||
    NAMES.has(word) ||
    // camelCase or a lower-case word with capitals inside it (iPhone, gitNotebook).
    /^[a-z]+[A-Z]/.test(word)
  );
}

/**
 * The problem with a title's casing, or null. `text` is a label as the person reads it. The
 * fixed form is given, so a finding says what to write.
 */
function titleCaseProblem(text) {
  if (!isTitleLike(text)) return null;
  const all = words(text);
  if (all.length === 0) return null;
  const wrong = [];
  const fixed = String(text).replace(/\s+/g, ' ').trim();
  let suggestion = fixed;
  // A short word before an ellipsis stays lower case ("Move to…", "Send to…").
  const trailing = /(?:…|\.\.\.)$/.test(fixed);
  all.forEach((word, i) => {
    if (isCode(word)) return;
    const parts = word.split('-');
    parts.forEach((part, j) => {
      if (!part || !/^[A-Za-z]/.test(part)) return;
      const edge =
        (i === 0 && j === 0) || (!trailing && i === all.length - 1 && j === parts.length - 1);
      if (part === 'Id' || part === 'id') {
        wrong.push(part);
        suggestion = suggestion.replace(new RegExp(`\\b${part}\\b`), 'ID');
        return;
      }
      const lower = part[0] === part[0].toLowerCase();
      if (!lower) return;
      if (!edge && MINOR.has(part.toLowerCase())) return;
      wrong.push(part);
      suggestion = suggestion.replace(
        new RegExp(`(^|[^A-Za-z])${part}(?![A-Za-z])`),
        (_m, pre) => `${pre}${part[0].toUpperCase()}${part.slice(1)}`,
      );
    });
  });
  if (wrong.length === 0) return null;
  return { text: fixed, words: wrong, suggestion };
}

module.exports = { titleCaseProblem, isTitleLike, MINOR };
