/** The plan's open points as the page asks them, each with its one-click answers (F21). */
import type { PlanQuestion } from '../planning.ts';
import type { Point } from './view.ts';

const PROPOSED = /\s*\((?:proposed|recommended)\)\s*$/i;

/**
 * The plan's open points as the page asks them. The planner lists every point in `open`, and
 * those with a few clear answers again in `questions` (prompts/planning.md), so the same count
 * pairs them by position: the open point becomes its question's context. Otherwise a question
 * that repeats its point word for word pairs with it and the other points are asked without
 * buttons; when that doesn't account for every point, they're shown once, as notes.
 */
export function pointsOf(
  open: readonly string[],
  questions: readonly PlanQuestion[],
): { points: Point[]; notes: string[] } {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const ask = (q: PlanQuestion, context: string | null): Point => {
    const tagged = q.options.some((o) => PROPOSED.test(o));
    return {
      text: q.text,
      context: context && !same(context, q.text) ? context : null,
      // The proposal comes first (prompts/planning.md) when none is marked.
      options: q.options.map((o, i) => ({
        value: o,
        label: o.replace(PROPOSED, ''),
        proposed: tagged ? PROPOSED.test(o) : i === 0,
      })),
    };
  };
  if (questions.length && open.length === questions.length)
    return { points: questions.map((q, i) => ask(q, open[i] ?? null)), notes: [] };
  const rest = open.filter((o) => !questions.some((q) => same(o, q.text)));
  const asked = questions.map((q) => ask(q, null));
  if (rest.length + questions.length === open.length)
    return {
      points: [...asked, ...rest.map((o) => ({ text: o, context: null, options: [] }))],
      notes: [],
    };
  return { points: asked, notes: rest };
}
