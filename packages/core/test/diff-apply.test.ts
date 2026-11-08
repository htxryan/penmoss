import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { parseMarkdown, schema, serializeMarkdown, type LinkResolver } from '../src';
import {
  blockMarkdown,
  blocksOf,
  findSection,
  markdownOccurrences,
  parseHeadingRef,
  replaceBlocks,
  reuseBlocks,
  sectionMarkdown,
} from '../src/markdown/diff-apply';

const links: LinkResolver = {
  resolve: (target) => ({ Alpha: 'note-alpha', Beta: 'note-beta' })[target] ?? null,
  linkText: (id) => ({ 'note-alpha': 'Alpha', 'note-beta': 'Beta' })[id] ?? null,
};
const doc = (markdown: string) => parseMarkdown(markdown, { links }).doc;
const md = (node: PMNode) => serializeMarkdown({ frontmatter: null, doc: node }, { links });
const blocks = (node: PMNode) => {
  const out: PMNode[] = [];
  node.forEach((block) => out.push(block));
  return out;
};

const NOTE = `Intro line

# Plans

First plan

## Details

Fine print

# Ideas

An idea with [[Alpha]] and #tag

| a | b |
| - | - |
| 1 | 2 |
`;

describe('parseHeadingRef (T24)', () => {
  it('reads an optional level from leading #', () => {
    expect(parseHeadingRef('Plans')).toEqual({ level: null, text: 'Plans' });
    expect(parseHeadingRef('## Details ')).toEqual({ level: 2, text: 'Details' });
    expect(parseHeadingRef('#tag-like')).toEqual({ level: null, text: '#tag-like' });
  });
});

describe('findSection (T24)', () => {
  it('spans a heading and what follows it up to the next heading of its level or higher', () => {
    const found = findSection(doc(NOTE), 'plans');
    expect(found).toMatchObject({ ok: true, section: { heading: 1, level: 1, start: 2, end: 5 } });
    const details = findSection(doc(NOTE), '## Details');
    expect(details).toMatchObject({ ok: true, section: { heading: 3, start: 4, end: 5 } });
    // The last section runs to the end of the note.
    expect(findSection(doc(NOTE), 'Ideas')).toMatchObject({
      ok: true,
      section: { heading: 5, start: 6, end: 8 },
    });
  });

  it('reports a missing or ambiguous heading', () => {
    expect(findSection(doc(NOTE), 'Nope')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(findSection(doc(NOTE), '### Plans')).toMatchObject({ ok: false, reason: 'not-found' });
    const twice = doc('# A\n\nx\n\n## A\n\ny\n');
    expect(findSection(twice, 'A')).toMatchObject({ ok: false, reason: 'ambiguous' });
    // A level picks one.
    expect(findSection(twice, '## A')).toMatchObject({ ok: true, section: { heading: 2 } });
  });

  it('matches a heading by the text a wikilink in it shows', () => {
    expect(findSection(doc('# About [[Alpha]]\n\nx\n'), 'About Alpha')).toMatchObject({
      ok: true,
    });
  });
});

describe('reuseBlocks (T24, generalises A81)', () => {
  it('takes a block from the sources when its markdown is the same, keeping what markdown drops', () => {
    const live = doc(NOTE);
    const table = blocks(live).find((block) => block.type.name === 'table')!;
    // Column widths are not in markdown; a reparsed table would lose them.
    const rows: PMNode[] = [];
    table.forEach((row) => {
      const cells: PMNode[] = [];
      row.forEach((cell) =>
        cells.push(cell.type.create({ ...cell.attrs, colwidth: [150] }, cell.content)),
      );
      rows.push(row.type.create(row.attrs, cells));
    });
    const wide = table.type.create(table.attrs, rows);
    const widened = schema.node('doc', null, [
      ...blocks(live).filter((block) => block !== table),
      wide,
    ]);
    const reparsed = blocks(doc(md(widened)));
    const reused = reuseBlocks(reparsed, blocks(widened));
    expect(reused.at(-1)).toBe(wide);
    // A changed block is the parsed one.
    const edited = blocks(doc(md(widened).replace('First plan', 'Second plan')));
    const out = reuseBlocks(edited, blocks(widened));
    expect(out[2]).toBe(edited[2]);
    expect(out[0]).toBe(blocks(widened)[0]);
  });
});

describe('reuseBlocks with identical blocks (T24 review)', () => {
  it('maps identical blocks to their sources by position, not all to the first', () => {
    const table = blocks(doc('| a | b |\n| - | - |\n| 1 | 2 |\n'))[0]!;
    const widen = (width: number) => {
      const rows: PMNode[] = [];
      table.forEach((row) => {
        const cells: PMNode[] = [];
        row.forEach((cell) =>
          cells.push(cell.type.create({ ...cell.attrs, colwidth: [width] }, cell.content)),
        );
        rows.push(row.type.create(row.attrs, cells));
      });
      return table.type.create(table.attrs, rows);
    };
    const [narrow, wide] = [widen(80), widen(240)];
    const sources = [narrow, schema.node('paragraph', null, [schema.text('between')]), wide];
    const reparsed = blocks(doc(md(schema.node('doc', null, sources))));
    const reused = reuseBlocks(reparsed, sources);
    expect(reused[0]).toBe(narrow);
    expect(reused[2]).toBe(wide);
    // A third copy the target adds has no source of its own: it takes the last one's.
    const three = blocks(
      doc(`${md(schema.node('doc', null, sources))}\n${md(schema.node('doc', null, [table]))}`),
    );
    expect(
      reuseBlocks(three, sources).map(
        (block) => block.firstChild?.firstChild?.attrs['colwidth'] as unknown,
      ),
    ).toEqual([[80], undefined, [240], [240]]);
  });
});

describe('reuseBlocks with current link titles (T24)', () => {
  it('matches a block whose link was written under an older title', () => {
    // The live block links note-alpha under the title it had then ("Old name").
    const live = blocksOf(
      parseMarkdown('See [[Old name]]\n', {
        links: { resolve: () => 'note-alpha', linkText: () => null },
      }).doc,
    );
    const renamed: LinkResolver = {
      resolve: (target) => (target === 'Alpha' ? 'note-alpha' : null),
      linkText: (id) => (id === 'note-alpha' ? 'Alpha' : null),
    };
    // An agent read it with the current title and sent it back unchanged.
    const sent = blocksOf(parseMarkdown('See [[Alpha]]\n', { links: renamed }).doc);
    expect(reuseBlocks(sent, live)[0]).not.toBe(live[0]);
    expect(reuseBlocks(sent, live, renamed)[0]).toBe(live[0]);
  });
});

describe('replaceBlocks (T24)', () => {
  it('splices top-level blocks and never leaves an empty body', () => {
    const live = doc('a\n\nb\n\nc\n');
    const out = replaceBlocks(live, 1, 2, blocks(doc('x\n\ny\n')));
    expect(md(out)).toBe('a\n\nx\n\ny\n\nc\n');
    const emptied = replaceBlocks(live, 0, 3, []);
    expect(emptied.childCount).toBe(1);
    expect(emptied.firstChild?.type.name).toBe('paragraph');
  });

  it('wikilinks, embeds, tables and tags survive a splice elsewhere', () => {
    const source = `${NOTE}\n![[Beta]]\n`;
    const live = doc(source);
    const out = replaceBlocks(live, 2, 3, blocks(doc('Rewritten plan\n')));
    const text = md(out);
    expect(text).toContain('Rewritten plan');
    expect(text).toContain('[[Alpha]]');
    expect(text).toContain('![[Beta]]');
    expect(text).toContain('#tag');
    expect(text).toContain('| 1 | 2 |');
    let ids = 0;
    out.descendants((node) => {
      if (node.type.name === 'wikilink' || node.type.name === 'embed') {
        expect(node.attrs['noteId']).toMatch(/^note-/);
        ids++;
      }
      return true;
    });
    expect(ids).toBe(2);
  });
});

describe('sectionMarkdown and blockMarkdown (T24)', () => {
  it('renders a section the way its blocks render on their own', () => {
    const live = doc(NOTE);
    const found = findSection(live, 'Plans');
    if (!found.ok) throw new Error('missing');
    expect(sectionMarkdown(live, found.section)).toBe(
      '# Plans\n\nFirst plan\n\n## Details\n\nFine print\n',
    );
    expect(blockMarkdown(live.child(0))).toBe('Intro line\n');
  });
});

describe('markdownOccurrences (T24)', () => {
  it('finds each occurrence with the whole lines it spans', () => {
    const text = 'one two\nthree two\nfour\n';
    expect(markdownOccurrences(text, 'two')).toEqual([
      { index: 4, lines: 'one two' },
      { index: 14, lines: 'three two' },
    ]);
    expect(markdownOccurrences(text, 'two\nthree')).toEqual([
      { index: 4, lines: 'one two\nthree two' },
    ]);
    expect(markdownOccurrences(text, 'zzz')).toEqual([]);
    expect(markdownOccurrences('aaaa', 'aa').map((o) => o.index)).toEqual([0, 2]);
  });
});

describe('markdownOccurrences in text only (T24 review)', () => {
  const text =
    'See [the idea](https://idea.example/idea "idea") and [[idea note|my idea]] and ![[idea pic]]\n\n' +
    '<https://idea.example> ![idea](attachments/idea.png) [ref idea][idea]\n\n[idea]: https://idea.example/ref\n\nAn idea, `idea` code\n';

  it('skips link addresses and titles, wikilinks, embeds, images and definitions', () => {
    const found = markdownOccurrences(text, 'idea', { textOnly: true });
    const at = (index: number) => text.slice(index - 4, index + 8);
    expect(found.map((o) => at(o.index))).toEqual([
      'the idea](ht',
      'ref idea][id',
      '\nAn idea, `i',
      'a, `idea` co',
    ]);
  });

  it('finds every occurrence without the option', () => {
    expect(markdownOccurrences(text, 'idea').length).toBeGreaterThan(10);
  });
});
