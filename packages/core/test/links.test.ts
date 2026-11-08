import { describe, expect, it } from 'vitest';
import {
  CONTEXT_LINKS,
  CONTEXT_RADIUS,
  contextText,
  extractLinks,
  headingsOf,
  linkLabel,
  sectionOf,
  type DocJson,
} from '../src/links';
import type { LinkResolver } from '../src/markdown/context';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';

const text = (value: string): DocJson => ({ type: 'text', text: value });
const link = (noteId: string | null, target: string, extra: Record<string, unknown> = {}) => ({
  type: 'wikilink',
  attrs: { noteId, target, heading: null, alias: null, ...extra },
});
const paragraph = (...content: DocJson[]): DocJson => ({ type: 'paragraph', content });

describe('extractLinks', () => {
  it('finds wikilinks with their block as context, and embeds', () => {
    const doc: DocJson = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [text('Plan')] },
        paragraph(text('See '), link('n1', 'Sync'), text(' and '), link(null, 'Later')),
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [paragraph(link('n2', 'Brief', { heading: 'Goals' }))] },
          ],
        },
        {
          type: 'embed',
          attrs: { noteId: 'n3', target: 'Notes', heading: 'Milestones', alias: null },
        },
      ],
    };

    const links = extractLinks(doc);

    expect(links.map((l) => [l.noteId, l.target, l.heading, l.embed])).toEqual([
      ['n1', 'Sync', null, false],
      [null, 'Later', null, false],
      ['n2', 'Brief', 'Goals', false],
      ['n3', 'Notes', 'Milestones', true],
    ]);
    expect(contextText(links[0]!.context, (id) => (id === 'n1' ? 'Sync design' : null))).toBe(
      'See Sync design and Later',
    );
  });

  it('trims long blocks around the link, at word boundaries', () => {
    const long = 'word '.repeat(60);
    const [found] = extractLinks({
      type: 'doc',
      content: [paragraph(text(long), link('n1', 'Target'), text(` ${long}`))],
    });

    const shown = contextText(found!.context, () => 'Target');
    expect(shown.startsWith('…word')).toBe(true);
    expect(shown.endsWith('word…')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(2 * CONTEXT_RADIUS + 'Target'.length + 2);
  });

  it('keeps at most CONTEXT_LINKS links on each side, however many the block holds', () => {
    const links = Array.from({ length: 3000 }, (_, i) => link(`n${i}`, `Note ${i}`));
    const found = extractLinks({ type: 'doc', content: [paragraph(...links)] });

    expect(found).toHaveLength(3000);
    for (const at of [0, 5, 1500, 2999]) {
      const { context } = found[at]!;
      const refs = context.filter((part) => typeof part !== 'string');
      expect(refs.length).toBeLessThanOrEqual(2 * CONTEXT_LINKS + 1);
      expect(refs).toContainEqual(expect.objectContaining({ noteId: `n${at}` }));
      // Cut short where links were left out.
      if (at > CONTEXT_LINKS) expect(context[0]).toBe('…');
      if (at < 2999 - CONTEXT_LINKS) expect(context.at(-1)).toBe('…');
    }
    // The links nearest the link are the ones kept, in order.
    const middle = found[1500]!.context.filter((part) => typeof part !== 'string');
    expect(middle.map((ref) => (ref as { noteId: string }).noteId)).toEqual(
      Array.from({ length: 2 * CONTEXT_LINKS + 1 }, (_, i) => `n${1500 - CONTEXT_LINKS + i}`),
    );
  });

  it('reads links from a parsed note (the server path)', () => {
    const { doc } = parseMarkdown('Intro [[Alpha|the first]] text\n\n![[Beta#Part]]\n');

    const links = extractLinks(doc.toJSON() as DocJson);

    expect(links).toMatchObject([
      { target: 'Alpha', alias: 'the first', embed: false },
      { target: 'Beta', heading: 'Part', embed: true },
    ]);
  });
});

describe('linkLabel', () => {
  it('prefers the alias, then the current title, then what was written', () => {
    const ref = { noteId: 'n1', target: 'Old title', heading: null, alias: null };
    expect(linkLabel(ref, 'New title')).toBe('New title');
    expect(linkLabel(ref, null)).toBe('Old title');
    expect(linkLabel({ ...ref, heading: 'Goals' }, 'New title')).toBe('New title › Goals');
    expect(linkLabel({ ...ref, alias: 'see here' }, 'New title')).toBe('see here');
  });
});

describe('sections', () => {
  const doc = parseMarkdown(
    '# Brief\n\nIntro\n\n## Goals\n\nShip it\n\n### Detail\n\nMore\n\n## Risks\n\nNone\n',
  ).doc.toJSON() as DocJson;

  it('lists headings', () => {
    expect(headingsOf(doc).map((h) => h.text)).toEqual(['Brief', 'Goals', 'Detail', 'Risks']);
  });

  it('takes a heading and what follows it, up to the next heading of its level or higher', () => {
    const section = sectionOf(doc, 'goals')!;
    expect(section.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'paragraph',
    ]);
    expect(sectionOf(doc, 'Risks')!.length).toBe(2);
    expect(sectionOf(doc, null)!.length).toBe(8);
    expect(sectionOf(doc, 'Missing')).toBeNull();
  });
});

describe('renames in markdown', () => {
  const notes: Record<string, { title: string; path: string | null }> = {
    n1: { title: 'Renamed', path: null },
    n2: { title: 'Duplicate', path: 'Projects/Duplicate.md' },
  };
  const resolver: LinkResolver = {
    resolve: () => null,
    linkText: (id) => {
      const note = notes[id];
      if (!note) return null;
      return note.title === 'Duplicate' ? note.path!.replace(/\.md$/, '') : note.title;
    },
    title: (id) => notes[id]?.title ?? null,
  };

  it('writes the current title, and an ambiguous title as [[path|Title]]', () => {
    const doc = {
      type: 'doc',
      content: [
        paragraph(link('n1', 'Old'), text(' '), link('n2', 'Duplicate')),
        paragraph(link('n2', 'Duplicate', { alias: 'mine', heading: 'Goals' })),
        paragraph(link('gone', 'Deleted note')),
      ],
    };
    const markdown = serializeMarkdown(
      { frontmatter: null, doc: parseMarkdown('').doc.type.schema.nodeFromJSON(doc) },
      { links: resolver },
    );
    expect(markdown).toBe(
      '[[Renamed]] [[Projects/Duplicate|Duplicate]]\n\n[[Projects/Duplicate#Goals|mine]]\n\n[[Deleted note]]\n',
    );
  });
});
