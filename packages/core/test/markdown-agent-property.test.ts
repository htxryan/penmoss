import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';
import { agentMarkdown } from './support/agent-markdown';

const RUNS = Number(globalThis.process?.env['PENMOSS_PROPERTY_RUNS'] ?? 300);
const TIMEOUT = 120_000;

// A157: whatever an agent writes parses to a document that fits the schema the editor
// shares (A9), and a mixed list never falls back to raw markdown.
describe('agent markdown (random, A157)', () => {
  it(
    'parses to a document that fits the schema, as does what it is written back as',
    () => {
      fc.assert(
        fc.property(agentMarkdown, (markdown) => {
          const { doc } = parseMarkdown(markdown);
          doc.check();
          parseMarkdown(serializeMarkdown({ frontmatter: null, doc })).doc.check();
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'keeps raw blocks only for what has no node: never a bullet list of tasks and items',
    () => {
      fc.assert(
        fc.property(agentMarkdown, (markdown) => {
          parseMarkdown(markdown).doc.descendants((node) => {
            if (node.type.name === 'rawMarkdown') {
              expect(node.textContent).not.toMatch(/^\s*[-*+] \[[ xX]\]/);
            }
          });
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});
