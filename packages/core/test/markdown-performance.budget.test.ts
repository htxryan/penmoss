import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';
import { fixtureLinks, fixtures } from './support/fixtures';

// A wall-clock budget (A1244): it runs in `task budgets`,
// never in `task check`, where a loaded Mac measured 3.6 s for it. Node only: workerd freezes
// timers during synchronous work, so CPU time can only be measured here. Durable Objects get
// 30 s of CPU per invocation and the codec runs there (D20), so the bound is loose;
// it guards against accidental quadratic behaviour, not micro-regressions.
const context = { links: fixtureLinks };

function largeNote(minWords: number): string {
  const bodies = fixtures
    .map(({ expected }) => expected.replace(/^---\n[\s\S]*?\n---\n\n?/, ''))
    .filter((body) => body.trim());
  const parts: string[] = [];
  let words = 0;
  for (let index = 0; words < minWords; index++) {
    const body = bodies[index % bodies.length]!;
    parts.push(body);
    words += body.split(/\s+/).filter(Boolean).length;
  }
  return parts.join('\n');
}

describe('codec performance', () => {
  it('round-trips a 10,000-word note in well under a second', () => {
    const markdown = largeNote(10_000);
    serializeMarkdown(parseMarkdown(markdown, context), context); // warm up

    const start = performance.now();
    const parsed = parseMarkdown(markdown, context);
    const output = serializeMarkdown(parsed, context);
    const elapsed = performance.now() - start;

    expect(serializeMarkdown(parseMarkdown(output, context), context)).toBe(output);
    expect(elapsed).toBeLessThan(1000);
  });
});
