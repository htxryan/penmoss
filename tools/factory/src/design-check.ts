/**
 * The factory's design check (A1649), run on the planning session's output before each
 * revision goes to Ryan. PEN-137's plan reached him with mockups in sentence case, Mac and
 * Android drawn differently, Settings drawn as it was before three merges, and a destructive
 * action without a confirmation; Ryan found each by eye. Two parts:
 *
 * - **The mockups' labels** (deterministic): every button, tab, menu item, heading, legend,
 *   summary, table heading and field label in `out/mockups/*.html` in the app's Title Case
 *   (sandbox/title-case.cjs, the same rule the validator's UI audit applies to the built app).
 * - **The session's self-review** (`state.json`'s `review`): a fresh-context reviewer's verdict
 *   on each item of the planning prompt's checklist, made against the snapshot of main the
 *   session has now. A missing item, a failing one, or a review of an older main is a problem.
 *
 * Problems go back to the session, twice at most for one round with Ryan, then to Ryan beside
 * its open points.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { PlanReview } from './planning.ts';

const require = createRequire(import.meta.url);
const { titleCaseProblem } = require('../sandbox/title-case.cjs') as {
  titleCaseProblem: (
    text: string,
  ) => { text: string; words: readonly string[]; suggestion: string } | null;
};

/**
 * The self-review's checklist (the planning prompt's "Before you post"), each by the id the
 * session records it under.
 */
export const REVIEW_CHECKS = {
  main: 'drawn against the snapshot of main as it is now: the current screens, navigation, names and paths',
  chrome: "the app's real chrome: its navigation, groups, icons and page names as main has them",
  'title-case':
    'Title Case for every title, button, tab, menu item, legend, field label, status word and confirmation title',
  parity:
    'every platform in scope drawn, with the same structure, controls and words (but "this Mac" / "this phone")',
  destructive:
    'every action that deletes or loses data asks first, in the app’s confirm style, and is drawn',
  choices: 'answers offered side by side are equal in size and weight unless the plan says why',
  coverage:
    'every acceptance criterion that changes what someone sees has its mockup, one per platform it names',
  reuse: "each screen uses the app's existing components and flows, named in the plan",
  analytics:
    'every new control, screen, dialog, setting, CLI command and MCP tool is recorded by name on each client',
} as const;

export type ReviewCheck = keyof typeof REVIEW_CHECKS;

/** At most this many label findings are listed; the rest are counted. */
const MAX_LABELS = 20;

/** Elements whose text is a title in the app's sense. */
const TITLED =
  /<(button|h[1-6]|legend|summary|th|label|dt)\b[^>]*>([\s\S]*?)<\/\1>|<(\w+)\b[^>]*\brole\s*=\s*["']?(?:button|tab|menuitem|heading)\b[^>]*>([\s\S]*?)<\/\3>/gi;

/** A hint, description or other sentence nested in a label: not part of the title. */
const NESTED_HINT =
  /<(small|p|div|span)\b[^>]*class\s*=\s*["'][^"']*(?:hint|desc|sub|help|note|muted|secondary|caption|detail)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  rarr: '→',
};

function decode(text: string): string {
  return text.replaceAll(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X'))
      return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The titles a mockup shows: each titled element's own first line of text. */
export function mockupTitles(html: string): string[] {
  const body = html
    .replaceAll(/<(script|style|svg|code|kbd|pre)\b[\s\S]*?<\/\1>/gi, ' ')
    .replaceAll(/<!--[\s\S]*?-->/g, ' ');
  const titles: string[] = [];
  for (const m of body.matchAll(TITLED)) {
    const inner = (m[2] ?? m[4] ?? '')
      .replaceAll(NESTED_HINT, ' ')
      .replaceAll(/<(input|select|textarea)\b[^>]*>/gi, ' ');
    const first = inner.split(/<br\s*\/?>|<\/?(?:p|div)\b[^>]*>/i)[0] ?? '';
    const text = decode(first.replaceAll(/<[^>]+>/g, ' '))
      .replaceAll(/\s+/g, ' ')
      .trim();
    if (text) titles.push(text);
  }
  return titles;
}

/** Each mockup label not in Title Case, as "file: what it says → what it should say". */
export function mockupLabelProblems(
  mockups: readonly { readonly file: string; readonly html: string }[],
  exceptions: readonly string[] = [],
): string[] {
  const allowed = new Set(exceptions.map((e) => e.trim()));
  const seen = new Set<string>();
  const found: string[] = [];
  for (const { file, html } of mockups) {
    for (const title of mockupTitles(html)) {
      if (allowed.has(title)) continue;
      const problem = titleCaseProblem(title);
      if (!problem || seen.has(problem.text)) continue;
      seen.add(problem.text);
      found.push(`${file}: "${problem.text}" should read "${problem.suggestion}"`);
    }
  }
  if (found.length <= MAX_LABELS) return found;
  return [...found.slice(0, MAX_LABELS), `…and ${found.length - MAX_LABELS} more`];
}

/** The self-review's problems: missing, against an older main, or with a failing item. */
export function reviewProblems(review: PlanReview | null, main: string | undefined): string[] {
  if (!review)
    return [
      `state.json has no "review": run the self-review in the planning prompt ("Before you post") with a fresh reviewer, and record each item (${Object.keys(REVIEW_CHECKS).join(', ')})`,
    ];
  const problems: string[] = [];
  if (main && !sameCommit(review.main, main))
    problems.push(
      `the self-review was made against main ${review.main ? review.main.slice(0, 10) : '(none named)'}, but the snapshot is main ${main.slice(0, 10)} (its \`.factory-main\`): check the design against the snapshot as it is now and review again`,
    );
  for (const [id, what] of Object.entries(REVIEW_CHECKS)) {
    const item = review.checks[id];
    if (!item) problems.push(`the self-review has no "${id}" item (${what})`);
    else if (!item.ok)
      problems.push(`the self-review found "${id}" not met: ${item.note || what}. Fix it`);
  }
  return problems;
}

/** Two commit ids name the same commit: one is a prefix of the other, seven characters or more. */
function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** The mockups the session saved, as HTML. */
export function readMockups(out: string): { file: string; html: string }[] {
  const dir = join(out, 'mockups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((file) => ({ file, html: readFileSync(join(dir, file), 'utf8') }));
}

/**
 * Everything the design check finds in a revision. A plan with no design and no mockups (a
 * change no one sees) has nothing to check.
 */
export function designProblems(input: {
  readonly designUrl: string | null;
  readonly review: PlanReview | null;
  readonly mockups: readonly { readonly file: string; readonly html: string }[];
  /** The commit the session's snapshot is of, when known. */
  readonly main: string | undefined;
}): string[] {
  if (!input.designUrl && input.mockups.length === 0) return [];
  return [
    ...reviewProblems(input.review, input.main),
    ...mockupLabelProblems(input.mockups, input.review?.titleCaseExceptions ?? []).map(
      (p) => `a mockup label isn't in Title Case: ${p}`,
    ),
  ];
}
