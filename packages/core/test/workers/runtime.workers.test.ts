import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/markdown/parse';
import { serializeMarkdown } from '../../src/markdown/serialize';
import { fixtureLinks, fixtures } from '../support/fixtures';

// Included only by vitest.workers.config.ts.
describe('core in the Workers runtime', () => {
  it('is running inside workerd', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });

  it('has no DOM', () => {
    expect('document' in globalThis).toBe(false);
    expect('window' in globalThis).toBe(false);
    expect('DOMParser' in globalThis).toBe(false);
  });

  it('round-trips the whole fixture corpus', () => {
    const context = { links: fixtureLinks };
    const failures = fixtures.filter(
      ({ input, expected }) =>
        serializeMarkdown(parseMarkdown(input, context), context) !== expected,
    );

    expect(fixtures.length).toBeGreaterThanOrEqual(40);
    expect(failures.map((fixture) => fixture.name)).toEqual([]);
  });
});
