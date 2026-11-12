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
  /** The branch adds the file (`new file mode`): no test in it ran before. */
  readonly created: boolean;
}

/**
 * A skip on the operating system alone (`test.skip(!mac, …)`, `it.skipIf(process.platform !==
 * 'darwin')`): a new spec for one platform's behaviour, which CI's other runners can't show.
 * It weakens nothing in a file the branch adds; in an existing one it still counts (A1333).
 */
const PLATFORM_SKIP =
  /\.skip(?:If)?\s*\(\s*!?\s*\(?\s*(?:process\.platform\b|os\.platform\(\)|(?:is|on)?(?:mac|darwin|linux|windows|win32)(?:os)?\b)/i;

/** A unified diff, per file: its added and removed lines. */
export function parsePatch(patch: string): FilePatch[] {
  const files: { file: string; added: string[]; removed: string[]; created: boolean }[] = [];
  let current: (typeof files)[number] | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const file = /^diff --git a\/.+? b\/(.+)$/.exec(line)?.[1] ?? '';
      current = { file, added: [], removed: [], created: false };
      files.push(current);
    } else if (current && line.startsWith('new file mode ')) {
      current.created = true;
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
        if (m === ADDED_MARKERS[0] && f.created && PLATFORM_SKIP.test(code)) continue;
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

/** GitHub Actions' workflows: the factory's GitHub App can't push a change to them (A1222). */
const WORKFLOWS = '.github/workflows/';

/**
 * The files under `.github/workflows/` a branch's diff changes, adds, deletes or renames (either
 * side of a rename). GitHub refuses the factory's push of any of them (`refusing to allow a GitHub
 * App to create or update workflow`), so the gate refuses the branch first (A1314): PEN-73's CI
 * repair added a retry loop to `ci.yml`, and the run failed late, at the push.
 */
export function workflowChanges(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!m) continue;
    for (const path of [m[1]!, m[2]!]) if (path.startsWith(WORKFLOWS)) files.add(path);
  }
  return [...files];
}

/** The gate's feedback to the agent for a branch that changes the workflows. */
export function workflowFeedback(files: readonly string[]): string {
  return [
    `The branch changes GitHub Actions' workflows (${files.map((f) => `\`${f}\``).join(', ')}), which the factory can't push: its GitHub App has no workflows permission, so GitHub would refuse the push.`,
    '',
    `Put \`${WORKFLOWS}\` back as \`origin/main\` has it (\`git diff origin/main...HEAD -- ${WORKFLOWS}\` shows what to undo) and commit. Fix the cause in the code instead. A failure in the runner's network or a hosted service isn't this branch's to fix: change nothing, and write \`result.json\` with status \`failed\` and the log lines that show it. A workflow change is Ryan's to make.`,
  ].join('\n');
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
