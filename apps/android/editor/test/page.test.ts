// @vitest-environment node
/**
 * The page's own lockdown (T32, A293): a Content-Security-Policy that allows
 * nothing but the APK's own scripts, styles, fonts and inline pictures, so a
 * script that got into a note could neither load more nor send anything out.
 * The app's WebViewClient refuses every other request too (EditorWebViewTest).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function policy(): Map<string, string[]> {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  expect(meta, 'index.html has a CSP meta tag').not.toBeNull();
  return new Map(
    meta![1]!.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name!, sources];
    }),
  );
}

describe('the editor page CSP', () => {
  it('denies by default, and comes before any script', () => {
    expect(policy().get('default-src')).toEqual(["'none'"]);
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
  });

  it('loads scripts from the APK only, with no inline or eval', () => {
    expect(policy().get('script-src')).toEqual(["'self'"]);
  });

  it('makes no network requests, frames, workers or forms', () => {
    const csp = policy();
    for (const name of ['connect-src', 'frame-src', 'worker-src', 'object-src', 'media-src']) {
      expect(csp.get(name), name).toEqual(["'none'"]);
    }
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'none'"]);
  });

  it('shows no remote pictures or fonts', () => {
    const csp = policy();
    for (const name of ['img-src', 'font-src', 'style-src']) {
      for (const source of csp.get(name) ?? []) {
        expect(source, `${name} ${source}`).not.toMatch(/^(https?:|\*)/);
      }
    }
  });
});
