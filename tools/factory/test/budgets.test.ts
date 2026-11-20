import { describe, expect, it } from 'vitest';
import { budgetCommand, budgetPackage, changedBudgets } from '../src/budgets.ts';

const PATCH = [
  'diff --git a/packages/core/test/analytics-store.budget.test.ts b/packages/core/test/analytics-store.budget.test.ts',
  'new file mode 100644',
  '+it("prunes", () => {})',
  'diff --git a/packages/core/src/analytics-store.ts b/packages/core/src/analytics-store.ts',
  '+export const x = 1',
  'diff --git a/apps/web/test/unit/note-stats.budget.test.ts b/apps/web/test/unit/note-stats.budget.test.ts',
  '-old',
  '+new',
  'diff --git a/packages/ui/test/graph-render.budget.test.ts b/packages/ui/test/graph-render.budget.test.ts',
  'deleted file mode 100644',
].join('\n');

describe("the gate's budget check (A1651)", () => {
  it('finds the budget files a branch adds or changes, not those it deletes', () => {
    expect(changedBudgets(PATCH)).toEqual([
      'packages/core/test/analytics-store.budget.test.ts',
      'apps/web/test/unit/note-stats.budget.test.ts',
    ]);
    expect(changedBudgets('diff --git a/a.ts b/a.ts\n+x')).toEqual([]);
  });

  it("runs each in its package, as the package's budgets script does, three times", () => {
    expect(budgetPackage('apps/web/test/unit/x.budget.test.ts')).toEqual({
      dir: 'apps/web',
      rel: 'test/unit/x.budget.test.ts',
    });
    const command = budgetCommand(['packages/core/test/a.budget.test.ts']);
    expect(command).toBe(
      `for n in $(seq 3); do echo "budget run $n of 3: packages/core/test/a.budget.test.ts"; (cd 'packages/core' && PENMOSS_BUDGETS=1 pnpm exec vitest run 'test/a.budget.test.ts') || exit 1; done`,
    );
  });
});
