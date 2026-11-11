/**
 * The agreed mockups, rendered to PNG by the host before validation's capture session starts
 * (PEN-63's validation, A1323). The session used to render them itself, and spent minutes on a
 * hand-written renderer that hung. The renderer (sandbox/render-mockups.cjs) runs in the gate's
 * sandbox with the repository's own Playwright and headless Chromium; the session is told which
 * PNGs are there, at what size, and renders only what the factory couldn't.
 */
import { readFileSync } from 'node:fs';
import type { RunSandbox } from './run.ts';

/** Where the host stages the agreed mockups in the worktree (stageMockups). */
export const MOCKUPS_DIR = '.factory/mockups';
/** Where validation's captures go, the mockups' PNGs among them. */
export const VALIDATION_DIR = '.factory/validation';

const SCRIPT = readFileSync(new URL('../sandbox/render-mockups.cjs', import.meta.url), 'utf8');
const EOF = 'FACTORY_MOCKUPS';

/**
 * The shell command that renders the mockups: Node reads the renderer on stdin from `cwd`
 * (`apps/web` in a worktree), so its `require('@playwright/test')` resolves there. The folders are
 * relative to `cwd`, or absolute.
 */
export function renderCommand(
  options: { cwd?: string; mockups?: string; out?: string } = {},
): string {
  const {
    cwd = 'apps/web',
    mockups = `../../${MOCKUPS_DIR}`,
    out = `../../${VALIDATION_DIR}`,
  } = options;
  return `cd ${quote(cwd)} && node - ${quote(mockups)} ${quote(out)} <<'${EOF}'\n${SCRIPT}\n${EOF}`;
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export type Rendered =
  | { readonly file: string; readonly png: string; readonly width: number; readonly height: number }
  | { readonly file: string; readonly error: string };

/** The renderer's JSON lines; anything else it printed is ignored. */
export function parseRendered(stdout: string): Rendered[] {
  const rows: Rendered[] = [];
  for (const line of stdout.split('\n')) {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    if (typeof r['file'] !== 'string') continue;
    if (typeof r['error'] === 'string') rows.push({ file: r['file'], error: r['error'] });
    else if (
      typeof r['png'] === 'string' &&
      typeof r['width'] === 'number' &&
      typeof r['height'] === 'number'
    )
      rows.push({ file: r['file'], png: r['png'], width: r['width'], height: r['height'] });
  }
  return rows;
}

const YOURSELF =
  'with a Playwright test in headless Chromium, run with `--timeout=20000`, at the size its page shows';

/** What validation's prompt says about the mockups (`{{mockups}}`). */
export function mockupsText(
  ran: { readonly exitCode: number; readonly stdout: string; readonly stderr: string } | Error,
): string {
  if (ran instanceof Error || ran.exitCode !== 0) {
    const reason =
      ran instanceof Error
        ? ran.message
        : (ran.stderr.trim().split('\n').at(-1) ?? '') || `exit ${ran.exitCode}`;
    return `The factory couldn't render them (${reason}). Render each one yourself to \`${VALIDATION_DIR}/<id>-mockup.png\`, ${YOURSELF}.`;
  }
  const rows = parseRendered(ran.stdout);
  if (rows.length === 0) return 'There are none: the plan has no mockups.';
  return rows
    .map((r) =>
      'png' in r
        ? `- \`${r.png}\`, ${r.width}×${r.height}, from \`${r.file}\`.`
        : `- \`${r.file}\` couldn't be rendered (${r.error}). Render it yourself to \`${r.file.replace(/\.html$/, '')}-mockup.png\`, ${YOURSELF}.`,
    )
    .join('\n');
}

/** Renders the staged mockups in the sandbox; never fails validation, only says what it did. */
export async function renderMockups(sandbox: RunSandbox): Promise<string> {
  const ran = await sandbox
    .exec(renderCommand())
    .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  return mockupsText(ran);
}
