import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';
import { schema } from '../src/schema';
import { fixtureLinks, fixtures } from './support/fixtures';

const context = { links: fixtureLinks };
const specFiles = import.meta.glob<string>('../docs/markdown-normalisation.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const spec = Object.values(specFiles)[0] ?? '';
const roundTrip = (markdown: string) =>
  serializeMarkdown(parseMarkdown(markdown, context), context);

describe('markdown fixture corpus', () => {
  it('has at least 40 fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
  });

  describe.each(fixtures)('$name', ({ input, expected }) => {
    it('serialises to the normalised form', () => {
      expect(roundTrip(input)).toBe(expected);
    });

    it('round-trips the normalised form byte for byte', () => {
      expect(roundTrip(expected)).toBe(expected);
    });
  });

  it('names only real fixtures in the normalisation spec', () => {
    const named = [...spec.matchAll(/`([a-z0-9-]+)\.md`/g)].map((match) => match[1]);
    const names = new Set(fixtures.map((fixture) => fixture.name));

    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !names.has(name!))).toEqual([]);
  });

  it('documents every fixture whose output is normalised', () => {
    const named = new Set([...spec.matchAll(/`([a-z0-9-]+)\.md`/g)].map((match) => match[1]));
    const normalised = fixtures.filter((fixture) => fixture.expected !== fixture.input);

    expect(normalised.map((fixture) => fixture.name).filter((name) => !named.has(name))).toEqual(
      [],
    );
  });

  it('covers every node and mark in the schema', () => {
    const nodes = new Set<string>();
    const marks = new Set<string>();
    const visit = (node: PMNode) => {
      nodes.add(node.type.name);
      for (const mark of node.marks) marks.add(mark.type.name);
      node.forEach(visit);
    };
    for (const { input } of fixtures) visit(parseMarkdown(input, context).doc);

    expect([...nodes].sort()).toEqual(Object.keys(schema.nodes).sort());
    expect([...marks].sort()).toEqual(Object.keys(schema.marks).sort());
  });
});
