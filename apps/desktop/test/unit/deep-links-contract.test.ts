/**
 * Deep links read the same on the Mac and on Android (T40 P7, PL5, A476):
 * every case of apps/android/contract/deep-links-v1.json, which the Kotlin
 * DeepLinksTest reads too.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDeepLink } from '../../src/deep-link';

const contract = JSON.parse(
  readFileSync(new URL('../../../android/contract/deep-links-v1.json', import.meta.url), 'utf8'),
) as {
  notes: { link: string; id: string }[];
  capture: string[];
  ignored: string[];
};

describe('deep links contract', () => {
  it('opens each note link at its note', () => {
    for (const { link, id } of contract.notes) {
      expect(parseDeepLink(link), link).toEqual({ kind: 'path', path: `/notes/${id}` });
    }
  });

  it('opens the capture window', () => {
    for (const link of contract.capture)
      expect(parseDeepLink(link), link).toEqual({ kind: 'capture' });
  });

  it('ignores everything else', () => {
    for (const link of contract.ignored) expect(parseDeepLink(link), link).toBeNull();
  });
});
