/**
 * The gate's scan for weakened tests (F13, #272; W6: never weaken or skip tests to get to green).
 * It reads the branch's diff and flags added skips, focused tests, fixme/todo markers, disabled
 * JVM tests and loosened runners, and test files that lose more assertions than they gain. A
 * finding passes only when the branch also adds a decision (`docs/decisions.md`) that names the
 * test file, which AGENTS.md requires for any such change.
 */

export interface Finding {
  readonly file: string;
  readonly what: string;
  readonly line?: string;
}

/** Test code: the JS/TS suites, Playwright specs and the Android tests. */
const TEST_FILE =
  /(^|\/)(test|tests|e2e|__tests__|src\/(test|androidTest))\/|\.(test|spec)\.[cm]?[jt]sx?$/;

const ADDED_MARKERS: readonly { re: RegExp; what: string }[] = [
  {
    re: /\b(?:it|test|describe|suite)\.skip(?:If)?\s*\(|\b(?:xit|xtest|xdescribe)\s*\(/,
    what: 'skips a test',
  },
  {
    re: /\b(?:it|test|describe)\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/,
    what: 'focuses a test (the rest stop running)',
  },
  {
    re: /\b(?:test|it)\.(?:fixme|todo|fails)\s*\(|\btest\.fail\s*\(/,
    what: 'marks a test fixme, todo or expected to fail',
  },
  { re: /@(?:Ignore|Disabled)\b/, what: 'disables a JVM test' },
  {
    re: /\bAssume\.assume|assumeTrue\s*\(|assumeFalse\s*\(/,
    what: 'skips a JVM test by assumption',
  },
];

/** Runner settings that let failures through, wherever they're added. */
const LOOSENED: readonly { re: RegExp; what: string }[] = [
  {
    re: /--pass-?[Ww]ith-?[Nn]o-?[Tt]ests|passWithNoTests\s*:\s*true/,
    what: 'lets a suite pass with no tests',
  },
  { re: /\bretries\s*:\s*[1-9]/, what: 'adds retries, which hide flaky failures' },
  { re: /--no-verify\b|\|\|\s*true\b.*\b(?:test|check|lint)\b/, what: 'ignores a failing check' },
];

const ASSERTION = /\b(?:expect|assert\w*|assertThat|verify)\s*[.(]/;

interface FilePatch {
  readonly file: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** A unified diff, per file: its added and removed lines. */
export function parsePatch(patch: string): FilePatch[] {
  const files: { file: string; added: string[]; removed: string[] }[] = [];
  let current: (typeof files)[number] | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const file = /^diff --git a\/.+? b\/(.+)$/.exec(line)?.[1] ?? '';
      current = { file, added: [], removed: [] };
      files.push(current);
    } else if (!current || line.startsWith('+++ ') || line.startsWith('--- ')) {
      continue;
    } else if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }
  return files;
}

const count = (lines: readonly string[], re: RegExp) => lines.filter((l) => re.test(l)).length;

export function scanWeakenedTests(patch: string): Finding[] {
  const files = parsePatch(patch);
  const decisions = files
    .filter((f) => f.file === 'docs/decisions.md')
    .flatMap((f) => f.added)
    .join('\n');
  const justified = (file: string) => {
    const base = file.split('/').at(-1) ?? file;
    return decisions.includes(file) || decisions.includes(base);
  };
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.file === 'docs/decisions.md' || /\.md$/.test(f.file)) continue;
    const isTest = TEST_FILE.test(f.file);
    for (const line of f.added) {
      const code = line.trim();
      // A comment that mentions .skip isn't a skip.
      if (/^(\/\/|\*|#)/.test(code)) continue;
      for (const m of isTest ? ADDED_MARKERS : []) {
        if (m.re.test(code)) findings.push({ file: f.file, what: m.what, line: code });
      }
      for (const m of LOOSENED) {
        if (m.re.test(code)) findings.push({ file: f.file, what: m.what, line: code });
      }
    }
    if (isTest) {
      const lost = count(f.removed, ASSERTION) - count(f.added, ASSERTION);
      if (lost > 0)
        findings.push({
          file: f.file,
          what: `removes ${lost} assertion${lost === 1 ? '' : 's'} more than it adds`,
        });
    }
  }
  return findings.filter((f) => !justified(f.file));
}

/** The gate's feedback to the agent for its findings. */
export function weakenedFeedback(findings: readonly Finding[]): string {
  return [
    'The branch weakens tests, which the repository forbids (W6):',
    '',
    ...findings.map(
      (f) => `- \`${f.file}\` ${f.what}${f.line ? `: \`${f.line.slice(0, 160)}\`` : ''}`,
    ),
    '',
    'Fix the code instead, or restore the tests. If the change really is right, add a decision to `docs/decisions.md` (A-NEW-n) that names the test file and says why.',
  ].join('\n');
}
