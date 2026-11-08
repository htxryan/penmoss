import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCodec } from '../src/clipboard/markdown';
import { sanitizeClipboardHTML } from '../src/clipboard/sanitize';
import { markdownOf, paste } from './support/clipboard';
import { openEditor } from './support/editor';

// Clipboard payloads from the apps people paste from, written to match what each
// app puts on the clipboard (T15). `<name>.html` is text/html; `<name>.txt` and
// `<name>.vscode-editor-data.json` are the other entries when the app writes them;
// `<name>.expected.md` is the note the paste must produce, through the core codec.

const dir = join(dirname(fileURLToPath(import.meta.url)), 'clipboard-fixtures');
const read = (file: string) =>
  existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : '';
const fixtures = readdirSync(dir)
  .filter((file) => file.endsWith('.html'))
  .map((file) => file.slice(0, -'.html'.length));

beforeAll(async () => {
  await loadCodec();
});

describe('clipboard fixtures', () => {
  it('covers every source the plan names', () => {
    expect(fixtures).toEqual(
      expect.arrayContaining([
        'google-docs',
        'notion',
        'apple-notes',
        'safari',
        'web-page',
        'vscode',
        'slack',
        'word',
      ]),
    );
  });

  describe.each(fixtures)('%s', (name) => {
    const entries = () => ({
      'text/html': read(`${name}.html`),
      'text/plain': read(`${name}.txt`),
      'vscode-editor-data': read(`${name}.vscode-editor-data.json`),
    });

    it('pastes as clean blocks', () => {
      const collab = openEditor();
      const event = paste(collab, entries());
      expect(event.defaultPrevented).toBe(true);
      expect(markdownOf(collab)).toBe(read(`${name}.expected.md`));
    });

    it('keeps no styles, scripts, handlers or unsafe addresses in the HTML it parses', () => {
      const { html } = sanitizeClipboardHTML(read(`${name}.html`), new DOMParser());
      expect(html).not.toMatch(/\sstyle=|\sclass=(?!"language-)|\son\w+=/i);
      expect(html).not.toMatch(/<(script|style|iframe|object|embed|svg|form|input|button)\b/i);
      expect(html).not.toMatch(/javascript:|data:text|file:|tracker|beacon/i);
    });
  });
});
