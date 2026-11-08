/**
 * Send feedback's screenshots and the form's checks (T49): which images are taken, how they are
 * scaled and named, and what the form asks for before it sends.
 */
import { describe, expect, it } from 'vitest';
import { issueLink } from '../../src/feedback/send';
import { ISSUE_BODY_MAX, problemsOf, sizeProblem } from '../../src/feedback/problems';
import {
  checkImage,
  fitWithin,
  flattenOnWhite,
  nameFor,
  outputType,
} from '../../src/feedback/images';

describe('screenshots', () => {
  it('takes PNG, JPEG, WebP and GIF up to 10 MB', () => {
    expect(checkImage({ type: 'image/png', size: 10 })).toBeNull();
    expect(checkImage({ type: 'image/webp', size: 10 * 1024 * 1024 })).toBeNull();
    expect(checkImage({ type: 'image/svg+xml', size: 10 })).toMatch(/PNG, JPEG, WebP or GIF/);
    expect(checkImage({ type: 'application/pdf', size: 10 })).toMatch(/PNG, JPEG, WebP or GIF/);
    expect(checkImage({ type: 'image/jpeg', size: 10 * 1024 * 1024 + 1 })).toMatch(/10 MB/);
    expect(checkImage({ type: 'image/gif', size: 0 })).toMatch(/empty/);
  });

  it('scales down to 2560 px on the long side, never up', () => {
    expect(fitWithin(5120, 2880)).toEqual({ width: 2560, height: 1440 });
    expect(fitWithin(1000, 4000)).toEqual({ width: 640, height: 2560 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10000, 1)).toEqual({ width: 2560, height: 1 });
  });

  it('keeps PNG as PNG and makes the rest JPEG, named by position', () => {
    expect(outputType('image/png')).toBe('image/png');
    expect(outputType('image/webp')).toBe('image/jpeg');
    expect(outputType('image/gif')).toBe('image/jpeg');
    expect(nameFor('image/png', 0)).toBe('screenshot-1.png');
    expect(nameFor('image/jpeg', 2)).toBe('screenshot-3.jpg');
  });
});

describe('JPEG’s missing transparency', () => {
  it('lays see-through pixels on white and leaves opaque ones', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 0, 200, 0, 0, 255, 0, 0, 0, 128]);
    flattenOnWhite(data);
    expect([...data]).toEqual([255, 255, 255, 255, 200, 0, 0, 255, 127, 127, 127, 255]);
  });
});

describe('the form’s checks', () => {
  it('asks for a type, a priority (no default) and a one-line title', () => {
    expect(problemsOf({ type: null, priority: null, title: '  ' })).toEqual({
      type: 'Choose Bug report or Feature request.',
      priority: 'Choose a priority.',
      title: 'Give it a title.',
    });
    expect(problemsOf({ type: 'bug', priority: 2, title: 'Sync stalls' })).toEqual({});
    expect(problemsOf({ type: 'feature', priority: 4, title: 'x'.repeat(257) }).title).toMatch(
      /256 characters/,
    );
  });
});

describe('what the server would refuse for good, caught before it is queued', () => {
  const report = {
    markdown: 'short',
    context: { groups: [] },
    screenshots: 2,
    client: 'web' as const,
    version: '1.0',
    submissionId: '01JBXYZ0000000000000000001',
  };

  it('a description over 20,000 characters of markdown', () => {
    expect(sizeProblem(report)).toBeNull();
    expect(sizeProblem({ ...report, markdown: 'x'.repeat(20_001) })).toMatch(/20,000 characters/);
  });

  it('an issue body over GitHub’s limit', () => {
    const long = 'x'.repeat(390);
    const context = {
      groups: [
        {
          id: 'errors' as const,
          columns: ['Time', 'Message', 'Stack'],
          rows: Array.from({ length: 40 }, () => [long, long, long]),
        },
      ],
    };
    expect(sizeProblem({ ...report, markdown: 'y'.repeat(20_000), context })).toMatch(
      /longer than a GitHub issue/,
    );
    expect(ISSUE_BODY_MAX).toBe(65_536);
  });
});

describe('the Sent toast', () => {
  it('links only an issue on github.com', () => {
    expect(issueLink('https://github.com/htxryan/penmoss/issues/12')).toBe(
      'https://github.com/htxryan/penmoss/issues/12',
    );
    expect(issueLink('https://evil.example/htxryan/penmoss/issues/12')).toBeNull();
    expect(issueLink('javascript:alert(1)')).toBeNull();
    expect(issueLink('https://github.com.evil.example/a/b/issues/1')).toBeNull();
  });
});
