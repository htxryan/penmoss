import { describe, expect, it } from 'vitest';
import { headingsOf, sectionOf, type DocJson } from '../src/links';
import {
  DEFAULT_SYMBOLS,
  GUTTER_SLOTS,
  MAX_SYMBOLS,
  checkboxEdits,
  gutterSlots,
  reservedGlyphs,
  runBox,
  runIsStruck,
  tokenGlyph,
  type BoxState,
  SYMBOL_COLOUR_KEYS,
  SYMBOL_GLYPH_PRESETS,
  SYMBOLS_SETTING,
  findHeading,
  kindSymbol,
  storedSymbolList,
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

// The glyphs of the defaults, ★ ? ! 💡 →, without the Checkbox before them (A1632).
const symbols = DEFAULT_SYMBOLS.filter((symbol) => !symbol.kind);
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

describe('list items in the symbol list (A1632)', () => {
  const stored = [
    { kind: 'checkbox' },
    { glyph: '★', name: '★', colour: 'accent' },
    { kind: 'ordered' },
  ];

  it('puts Checkbox on the first slot by default, the glyphs after it, Strikethrough last', () => {
    expect(DEFAULT_SYMBOLS[0]).toEqual(kindSymbol('checkbox'));
    expect(DEFAULT_SYMBOLS.slice(1, -1).map((symbol) => symbol.glyph)).toEqual([
      '★',
      '?',
      '!',
      '💡',
      '→',
    ]);
    expect(DEFAULT_SYMBOLS.at(-1)).toEqual(kindSymbol('strike'));
  });

  it('stores a kind as { kind } alone, and reads it back as its entry', () => {
    expect(symbolListProblem(stored)).toBeNull();
    const read = readSymbolList(stored)!;
    expect(read.map((symbol) => symbol.kind)).toEqual(['checkbox', undefined, 'ordered']);
    expect(read[2]).toMatchObject({ glyph: '1.', name: 'Numbered List Item' });
    expect(storedSymbolList(read)).toEqual(stored);
  });

  it('takes each kind once, and only the kinds there are', () => {
    expect(symbolListProblem([{ kind: 'bullet' }, { kind: 'bullet' }])).toMatch(/repeats the kind/);
    expect(symbolListProblem([{ kind: 'table' }])).toMatch(/kind must be/);
    // A ☐ glyph of the person's own is not the Checkbox.
    expect(
      symbolListProblem([{ kind: 'checkbox' }, { glyph: '☐', name: '☐', colour: 'accent' }]),
    ).toBeNull();
  });

  it('is never text at the start of a line, and a toggle leaves the text alone', () => {
    const list = readSymbolList(stored)!;
    // A list item's own glyph (`1.`) is never read from the text, nor written to it.
    expect(symbolRun('1. Call', list).tokens).toEqual([]);
    expect(symbolRun('★ Call', list).tokens.map((token) => token.index)).toEqual([1]);
    expect(symbolEdits(symbolRun('Call', list), list, 2, true, 'Call')).toEqual([]);
    // The Checkbox stacks as text since A1678: `☐` is its slot's.
    expect(symbolRun('☐ 1. Call', list).tokens.map((token) => token.index)).toEqual([0]);
  });
});

describe('stacked symbols: the Checkbox and Strikethrough in a line’s run (A1678, A1679)', () => {
  const list = DEFAULT_SYMBOLS;
  const slots = (text: string) => symbolRun(text, list).tokens.map((token) => token.index);
  const glyphs = (text: string) =>
    symbolRun(text, list).tokens.map((token) => tokenGlyph(token, list));
  const box = (text: string, to: BoxState) =>
    apply(text, checkboxEdits(symbolRun(text, list), list, 0, to, text));
  const toggleIn = (text: string, index: number, add: boolean) =>
    apply(text, symbolEdits(symbolRun(text, list), list, index, add, text));

  it('reads ☐, ☑ and ⊘ in a run beside the other symbols, each on its slot', () => {
    expect(slots('☐ ★ Call the bank')).toEqual([0, 1]);
    expect(glyphs('☑ ★ ! Call the bank')).toEqual(['☑', '★', '!']);
    expect(symbolRun('☑ Call', list).tokens[0]).toMatchObject({ index: 0, checked: true });
    expect(symbolRun('☐ Call', list).tokens[0]!.checked).toBeUndefined();
    expect(glyphs('⊘ ★ Struck')).toEqual(['⊘', '★']);
    expect(runIsStruck(symbolRun('★ ⊘ Struck', list), list)).toBe(true);
    expect(runIsStruck(symbolRun('★ Plain', list), list)).toBe(false);
    expect(runBox(symbolRun('★ ☐ Box', list), list)).toBe('unticked');
    expect(runBox(symbolRun('☑️ Box', list), list)).toBe('ticked');
    expect(runBox(symbolRun('★ Box', list), list)).toBe('none');
    // Without those kinds in the list, the glyphs are text (A742).
    const glyphsOnly = list.filter((symbol) => !symbol.kind);
    expect(symbolRun('☐ ⊘ Call', glyphsOnly).tokens).toEqual([]);
    // A glyph of the person's own that looks the same stays theirs.
    const own: LineSymbol[] = [kindSymbol('checkbox'), { glyph: '☐', name: '☐', colour: 'accent' }];
    expect(symbolRun('☐ Call', own).tokens.map((token) => token.index)).toEqual([1]);
    expect(symbolRun('☑ Call', own).tokens.map((token) => token.index)).toEqual([0]);
    expect([...reservedGlyphs(list).keys()]).toEqual(['☐', '☑', '⊘']);
    expect(reservedGlyphs(glyphsOnly).size).toBe(0);
  });

  it('steps a run’s Checkbox through ☐, ☑ and none, in list order, other symbols kept', () => {
    expect(box('★ ! Call the bank', 'unticked')).toBe('☐ ★ ! Call the bank');
    expect(box('☐ ★ ! Call the bank', 'ticked')).toBe('☑ ★ ! Call the bank');
    expect(box('☑ ★ ! Call the bank', 'unticked')).toBe('☐ ★ ! Call the bank');
    expect(box('☑ ★ ! Call the bank', 'none')).toBe('★ ! Call the bank');
    expect(box('Call the bank', 'unticked')).toBe('☐ Call the bank');
    // Already so: nothing to do.
    expect(checkboxEdits(symbolRun('☑ Call', list), list, 0, 'ticked', '☑ Call')).toEqual([]);
    expect(checkboxEdits(symbolRun('Call', list), list, 0, 'ticked', 'Call')).toEqual([]);
    // A line of only a box, read back without its space; a box with a variation selector.
    expect(box('☐', 'ticked')).toBe('☑');
    expect(box('☑️ Call', 'unticked')).toBe('☐ Call');
    // Two boxes (two devices at once): the first takes the state, the second goes.
    expect(box('☐ ★ ☐ Call', 'ticked')).toBe('☑ ★ Call');
    // Not a Checkbox slot: nothing.
    expect(checkboxEdits(symbolRun('Call', list), list, 1, 'unticked', 'Call')).toEqual([]);
  });

  it('toggles Strikethrough as ⊘ at its place by list order, the other symbols kept', () => {
    const strike = list.length - 1;
    expect(toggleIn('★ ? Call', strike, true)).toBe('★ ? ⊘ Call');
    expect(toggleIn('☐ ★ ? ⊘ Call', strike, false)).toBe('☐ ★ ? Call');
    // A symbol with an earlier slot goes before it; the Checkbox first of all.
    expect(toggleIn('⊘ Call', 1, true)).toBe('★ ⊘ Call');
    expect(box('⊘ Call', 'unticked')).toBe('☐ ⊘ Call');
  });

  it('round-trips stacked lines byte for byte, the bullet, number and box kept', () => {
    for (const markdown of [
      '- ☐ ★ Milk\n- Eggs\n',
      '1. ☑ ★ Call the bank\n2. Book the train\n',
      '⊘ ★ Struck through\n',
      '## ☐ ⊘ Open questions\n',
      '- [ ] ⊘ ! Send the form\n',
      '- ☐ ★ !\n',
    ]) {
      expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
    }
    // Still a bulleted and a numbered list, each item its own line with its symbols.
    const doc = parseMarkdown('1. ☐ ★ First\n2. Second\n').doc;
    expect(doc.firstChild!.type.name).toBe('orderedList');
    expect(doc.firstChild!.childCount).toBe(2);
    expect(blockTexts('- ☐ ★ Milk\n- Eggs\n')).toEqual(['☐ ★ Milk', 'Eggs']);
    expect(run('1. ☑ ★ Call the bank', list)).toEqual([]);
    expect(run('☑ ★ Call the bank', list)).toEqual(['☑', '★']);
  });

  it('stores Strikethrough as { kind } alone', () => {
    const stored = [{ kind: 'strike' }, { glyph: '★', name: '★', colour: 'accent' }];
    expect(symbolListProblem(stored)).toBeNull();
    expect(readSymbolList(stored)![0]).toEqual(kindSymbol('strike'));
    expect(kindSymbol('strike')).toMatchObject({ glyph: '⊘', name: 'Strikethrough' });
    expect(storedSymbolList(readSymbolList(stored)!)).toEqual(stored);
    expect(symbolListProblem([{ kind: 'strike' }, { kind: 'strike' }])).toMatch(/repeats the kind/);
  });
});

describe('the symbol gutter’s width (A1680)', () => {
  it('has room for the widest stack, none without symbols, three at most', () => {
    expect(GUTTER_SLOTS).toBe(3);
    expect([0, 1, 2, 3, 4, 9].map(gutterSlots)).toEqual([0, 1, 2, 3, 3, 3]);
    expect(gutterSlots(-1)).toBe(0);
    expect(gutterSlots(Number.NaN)).toBe(0);
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
    for (const symbol of symbols) expect(keys).toContain(glyphKey(symbol.glyph));
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
