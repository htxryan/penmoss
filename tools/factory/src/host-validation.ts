/**
 * Validation's files on the host (F19): the agreed mockups into the sandbox, and the
 * walkthrough's screenshots, the reviewer's verdicts and the fidelity images out of it.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AttachedProof } from './proof/body.ts';
import { extractFrames } from './proof/media.ts';
import { keepFiles } from './agent-stream.ts';
import type { HostContext } from './host-context.ts';
import type { HostDeps } from './host.ts';

/** The files validation's sessions read and leave. */
export function validationDeps(
  ctx: HostContext,
): Pick<
  HostDeps,
  | 'stageMockups'
  | 'keepValidation'
  | 'readReview'
  | 'collectFidelity'
  | 'readCaptures'
  | 'stageProof'
> {
  const { options, state, runDir, exec } = ctx;
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
      // The UI audit the validator runs beside each capture (A1650), with its Title Case rule.
      for (const f of AUDIT_FILES)
        copyFileSync(join(SANDBOX_DIR, f), join(handle.worktreePath, '.factory', f));
      return Promise.resolve();
    },
    readCaptures: (handle) => {
      const path = join(handle.worktreePath, '.factory', 'validation', 'captures.json');
      return Promise.resolve(existsSync(path) ? readFileSync(path, 'utf8') : null);
    },
    stageProof: (handle, proof) =>
      stageProof(exec, join(runDir, 'proof'), handle.worktreePath, proof),
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

/** The factory's own scripts the sandbox gets (sandbox/). */
const SANDBOX_DIR = fileURLToPath(new URL('../sandbox/', import.meta.url));
/** The UI audit and the Title Case rule it requires, staged in the worktree's `.factory/`. */
export const AUDIT_FILES = ['ui-audit.cjs', 'title-case.cjs'] as const;

/**
 * The proof, as the reviewer sees it (A1650): each recording's last screenshot and stills
 * through its video, in `.factory/validation/` as `proof-<platform>-<n>-last.png` and
 * `-f<k>.png`. Returns the list the reviewer's prompt shows: each proof's title and its files.
 */
export async function stageProof(
  exec: HostContext['exec'],
  from: string,
  worktree: string,
  proof: readonly AttachedProof[],
): Promise<string> {
  const to = join(worktree, '.factory', 'validation');
  mkdirSync(to, { recursive: true });
  const lines: string[] = [];
  for (const p of proof.filter((x) => x.phase === 'after')) {
    const base = `proof-${(p.image ?? p.video ?? 'x').replace(/\.(png|mp4)$/, '')}`;
    const files: string[] = [];
    if (p.video && existsSync(join(from, p.video))) {
      try {
        files.push(...(await extractFrames(exec, join(from, p.video), to, base)));
      } catch {
        // No stills: the reviewer has the last screenshot.
      }
    }
    if (p.image && existsSync(join(from, p.image))) {
      copyFileSync(join(from, p.image), join(to, `${base}-last.png`));
      files.push(`${base}-last.png`);
    }
    lines.push(
      `- **${p.label}**: ${files.length > 0 ? files.map((f) => `\`${f}\``).join(', ') : 'no image or recording'}`,
    );
  }
  return lines.join('\n');
}
