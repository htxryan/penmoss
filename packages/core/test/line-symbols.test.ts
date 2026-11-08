import { describe, expect, it } from 'vitest';
import { headingsOf, sectionOf, type DocJson } from '../src/links';
import {
  DEFAULT_SYMBOLS,
  MAX_SYMBOLS,
  SYMBOL_COLOUR_KEYS,
  SYMBOL_GLYPH_PRESETS,
  SYMBOLS_SETTING,
  findHeading,
  glyphKey,
  glyphProblem,
  headingKey,
  readSymbolList,
  symbolEdits,
  symbolListProblem,
  symbolRun,
  symbolsOf,
  withoutLeadingSymbols,
  type LineSymbol,
  type TextEdit,
} from '../src/line-symbols';
import { findSection } from '../src/markdown/diff-apply';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';

const symbols = DEFAULT_SYMBOLS;
/** The glyphs of a text's leading run. */
const run = (text: string, list: readonly LineSymbol[] = symbols) =>
  symbolRun(text, list).tokens.map((token) => text.slice(token.from, token.to).trimEnd());
const apply = (text: string, edits: readonly TextEdit[]) =>
  edits.reduce((out, edit) => out.slice(0, edit.from) + edit.insert + out.slice(edit.to), text);
const toggle = (text: string, index: number, add: boolean) =>
  apply(text, symbolEdits(symbolRun(text, symbols), symbols, index, add, text));

/** The text of every block the matcher reads, as parsed from markdown. */
function blockTexts(markdown: string): string[] {
  const out: string[] = [];
  parseMarkdown(markdown).doc.descendants((node) => {
    if (!node.isTextblock) return true;
    out.push(node.textContent);
    return false;
  });
  return out;
}

describe('the leading-glyph matcher (T44, A741)', () => {
  it('finds symbols after a list marker, a checkbox and heading hashes, as plain text', () => {
    const texts = blockTexts(
      '★ Call the bank\n\n- ? Bullet\n\n1. → Numbered\n\n- [ ] ! ★ Send the form\n\n## ? Open questions\n\n> 💡 Quoted\n',
    );
    expect(texts.map((text) => run(text))).toEqual([
      ['★'],
      ['?'],
      ['→'],
      ['!', '★'],
      ['?'],
      ['💡'],
    ]);
    expect(texts[3]!.slice(symbolRun(texts[3]!, symbols).end)).toBe('Send the form');
  });

  it('keeps several symbols in the order they are in', () => {
    expect(run('→ ★ ? Mixed')).toEqual(['→', '★', '?']);
    expect(symbolRun('→ ★ Mixed', symbols).tokens.map((token) => token.index)).toEqual([4, 0]);
  });

  it('matches multi-code-point emoji whole, with or without a variation selector', () => {
    const list: LineSymbol[] = [
      { glyph: '👨‍👩‍👧', name: 'Family', colour: 'accent' },
      { glyph: '❤️', name: 'Love', colour: 'danger' },
      { glyph: '💡', name: 'Idea', colour: 'calloutTip' },
    ];
    expect(run('👨‍👩‍👧 Dinner', list)).toEqual(['👨‍👩‍👧']);
    // A heart typed without the emoji selector, and a bulb with one, are the same symbols.
    expect(run('❤ 💡️ Both', list)).toEqual(['❤', '💡️']);
    // Part of a sequence is not the symbol.
    expect(run('👨 Alone', list)).toEqual([]);
  });

  it('ignores unknown glyphs, glyphs not followed by a space and anything after the run', () => {
    expect(run('☆ Not mine')).toEqual([]);
    expect(run('★★ Two stars')).toEqual([]);
    expect(run('★Joined')).toEqual([]);
    expect(run('★★')).toEqual([]);
    expect(run('Done ★ later')).toEqual([]);
    expect(run('★ ☆ ? After an unknown')).toEqual(['★']);
    expect(run('  ★ Indented')).toEqual([]);
    expect(run('★ Text', [])).toEqual([]);
  });

  it('reads a prose line starting with "? " as a symbol: display only (A742)', () => {
    const markdown = '? Is this a question\n';
    expect(run(blockTexts(markdown)[0]!)).toEqual(['?']);
    expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
    // Without "?" in the list it is text again; the bytes never changed.
    expect(run('? Is this a question', symbols.slice(0, 1))).toEqual([]);
  });

  it('round-trips symbol lines byte for byte: the codec is unchanged (D2, A157)', () => {
    const markdown = [
      '★ Call the bank',
      '',
      '- ? Bullet',
      '- ★ Second',
      '',
      'Then:',
      '',
      '- [ ] ! ★ Send the form',
      '- [x] → Done',
      '',
      '## ? Open questions',
      '',
      '1. 💡 Numbered',
      '',
      '> → Quoted',
      '',
    ].join('\n');
    expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
  });

  it('reads a line of only symbols back as symbols: markdown drops the last space (review)', () => {
    // A line ends in a glyph with no space only when it is nothing but symbols.
    expect(run('★')).toEqual(['★']);
    expect(run('★ ?')).toEqual(['★', '?']);
    expect(symbolRun('★ ?', symbols).end).toBe(3);
    // Without the bare last glyph (the editor's caret line): only the spaced ones count.
    expect(symbolRun('★', symbols, false).end).toBe(0);
    expect(symbolRun('★ ?', symbols, false).end).toBe(2);
    expect(run('★ ☆')).toEqual(['★']);
    for (const [line, markdown] of [
      ['★ ', '★\n'],
      ['★ ? ', '★ ?\n'],
      ['💡 ', '💡\n'],
    ] as const) {
      const doc = parseMarkdown('x\n');
      const written = serializeMarkdown({
        ...doc,
        doc: doc.doc.type.schema.nodeFromJSON({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: line }] }],
        }),
      });
      expect(written).toBe(markdown);
      const back = blockTexts(written)[0]!;
      expect(run(back)).toEqual(run(line));
      expect(serializeMarkdown(parseMarkdown(written))).toBe(written);
    }
    for (const markdown of ['- [ ] ★\n', '## ?\n', '- →\n', '1. ★ !\n']) {
      const text = blockTexts(markdown)[0]!;
      expect(run(text).length, markdown).toBeGreaterThan(0);
      expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
    }
    // A toggle on such a line keeps a space between the glyphs.
    expect(toggle('★', 4, true)).toBe('★ → ');
    expect(toggle('★', 0, false)).toBe('');
    expect(toggle('★ ?', 1, false)).toBe('★ ');
  });

  it('refuses glyphs that show nothing or turn text around (review)', () => {
    for (const glyph of [
      '\u200b',
      '★\u200b',
      '\u00ad',
      '\u202e★',
      '★\u200e',
      '\u2066★\u2069',
      '\u2060',
    ]) {
      expect(glyphProblem(glyph), JSON.stringify(glyph)).toBe(
        'glyph cannot hold invisible or direction characters',
      );
    }
    expect(glyphProblem('\u0301')).toBe('glyph cannot start with a combining mark');
    expect(glyphProblem('\u200d★')).toBe('glyph cannot hold invisible or direction characters');
    // A joiner inside an emoji, and a selector after one, are part of the glyph.
    expect(glyphProblem('👨\u200d👩\u200d👧')).toBeNull();
    expect(glyphProblem('❤\ufe0f')).toBeNull();
  });

  it('allows only glyphs the codec writes as they are', () => {
    // Every printable ASCII character a glyph may hold survives a round trip at a line start.
    for (let code = 0x21; code < 0x7f; code++) {
      const glyph = String.fromCharCode(code);
      if (glyphProblem(glyph) !== null) continue;
      for (const markdown of [`${glyph} text\n`, `- ${glyph} item\n`, `## ${glyph} heading\n`]) {
        expect(serializeMarkdown(parseMarkdown(markdown)), JSON.stringify(markdown)).toBe(markdown);
        expect(run(blockTexts(markdown)[0]!, [{ glyph, name: 'x', colour: 'accent' }])).toEqual([
          glyph,
        ]);
      }
    }
    for (const bad of ['#', '-', '+', '*', '>', '|', '`', '[', '\\', '<', '_', '$', '~', '='])
      expect(glyphProblem(bad), bad).not.toBeNull();
    for (const bad of ['', 'a', '1', '★ ★', 'ok', '①', 'x'.repeat(17), 3, null])
      expect(glyphProblem(bad), String(bad)).not.toBeNull();
    for (const good of ['★', '?', '!', '💡', '→', '❤️', '👨‍👩‍👧‍👦', '!!', '§'])
      expect(glyphProblem(good), good).toBeNull();
  });
});

describe('toggling a symbol (A740)', () => {
  it('adds a symbol at its place by list order and removes only its own', () => {
    expect(toggle('Plain', 0, true)).toBe('★ Plain');
    // → (slot 5) goes after ★ (slot 1), ? (slot 2) between them.
    expect(toggle('★ Text', 4, true)).toBe('★ → Text');
    expect(toggle('★ → Text', 1, true)).toBe('★ ? → Text');
    // Before the first symbol with a later slot, even when the line is out of order.
    expect(toggle('→ ★ Text', 1, true)).toBe('? → ★ Text');
    expect(toggle('★ ? → Text', 1, false)).toBe('★ → Text');
    expect(toggle('★ ? → Text', 0, false)).toBe('? → Text');
    // Adding one already there, or removing one that is not, changes nothing.
    expect(symbolEdits(symbolRun('★ Text', symbols), symbols, 0, true)).toEqual([]);
    expect(symbolEdits(symbolRun('★ Text', symbols), symbols, 1, false)).toEqual([]);
    expect(symbolEdits(symbolRun('Text', symbols), symbols, 12, true)).toEqual([]);
  });

  it('drops a second copy of a symbol with any toggle on the line (two devices at once)', () => {
    expect(toggle('★ ★ Text', 0, true)).toBe('★ Text');
    expect(toggle('★ ★ Text', 1, true)).toBe('★ ? Text');
    expect(toggle('★ ? ★ Text', 4, true)).toBe('★ ? → Text');
    expect(toggle('? ★ ? Text', 0, false)).toBe('? Text');
  });

  it('removes every copy of the symbol, and works on an empty line', () => {
    expect(toggle('★ ? ★ Twice', 0, false)).toBe('? Twice');
    expect(toggle('', 3, true)).toBe('💡 ');
    expect(toggle('💡 ', 3, false)).toBe('');
  });
});

describe('the symbols setting (A743)', () => {
  it('takes up to nine distinct symbols with a glyph, a name and a theme colour', () => {
    expect(symbolListProblem(DEFAULT_SYMBOLS)).toBeNull();
    expect(symbolListProblem([])).toBeNull();
    const nine = Array.from({ length: MAX_SYMBOLS }, (_, index) => ({
      glyph: '!'.repeat(index + 1),
      name: `Slot ${index + 1}`,
      colour: SYMBOL_COLOUR_KEYS[index % SYMBOL_COLOUR_KEYS.length],
    }));
    expect(symbolListProblem(nine)).toBeNull();
    expect(symbolListProblem([...nine, { glyph: '§', name: 'Ten', colour: 'accent' }])).toMatch(
      /at most 9/,
    );
    expect(symbolListProblem('★')).toMatch(/list/);
    expect(symbolListProblem([{ glyph: '★', name: 'A', colour: 'red' }])).toMatch(/colour/);
    expect(symbolListProblem([{ glyph: '★', name: ' ', colour: 'accent' }])).toMatch(/name/);
    expect(symbolListProblem([{ glyph: 'A', name: 'A', colour: 'accent' }])).toMatch(/letters/);
    expect(
      symbolListProblem([
        { glyph: '💡', name: 'Idea', colour: 'accent' },
        { glyph: '💡️', name: 'Bulb', colour: 'accent' },
      ]),
    ).toMatch(/repeats/);
  });

  it('reads the stored list, else the defaults, keeping only known fields', () => {
    expect(symbolsOf({})).toBe(DEFAULT_SYMBOLS);
    expect(symbolsOf({ [SYMBOLS_SETTING]: 'nonsense' })).toBe(DEFAULT_SYMBOLS);
    expect(symbolsOf({ [SYMBOLS_SETTING]: [] })).toEqual([]);
    expect(
      readSymbolList([{ glyph: '✓', name: ' Done ', colour: 'success', future: true }]),
    ).toEqual([{ glyph: '✓', name: 'Done', colour: 'success' }]);
  });
});

describe('the glyph picker’s presets (T51 item 9, A939)', () => {
  it('are each a glyph the rules allow, none twice, every default among them', () => {
    expect(SYMBOL_GLYPH_PRESETS.length).toBeGreaterThanOrEqual(30);
    for (const glyph of SYMBOL_GLYPH_PRESETS) expect(glyphProblem(glyph), glyph).toBeNull();
    const keys = SYMBOL_GLYPH_PRESETS.map(glyphKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const symbol of DEFAULT_SYMBOLS) expect(keys).toContain(glyphKey(symbol.glyph));
  });

  it('make a storable list in any nine, named by their glyphs (A940)', () => {
    const list = SYMBOL_GLYPH_PRESETS.slice(-MAX_SYMBOLS).map((glyph) => ({
      glyph,
      name: glyph,
      colour: '#3366ccaa',
    }));
    expect(symbolListProblem(list)).toBeNull();
  });
});

describe('headings with symbols (A741, A748)', () => {
  it('match with or without their leading symbols, whatever the list', () => {
    expect(withoutLeadingSymbols('? Open questions')).toBe('Open questions');
    expect(withoutLeadingSymbols('★ ☆ ?? Ideas ★')).toBe('Ideas ★');
    expect(withoutLeadingSymbols('#1 priority')).toBe('#1 priority');
    expect(withoutLeadingSymbols('C++ notes')).toBe('C++ notes');
    // A heading that is only symbols keeps its last one, or its text.
    expect(withoutLeadingSymbols('★ ?')).toBe('?');
    expect(withoutLeadingSymbols(' ★ ')).toBe('★');
    expect(headingKey('  ★ Plans ')).toBe('plans');
    expect(findHeading(['★ Plans', 'Plans'], 'Plans')).toBe(1);
    expect(findHeading(['★ Plans', 'Risks'], 'plans')).toBe(0);
    expect(findHeading(['★ Plans'], '? Plans')).toBe(0);
    expect(findHeading(['Plans'], 'Risks')).toBe(-1);
  });

  it('are found by update_section, read_note and embeds', () => {
    const markdown = '# Brief\n\nIntro\n\n## ? Open questions\n\nWhy\n\n## ★ Plans\n\nShip\n';
    const { doc } = parseMarkdown(markdown);
    expect(findSection(doc, 'Open questions')).toMatchObject({ ok: true, section: { heading: 2 } });
    expect(findSection(doc, '## ? Open questions')).toMatchObject({ ok: true });
    expect(findSection(doc, '## Plans')).toMatchObject({ ok: true, section: { heading: 4 } });
    const json = doc.toJSON() as DocJson;
    expect(sectionOf(json, 'open questions')?.length).toBe(2);
    expect(sectionOf(json, '★ Plans')?.length).toBe(2);
    // Listed as written: the symbol is part of the heading's text.
    expect(headingsOf(json).map((heading) => heading.text)).toContain('? Open questions');
  });

  it('prefer the heading written exactly, so a symbol does not make a lookup ambiguous', () => {
    const { doc } = parseMarkdown('## ★ Plans\n\na\n\n## Plans\n\nb\n');
    expect(findSection(doc, 'Plans')).toMatchObject({ ok: true, section: { heading: 2 } });
    expect(findSection(doc, '★ Plans')).toMatchObject({ ok: true, section: { heading: 0 } });
    const both = parseMarkdown('## ★ Plans\n\na\n\n## ? Plans\n\nb\n').doc;
    expect(findSection(both, 'Plans')).toMatchObject({ ok: false, reason: 'ambiguous' });
    // Links and embeds agree: the bare name fits two headings, so it names neither (review).
    expect(findHeading(['★ Plans', '? Plans'], 'Plans')).toBe(-1);
    expect(sectionOf(both.toJSON() as DocJson, 'Plans')).toBeNull();
    expect(findHeading(['★ Plans', '? Plans'], '? Plans')).toBe(1);
    expect(sectionOf(both.toJSON() as DocJson, '? plans')?.length).toBe(2);
  });
});

describe('custom symbol colours (T51, A939)', () => {
  it('takes #rrggbb and #rrggbbaa in lower case beside the theme colours', async () => {
    const { symbolListProblem, symbolColourVar, symbolColourLabel } =
      await import('../src/line-symbols');
    expect(symbolListProblem([{ glyph: '✓', name: '✓', colour: '#2e7d32' }])).toBeNull();
    expect(symbolListProblem([{ glyph: '✓', name: '✓', colour: '#2e7d3280' }])).toBeNull();
    expect(symbolListProblem([{ glyph: '✓', name: '✓', colour: '#2E7D32' }])).not.toBeNull();
    expect(symbolListProblem([{ glyph: '✓', name: '✓', colour: 'red' }])).not.toBeNull();
    expect(symbolColourVar('#2e7d32')).toBe('#2e7d32');
    expect(symbolColourVar('accent')).toBe('var(--pm-accent)');
    expect(symbolColourLabel('#2e7d32')).toBe('#2E7D32');
    expect(symbolColourLabel('danger')).toBe('Red');
  });
});

describe('a symbol’s name for screen readers (T51 review, A940)', () => {
  it('is the glyph, with an older symbol’s name beside it', async () => {
    const { symbolSpokenName } = await import('../src/line-symbols');
    expect(symbolSpokenName({ glyph: '!', name: 'Follow-up' })).toBe('! Follow-up');
    expect(symbolSpokenName({ glyph: '⚑', name: '⚑' })).toBe('⚑');
    expect(symbolSpokenName({ glyph: '✓', name: '  ' })).toBe('✓');
  });
});
