import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * F17, FD24: production deploys happen after merge, never from a run. Every repo command that
 * runs `wrangler deploy` checks `PENMOSS_FACTORY_RUN` (which every sandbox sets) before it, so
 * `task site:deploy` or `pnpm run deploy` inside a run stops before it reaches Cloudflare.
 */
const root = join(import.meta.dirname, '../../..');
const DEPLOY = /\bwrangler\s+deploy\b/;
const GUARD = /test -z "?\$PENMOSS_FACTORY_RUN"?/;

/** Each task in the Taskfile, as its own block of lines. */
function taskBlocks(taskfile: string): { name: string; lines: string[] }[] {
  const blocks: { name: string; lines: string[] }[] = [];
  for (const line of taskfile.split('\n')) {
    const name = /^ {2}([\w:-]+):\s*$/.exec(line)?.[1];
    if (name) blocks.push({ name, lines: [] });
    else blocks.at(-1)?.lines.push(line);
  }
  return blocks;
}

describe('no production deploy from a factory run (F17, FD24)', () => {
  it('guards every Taskfile task that runs wrangler deploy, before anything else runs', () => {
    const blocks = taskBlocks(readFileSync(join(root, 'Taskfile.yml'), 'utf8')).filter((b) =>
      b.lines.some((l) => DEPLOY.test(l) && !/^\s*desc:/.test(l)),
    );
    expect(blocks.map((b) => b.name)).toContain('site:deploy');
    for (const { name, lines } of blocks) {
      // deps run before cmds, so a guarded task has none: it calls its build after the guard.
      expect(
        lines.some((l) => /^\s*deps:/.test(l)),
        `${name} has deps, which run before its guard`,
      ).toBe(false);
      const cmds = lines.filter((l) => /^\s*- /.test(l));
      const guard = cmds.findIndex((l) => GUARD.test(l));
      expect(guard, `${name} runs wrangler deploy without checking PENMOSS_FACTORY_RUN`).toBe(0);
    }
  });

  it('guards every package script that runs wrangler deploy', () => {
    const packages = ['apps', 'packages', 'tools']
      .flatMap((dir) =>
        readdirSync(join(root, dir), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(dir, e.name, 'package.json')),
      )
      .concat(['site/package.json', 'package.json']);
    let deploys = 0;
    for (const file of packages) {
      let scripts: Record<string, string>;
      try {
        scripts =
          (
            JSON.parse(readFileSync(join(root, file), 'utf8')) as {
              scripts?: Record<string, string>;
            }
          ).scripts ?? {};
      } catch {
        continue;
      }
      for (const [name, script] of Object.entries(scripts)) {
        const at = script.search(DEPLOY);
        if (at < 0) continue;
        deploys++;
        const guard = script.search(GUARD);
        expect(guard >= 0 && guard < at, `${file} "${name}" deploys without the guard`).toBe(true);
      }
    }
    expect(deploys).toBeGreaterThan(0);
  });
});
