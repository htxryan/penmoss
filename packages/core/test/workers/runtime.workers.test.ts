import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/markdown/parse';
import { serializeMarkdown } from '../../src/markdown/serialize';
import { gitBlobSha } from '../../src/mirror/tree';
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

  it('names a blob as git does, streaming it through DigestStream (A213)', async () => {
    // Only workerd has DigestStream: the branch Node and browsers never take.
    expect(typeof (crypto as { DigestStream?: unknown }).DigestStream).toBe('function');
    const encode = (text: string) => new TextEncoder().encode(text);
    // `git hash-object --stdin` of each.
    expect(await gitBlobSha(new Uint8Array(0))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(await gitBlobSha(encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    // 140,000 bytes: past any one chunk the stream might take whole.
    expect(await gitBlobSha(encode('é'.repeat(70_000)))).toBe(
      '6301ae05b03c1274d4354edbf7542f8808d18cd8',
    );
  });
});
