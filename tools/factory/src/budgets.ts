/**
 * The gate's budget check (A1651). `task check` never runs the wall-clock budgets
 * (`*.budget.test.ts`, A1244), so a budget a branch added met CI's hosted runner for the first
 * time after the PR opened: PEN-137's prune budget failed there on one 266 ms batch, and the two
 * repair rounds went on it. Now the gate runs each budget file the branch adds or changes
 * `BUDGET_RUNS` times, one after another, and refuses the branch unless every run passes. A
 * budget that passes three times in a row here can still be tight for a runner several times
 * slower; the build prompt asks for medians or percentiles with room for that.
 */
/** One shell word. */
const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** How many times in a row each changed budget file must pass. */
export const BUDGET_RUNS = 3;

const BUDGET = /\.budget\.test\.[cm]?[jt]sx?$/;

/** The budget files a branch's diff adds or changes (not those it deletes). */
export function changedBudgets(patch: string): string[] {
  const files: string[] = [];
  let current: string | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = /^diff --git a\/.+? b\/(.+)$/.exec(line)?.[1];
      if (current && BUDGET.test(current)) files.push(current);
      else current = undefined;
    } else if (current && line.startsWith('deleted file mode ')) {
      files.splice(files.indexOf(current), 1);
      current = undefined;
    }
  }
  return [...new Set(files)];
}

/** A budget file's package folder and its path inside it: `packages/core`, `test/x.budget.test.ts`. */
export function budgetPackage(file: string): { dir: string; rel: string } | undefined {
  const m = /^(.*?)\/((?:test|tests|__tests__|src)\/.+)$/.exec(file);
  return m ? { dir: m[1]!, rel: m[2]! } : undefined;
}

/**
 * The shell command that runs each budget file `runs` times in its package, as the package's own
 * `budgets` script does (`PENMOSS_BUDGETS=1 vitest run`), stopping at the first failure.
 */
export function budgetCommand(files: readonly string[], runs = BUDGET_RUNS): string {
  const steps = files.flatMap((file) => {
    const where = budgetPackage(file);
    if (!where) return [];
    const run = `(cd ${shellQuote(where.dir)} && PENMOSS_BUDGETS=1 pnpm exec vitest run ${shellQuote(where.rel)})`;
    return [
      `for n in $(seq ${runs}); do echo "budget run $n of ${runs}: ${file}"; ${run} || exit 1; done`,
    ];
  });
  return steps.join(' && ');
}

/** What the agent hears when a budget fails one of its runs. */
export function budgetFeedback(files: readonly string[], output: string): string {
  return [
    `The gate ran the performance budgets this branch adds or changes (${files.map((f) => `\`${f}\``).join(', ')}) ${BUDGET_RUNS} times each, as CI's budgets job runs them, and a run failed:`,
    '',
    '```',
    output,
    '```',
    '',
    "CI's hosted runners are several times slower than this Mac and vary between runs. Make the budget hold there: measure over many samples and assert on a median or a high percentile with room for a slow runner, not on one sample or the slowest one, or make the code faster. Don't loosen a budget that guards something people feel without saying why in a decision.",
  ].join('\n');
}
