/**
 * Validation's files on the host (F19): the agreed mockups into the sandbox, and the
 * walkthrough's screenshots, the reviewer's verdicts and the fidelity images out of it.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepFiles } from './agent-stream.ts';
import type { HostContext } from './host-context.ts';
import type { HostDeps } from './host.ts';

/** The files validation's sessions read and leave. */
export function validationDeps(
  ctx: HostContext,
): Pick<HostDeps, 'stageMockups' | 'keepValidation' | 'readReview' | 'collectFidelity'> {
  const { options, state, runDir } = ctx;
  return {
    stageMockups: (handle) => {
      // The mockups agreed with the plan (F16), never the session's later edits.
      const issue = options.runId.split('-')[0] ?? '';
      const from = join(state, 'plans', issue, 'agreed-mockups');
      const to = join(handle.worktreePath, '.factory', 'mockups');
      mkdirSync(to, { recursive: true });
      if (existsSync(from))
        for (const f of readdirSync(from).filter((n) => n.endsWith('.html')))
          copyFileSync(join(from, f), join(to, f));
      return Promise.resolve();
    },
    keepValidation: (handle) => {
      // One folder per validation in the run, so a later round doesn't overwrite an earlier one.
      const root = join(runDir, 'validation');
      const n = existsSync(root) ? readdirSync(root).length + 1 : 1;
      keepFiles(join(handle.worktreePath, '.factory', 'validation'), join(root, String(n)));
      return Promise.resolve();
    },
    readReview: (handle) => {
      const path = join(handle.worktreePath, '.factory', 'validation', 'review.json');
      return Promise.resolve(existsSync(path) ? readFileSync(path, 'utf8') : null);
    },
    collectFidelity: (handle, rows) => {
      const dir = join(runDir, 'proof');
      mkdirSync(dir, { recursive: true });
      const from = join(handle.worktreePath, '.factory', 'validation');
      const take = (f: string | undefined) => {
        if (!f || !existsSync(join(from, f))) return undefined;
        const name = `fidelity-${f}`;
        copyFileSync(join(from, f), join(dir, name));
        return name;
      };
      return Promise.resolve(
        rows.map((r) => {
          const { mockup: m, screenshot: s, ...rest } = r;
          const mockup = take(m);
          const screenshot = take(s);
          return { ...rest, ...(mockup ? { mockup } : {}), ...(screenshot ? { screenshot } : {}) };
        }),
      );
    },
  };
}
