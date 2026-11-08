import type { Parent, Text } from 'mdast';
import type { Handle, Info, Options, State } from 'mdast-util-to-markdown';
import { classifyCharacter } from 'micromark-util-classify-character';

/**
 * mdast-util-to-markdown escapes conservatively. These rules remove escapes
 * that can never change how the text parses, so ordinary prose (`#tag` at the
 * start of a line, `AT&T`, `~5 min`) stays as written. Each rule is checked by
 * the fixture and property tests.
 */
const UNESCAPES: [RegExp, string][] = [
  // `#tag` at a line start cannot be an ATX heading: headings need a space after the #s.
  [/(^|\n)\\#(?=#*[^\s#\\])/g, '$1#'],
  // `&` only matters when it starts a character reference (`&name;`, `&#123;`).
  // `(?<!\\)(\\\\)*` keeps escaped backslashes (`\\&` is a backslash then `&`).
  [/(?<!\\)((?:\\\\)*)\\&(?![#A-Za-z0-9]*;)/g, '$1&'],
  // A single `~` cannot strike through (`~~` is required).
  [/(?<![~\\])\\~(?!~|\\~)/g, '~'],
];

/** Whether the character at `index` is preceded by an odd number of backslashes. */
function isEscaped(value: string, index: number): boolean {
  let count = 0;
  while (index - count - 1 >= 0 && value[index - count - 1] === '\\') count++;
  return count % 2 === 1;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/**
 * Escapes text like the default handler, except that a literal backslash is
 * written as `\\` when the character after it is whitespace or the text's last
 * character. to-markdown sometimes writes those characters as references
 * (`&#x20;`, or `&#x61;` beside emphasis), and a bare backslash would then
 * escape the `&`.
 */
function safeText(value: string, state: State, info: Info): string {
  let out = '';
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '\\') continue;
    const rest = value.slice(index + 1);
    const next = rest[0];
    if (next === undefined || ASCII_PUNCTUATION.test(next)) continue;
    if (!/\s/.test(next) && [...rest].length !== 1) continue;
    out += state.safe(value.slice(start, index), {
      ...info,
      before: out ? out.slice(-1) : info.before,
      after: '\\',
    });
    out += '\\\\';
    start = index + 1;
  }
  return (
    out + state.safe(value.slice(start), { ...info, before: out ? out.slice(-1) : info.before })
  );
}

/** Nodes that to-markdown writes as delimiter runs (`attention` handlers). */
const ATTENTION = new Set(['emphasis', 'strong', 'delete', 'highlight']);

const reference = (character: string) =>
  `&#x${character.codePointAt(0)!.toString(16).toUpperCase()};`;
const isWhitespace = (character: string | undefined) =>
  character !== undefined && classifyCharacter(character.codePointAt(0)!) === 1;

/**
 * to-markdown writes whitespace at the inner edge of a delimiter run as a
 * character reference (`==&#x20;a==`), but only after the text handler has
 * run, so `=` beside it would be escaped for the wrong neighbour
 * (`==&#x20;== a==` closes after the `;`). The reference is written here
 * instead, in the same form, and the rest of the text is escaped next to it.
 */
const handleText: Handle = (node: Text, parent, state, info) => {
  const siblings = parent && ATTENTION.has(parent.type) ? (parent as Parent).children : [];
  let body = node.value;
  let head = '';
  let tail = '';
  if (siblings[0] === node && isWhitespace(body[0])) {
    head = reference(body[0]!);
    body = body.slice(1);
  }
  if (siblings[siblings.length - 1] === node && isWhitespace(body[body.length - 1])) {
    tail = reference(body[body.length - 1]!);
    body = body.slice(0, -1);
  }
  if (!body) return head + tail;
  const escaped = escapeText(body, node, state, {
    ...info,
    before: head ? ';' : info.before,
    after: tail ? '&' : info.after,
  });
  return head + escaped + tail;
};

function escapeText(text: string, node: Text, state: State, info: Info): string {
  const before = info.before.slice(-1);
  const after = info.after.slice(0, 1);
  let value = `${before}${safeText(text, state, info)}${after}`;
  for (const [pattern, replacement] of UNESCAPES) value = value.replace(pattern, replacement);
  value = value.slice(before.length, value.length - after.length);
  // A `=` touching a neighbour's `==` would lengthen that run and break the highlight.
  // Every `=` in that run is escaped: a bare `==` left beside an escaped `=` could open or close.
  if (before === '=' && value.startsWith('=')) {
    const run = /^=+/.exec(value)![0].length;
    value = '\\='.repeat(run) + value.slice(run);
  }
  if (after === '=') {
    let start = value.length;
    while (start > 0 && value[start - 1] === '=' && !isEscaped(value, start - 1)) start--;
    value = value.slice(0, start) + '\\='.repeat(value.length - start);
  }
  return escapeOpenAutolink(escapeAsWritten(value, before, after), node);
}

const EMAIL_LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@/;

/**
 * The escapes above are chosen from the raw text, but the parser reads what is
 * written, which can differ: to-markdown writes some whitespace as character
 * references (`==&#xA;` can open after all), skips an escape when it escapes the
 * next character (`<\~@a>`, whose `\~` UNESCAPES then removes), and leaves a
 * bare `==` beside an escaped `=` (`a\=== b` closes after `a=`). This pass
 * checks the written text: a bare `==` that can still open or close gets its
 * first `=` escaped, and so does a `<` that still starts an email autolink.
 */
function escapeAsWritten(value: string, before: string, after: string): string {
  // Tokens are escapes (`\x`) or single characters, so `\\=` is a backslash then a bare `=`.
  const tokens = value.match(/\\[\s\S]|[\s\S]/gu) ?? [];
  const lastCode = (token: string | undefined, fallback: string) =>
    [...(token ?? fallback)].pop()?.codePointAt(0) ?? null;
  const firstCode = (token: string | undefined, fallback: string) =>
    (token ?? fallback).codePointAt(0) ?? null;
  let offset = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '<' && EMAIL_LOCAL_PART.test(value.slice(offset + 1) + after)) {
      tokens[index] = '\\<';
    } else if (token === '=') {
      let end = index;
      while (tokens[end] === '=') end++;
      const touches = (index === 0 && before === '=') || (end === tokens.length && after === '=');
      if (end - index === 2 && !touches) {
        const previous = classifyCharacter(lastCode(tokens[index - 1], before));
        const next = classifyCharacter(firstCode(tokens[end], after));
        const open = !next || (next === 2 && Boolean(previous));
        const close = !previous || (previous === 2 && Boolean(next));
        if (open || close) tokens[index] = '\\=';
      }
      offset += end - index;
      index = end - 1;
      continue;
    }
    offset += token.length;
  }
  return tokens.join('');
}

/** Set on a text node whose last `<` must be escaped (`flagOpenAutolinks` in serialize.ts). */
export const ESCAPE_OPEN_AUTOLINK = 'penmossEscapeOpenAutolink';

/**
 * Escapes the last `<` when the serialiser flagged it (`flagOpenAutolinks`):
 * it would open an email autolink running on into the next spans.
 */
function escapeOpenAutolink(value: string, node: Text): string {
  const data = node.data as Record<string, unknown> | undefined;
  if (!data?.[ESCAPE_OPEN_AUTOLINK]) return value;
  const open = value.lastIndexOf('<');
  if (open === -1 || isEscaped(value, open)) return value;
  return `${value.slice(0, open)}\\${value.slice(open)}`;
}

export function textEscapingToMarkdown(): Options {
  return {
    handlers: { text: handleText },
    unsafe: [
      // `<a@b.c>` is an email autolink; core only escapes `<` before letters, `/`, `!` and `?`.
      {
        character: '<',
        inConstruct: 'phrasing',
        after: "[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@",
      },
      // mdast-util-math declares its `$` pattern with an `after` key, which lets
      // `$` go unescaped before another escaped character (`$\``). Escape every `$`.
      {
        character: '$',
        inConstruct: 'phrasing',
        notInConstruct: [
          'autolink',
          'destinationLiteral',
          'destinationRaw',
          'reference',
          'titleQuote',
          'titleApostrophe',
        ],
      },
    ],
  };
}
