/**
 * The page's third-party notices (A1568): what the app ships under another licence, each
 * licence as its package has it now, so an update that changes one fails here until the notice
 * follows. The Characters' notice is the one Android ships beside their file.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const at = (path: string) => new URL(path, import.meta.url);
const notices = readFileSync(at('../../public/third-party-notices.txt'), 'utf8');
/** A package's licence file, from the web app's own node_modules. */
const licence = (name: string) =>
  readFileSync(at(`../../node_modules/${name}/LICENSE`), 'utf8').trim();

describe('third-party-notices.txt', () => {
  it('holds Lucide’s licence, with the Feather icons’ MIT notice, as its packages have it', () => {
    expect(notices).toContain(licence('lucide-static'));
    expect(licence('@lucide/icons')).toBe(licence('lucide-static'));
    expect(notices).toContain('derived from the Feather project');
  });

  it('holds the Characters’ notice word for word: emojibase-data’s licence and Unicode’s', () => {
    const data = readFileSync(at('../../../../packages/core/data/NOTICE.txt'), 'utf8');
    expect(notices).toContain(data.trim());
    const emojibase = createRequire(at('../../../../package.json'));
    expect(data).toContain(
      readFileSync(emojibase.resolve('emojibase-data/LICENSE'), 'utf8').trim(),
    );
    expect(data).toContain('UNICODE LICENSE V3');
  });

  it('names the versions the app depends on', () => {
    const web = JSON.parse(readFileSync(at('../../package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(notices).toContain(`Lucide ${web.dependencies['lucide-static']} `);
    expect(web.dependencies['@lucide/icons']).toBe(web.dependencies['lucide-static']);
  });
});
