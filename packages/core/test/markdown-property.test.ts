import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';
import { schema } from '../src/schema';
import { contentOf, documentArbitrary } from './support/doc-arbitraries';

const RUNS = Number(globalThis.process?.env['PENMOSS_PROPERTY_RUNS'] ?? 300);
const TIMEOUT = 120_000;

describe('markdown codec properties (random documents from the schema)', () => {
  it(
    'keeps formulas with pipes and backslashes in table cells',
    () => {
      const latex = fc.string({
        unit: fc.constantFrom(...'ax|\\ {}'),
        minLength: 1,
        maxLength: 12,
      });
      fc.assert(
        fc.property(fc.array(latex, { minLength: 1, maxLength: 3 }), (formulas) => {
          const cells = formulas.map((value) =>
            schema.node('tableHeader', null, [
              schema.text('f '),
              schema.node('inlineMath', { latex: value }),
            ]),
          );
          const doc = schema.node('doc', null, [
            schema.node('table', null, [schema.node('tableRow', null, cells)]),
          ]);
          const markdown = serializeMarkdown({ frontmatter: null, doc });
          const parsed = parseMarkdown(markdown).doc;
          const read: unknown[] = [];
          parsed.descendants((node) => {
            if (node.type.name === 'inlineMath') read.push(node.attrs['latex']);
          });
          expect(read).toEqual(formulas);
          expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'serialise → parse → serialise is stable',
    () => {
      fc.assert(
        fc.property(documentArbitrary, (doc) => {
          const markdown = serializeMarkdown({ frontmatter: null, doc });
          const again = serializeMarkdown(parseMarkdown(markdown));
          expect(again).toBe(markdown);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'loses no text content',
    () => {
      fc.assert(
        fc.property(documentArbitrary, (doc) => {
          const markdown = serializeMarkdown({ frontmatter: null, doc });
          expect(contentOf(parseMarkdown(markdown).doc)).toEqual(contentOf(doc));
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'a parsed document survives another round trip unchanged',
    () => {
      fc.assert(
        fc.property(documentArbitrary, (doc) => {
          const parsed = parseMarkdown(serializeMarkdown({ frontmatter: null, doc })).doc;
          const reparsed = parseMarkdown(serializeMarkdown({ frontmatter: null, doc: parsed })).doc;
          expect(reparsed.toJSON()).toEqual(parsed.toJSON());
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});
