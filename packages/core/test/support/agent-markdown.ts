import fc from 'fast-check';

/**
 * fast-check arbitraries for markdown as agents write it (A157): ordinary
 * notes with the constructs that used to fall back to raw markdown mixed in
 * (lists mixing task and plain items at any depth, ordered task lists, HTML
 * blocks, comments and `<br>`, footnotes, reference links), plus fences,
 * quotes, callouts, tables and math. Blocks are joined by one or two line
 * breaks, so lazy continuations and list/paragraph run-ins happen too.
 *
 * Shared by the codec, server and editor property tests (relative import).
 */

const word = fc.constantFrom(
  'plan',
  'Toni',
  'ship',
  'café',
  '42',
  'a_b',
  'x*y',
  '#tag',
  'v1.2',
  '✓',
  '<',
  '&',
  '|',
  '\\',
  '[',
  ']',
);

const inlinePiece = fc.oneof(
  { weight: 6, arbitrary: word },
  { weight: 1, arbitrary: word.map((w) => `**${w}**`) },
  { weight: 1, arbitrary: word.map((w) => `*${w}*`) },
  { weight: 1, arbitrary: word.map((w) => `\`${w}\``) },
  { weight: 1, arbitrary: word.map((w) => `~~${w}~~`) },
  { weight: 1, arbitrary: word.map((w) => `==${w}==`) },
  { weight: 1, arbitrary: word.map((w) => `[${w}](https://example.com/${w.length})`) },
  {
    weight: 1,
    arbitrary: fc.constantFrom('[[Garden]]', '[[Garden#Plans|the plans]]', '![[Brief]]'),
  },
  { weight: 2, arbitrary: fc.constantFrom('<br>', '<br/>', ' <br /> ', '<BR>') },
  {
    weight: 1,
    arbitrary: fc.constantFrom('<kbd>K</kbd>', '<span class="x">s</span>', '<sub>2</sub>'),
  },
  { weight: 1, arbitrary: fc.constantFrom('<!-- note -->', '[^1]', '[ref][r]', '[r]') },
  { weight: 1, arbitrary: fc.constantFrom('$x^2$', '$a|b$', '![alt](attachments/a.png)') },
  { weight: 1, arbitrary: fc.constantFrom('&amp;', '&#x20;', 'https://example.com/a_b') },
);

/** One line of inline markdown (never starting with a block marker on its own). */
export const inlineLine = fc
  .array(inlinePiece, { minLength: 1, maxLength: 7 })
  .map((pieces) => pieces.join(' '));

const MARKERS = ['- ', '- [ ] ', '- [x] ', '* ', '+ [X] ', '1. ', '2. [ ] ', '3) '];

/** A list whose items pick their marker (plain, task, ordered) and depth at random. */
const list = fc
  .array(
    fc.record({
      marker: fc.constantFrom(...MARKERS),
      depth: fc.integer({ min: 0, max: 2 }),
      text: inlineLine,
      blankBefore: fc.boolean(),
      continuation: fc.option(inlineLine, { freq: 5 }),
    }),
    { minLength: 1, maxLength: 7 },
  )
  .map((items) =>
    items
      .map((item, index) => {
        const indent = ' '.repeat(item.depth * (item.marker.match(/^\d/) ? 3 : 2));
        const blank = index > 0 && item.blankBefore ? '\n' : '';
        const more = item.continuation
          ? `\n${indent}${' '.repeat(item.marker.match(/^\d/) ? 3 : 2)}${item.continuation}`
          : '';
        return `${blank}${indent}${item.marker}${item.text}${more}`;
      })
      .join('\n'),
  );

const block = fc.oneof(
  { weight: 4, arbitrary: inlineLine },
  { weight: 4, arbitrary: list },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.integer({ min: 1, max: 6 }), inlineLine)
      .map(([level, text]) => `${'#'.repeat(level)} ${text}`),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '<div class="note">\nKept as written.\n</div>',
      '<details>\n<summary>More</summary>\n\nHidden **text**.\n\n</details>',
      '<!-- a comment for the agent -->',
      '<p align="center">\n  <img src="https://example.com/x.png">\n</p>',
      '[^1]: The footnote.',
      '[r]: https://example.com/ref "Ref"',
      '%%an Obsidian comment%%',
    ),
  },
  { weight: 1, arbitrary: inlineLine.map((text) => `> ${text}\n> - [ ] quoted task\n> - quoted`) },
  { weight: 1, arbitrary: inlineLine.map((text) => `> [!warning]- Careful\n> ${text}`) },
  { weight: 1, arbitrary: inlineLine.map((text) => `\`\`\`ts\nconst a = '${text}';\n\`\`\``) },
  { weight: 1, arbitrary: fc.constant('~~~\nraw <div>\n~~~') },
  {
    weight: 1,
    arbitrary: fc
      .tuple(inlineLine, inlineLine)
      .map(([a, b]) => `| A | B |\n| :- | -: |\n| ${a} | ${b}<br>more |`),
  },
  { weight: 1, arbitrary: fc.constantFrom('$$\nx^2 + y\n$$', '---', '***', '    indented code') },
);

/** A whole note body as an agent might send it. */
export const agentMarkdown = fc
  .array(fc.tuple(block, fc.constantFrom('\n', '\n\n', '\n\n')), { minLength: 1, maxLength: 8 })
  .map((blocks) => blocks.map(([text, gap]) => `${text}${gap}`).join(''));
