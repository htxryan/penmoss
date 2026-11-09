// A wall-clock budget (A1244): `task budgets` runs it, never
// `task check`. That such blocks are read at all is a unit test (clipboard-security.test.ts).
import { describe, expect, it } from 'vitest';
import { sanitizeClipboardHTML } from '../src/clipboard/sanitize';

const clean = (html: string) => sanitizeClipboardHTML(html, new DOMParser());

describe('style rules in pasted HTML', () => {
  it('reads long or broken <style> blocks in linear time', () => {
    const started = performance.now();
    clean(`<style>${'a'.repeat(200_000)}</style><p>x</p>`);
    clean(`<style>${'/*'.repeat(100_000)}</style><p>x</p>`);
    clean(`<style>${'p,'.repeat(100_000)}</style><p>x</p>`);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
