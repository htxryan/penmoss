import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mockupsText, parseRendered, renderCommand } from '../src/mockups.ts';

const script = readFileSync(new URL('../sandbox/render-mockups.cjs', import.meta.url), 'utf8');

describe('the mockup renderer (A1323)', () => {
  it('runs the renderer on stdin from apps/web, on the worktree’s staged mockups', () => {
    const command = renderCommand();
    expect(command).toMatch(
      /^cd 'apps\/web' && node - '\.\.\/\.\.\/\.factory\/mockups' '\.\.\/\.\.\/\.factory\/validation' <<'FACTORY_MOCKUPS'\n/,
    );
    expect(command).toContain(script);
    expect(command.endsWith('\nFACTORY_MOCKUPS')).toBe(true);
  });

  it('quotes the folders it is given', () => {
    expect(renderCommand({ cwd: "/a b/it's", mockups: '/m', out: '/o' })).toMatch(
      /^cd '\/a b\/it'\\''s' && node - '\/m' '\/o' /,
    );
  });

  it('renders headless, at a desktop window or a phone, with a short timeout per step', () => {
    expect(script).toContain('chromium.launch({ headless: true');
    expect(script).toContain('{ width: 1280, height: 800 }');
    expect(script).toContain('{ width: 390, height: 844 }');
    expect(script).toContain('page.setDefaultTimeout(STEP_MS)');
    expect(script).not.toMatch(/headless: false/);
  });

  it("reads the renderer's lines and ignores anything else it printed", () => {
    const out = [
      'Debugger attached.',
      JSON.stringify({ file: 'ac1.html', png: 'ac1-mockup.png', width: 1280, height: 800 }),
      JSON.stringify({ file: 'ac2.html', error: 'Timeout 15000ms exceeded.' }),
      JSON.stringify({ png: 'nameless.png' }),
      '42',
    ].join('\n');
    expect(parseRendered(out)).toEqual([
      { file: 'ac1.html', png: 'ac1-mockup.png', width: 1280, height: 800 },
      { file: 'ac2.html', error: 'Timeout 15000ms exceeded.' },
    ]);
  });

  it('lists each PNG with its size, and says which to render by hand', () => {
    const stdout = [
      JSON.stringify({ file: 'ac1.html', png: 'ac1-mockup.png', width: 390, height: 844 }),
      JSON.stringify({ file: 'ac2.html', error: 'Timeout 15000ms exceeded.' }),
    ].join('\n');
    const text = mockupsText({ exitCode: 0, stdout, stderr: '' });
    expect(text.split('\n')).toEqual([
      '- `ac1-mockup.png`, 390×844, from `ac1.html`.',
      "- `ac2.html` couldn't be rendered (Timeout 15000ms exceeded.). Render it yourself to `ac2-mockup.png`, with a Playwright test in headless Chromium, run with `--timeout=20000`, at the size its page shows.",
    ]);
  });

  it('says when there are none', () => {
    expect(mockupsText({ exitCode: 0, stdout: '', stderr: '' })).toBe(
      'There are none: the plan has no mockups.',
    );
  });

  it("hands the rendering back to the session when the renderer can't run, with the reason", () => {
    const failed = mockupsText({
      exitCode: 1,
      stdout: '',
      stderr: 'warming up\nbrowserType.launch: Executable doesn’t exist\n',
    });
    expect(failed).toContain(
      "The factory couldn't render them (browserType.launch: Executable doesn’t exist).",
    );
    expect(failed).toContain('Render each one yourself to `.factory/validation/<id>-mockup.png`');
    expect(mockupsText(new Error('sandbox closed'))).toContain(
      "The factory couldn't render them (sandbox closed).",
    );
    expect(mockupsText({ exitCode: 2, stdout: '', stderr: '' })).toContain('(exit 2)');
  });
});
