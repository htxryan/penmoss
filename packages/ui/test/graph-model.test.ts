import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  DEFAULT_FILTERS,
  syntheticGraph,
  tagsOf,
  type GraphNoteInput,
} from '../src/graph/model';

const note = (
  id: string,
  links: string[] = [],
  group: string | null = null,
  tags: string[] = [],
): GraphNoteInput => ({ id, title: id.toUpperCase(), group, tags, links });

// a — b — c — d, e alone; f links to a note that is not listed.
const vault = [
  note('a', ['b'], 'garden'),
  note('b', ['c', 'a'], 'garden', ['plants']),
  note('c', ['d'], 'work'),
  note('d', [], null, ['plants']),
  note('e', [], 'work'),
  note('f', ['gone', 'f'], 'work'),
];
const ids = (data: { nodes: { id: string }[] }) => data.nodes.map((node) => node.id).sort();

describe('buildGraph', () => {
  it('makes one undirected edge per linked pair, ignoring self-links and unknown notes', () => {
    const data = buildGraph(vault, { kind: 'global' });
    expect(ids(data)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(data.edges.map((edge) => `${edge.source}-${edge.target}`)).toEqual([
      'a-b',
      'b-c',
      'c-d',
    ]);
    expect(data.nodes.find((node) => node.id === 'b')!.degree).toBe(2);
    expect(data.nodes.find((node) => node.id === 'e')!.degree).toBe(0);
  });

  it('keeps the notes within depth links of the centre in a local graph', () => {
    expect(ids(buildGraph(vault, { kind: 'local', id: 'a', depth: 1 }))).toEqual(['a', 'b']);
    expect(ids(buildGraph(vault, { kind: 'local', id: 'a', depth: 2 }))).toEqual(['a', 'b', 'c']);
    // Links count both ways: d is reached from c's outgoing link.
    expect(ids(buildGraph(vault, { kind: 'local', id: 'd', depth: 1 }))).toEqual(['c', 'd']);
    expect(ids(buildGraph(vault, { kind: 'local', id: 'e', depth: 3 }))).toEqual(['e']);
    expect(ids(buildGraph(vault, { kind: 'local', id: 'missing', depth: 2 }))).toEqual([]);
  });

  it('filters by top-level folder, keeping the local centre', () => {
    const filters = { ...DEFAULT_FILTERS, groups: new Set<string | null>(['garden']) };
    expect(ids(buildGraph(vault, { kind: 'global' }, filters))).toEqual(['a', 'b']);
    const top = { ...DEFAULT_FILTERS, groups: new Set<string | null>([null]) };
    expect(ids(buildGraph(vault, { kind: 'global' }, top))).toEqual(['d']);
    const local = buildGraph(vault, { kind: 'local', id: 'c', depth: 2 }, filters);
    expect(ids(local)).toEqual(['a', 'b', 'c']);
  });

  it('filters by tag and hides orphans', () => {
    const tagged = buildGraph(vault, { kind: 'global' }, { ...DEFAULT_FILTERS, tag: 'plants' });
    expect(ids(tagged)).toEqual(['b', 'd']);
    expect(tagged.edges).toEqual([]);
    const linked = buildGraph(vault, { kind: 'global' }, { ...DEFAULT_FILTERS, orphans: false });
    expect(ids(linked)).toEqual(['a', 'b', 'c', 'd']);
    // The centre stays even when it has no links.
    const alone = buildGraph(
      vault,
      { kind: 'local', id: 'e', depth: 1 },
      { ...DEFAULT_FILTERS, orphans: false },
    );
    expect(ids(alone)).toEqual(['e']);
  });

  it('adds tags as nodes when asked', () => {
    const data = buildGraph(vault, { kind: 'global' }, { ...DEFAULT_FILTERS, tagNodes: true });
    const tag = data.nodes.find((node) => node.kind === 'tag')!;
    expect(tag).toMatchObject({ id: 'tag:plants', label: '#plants', degree: 2 });
    expect(
      data.edges
        .filter((edge) => edge.tag)
        .map((edge) => edge.source)
        .sort(),
    ).toEqual(['b', 'd']);
  });

  it('labels untitled notes', () => {
    const data = buildGraph([{ ...note('x'), title: '  ' }], { kind: 'global' });
    expect(data.nodes[0]!.label).toBe('Untitled');
  });
});

describe('tagsOf and syntheticGraph', () => {
  it('lists tags by use', () => {
    expect(tagsOf([note('a', [], null, ['b', 'a']), note('c', [], null, ['a'])])).toEqual([
      'a',
      'b',
    ]);
  });

  it('generates a reproducible vault of the requested size', () => {
    const first = syntheticGraph(2000, 5000, 7);
    expect(first).toHaveLength(2000);
    expect(first.reduce((sum, item) => sum + item.links.length, 0)).toBe(5000);
    expect(syntheticGraph(2000, 5000, 7)).toEqual(first);
    const data = buildGraph(first, { kind: 'global' });
    expect(data.edges.length).toBeGreaterThan(4500);
  });
});
