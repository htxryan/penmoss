import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * How far a row of buttons is shortened to stay on one line (Ryan's review of #193, R2-12): 0 is
 * as drawn, and each step up a shorter layout (the caller's CSS says what each step hides), to
 * `most`. Measured on the row itself, not the window: History's panel is resizable.
 *
 * The row must not wrap (`flex-wrap: nowrap`), so a row too narrow overflows; a step is taken
 * while it does. The width each step needed is kept, and the row steps back once it is that wide
 * again. `key` names the set of buttons (one more or fewer): a new set is measured afresh.
 *
 * Returns the step and the ref for the row.
 */
export function useFit(most: number, key: unknown): [number, (row: HTMLElement | null) => void] {
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [fit, setFit] = useState(0);
  const level = useRef(0);
  /** The row's width at each step, measured when it overflowed there. */
  const needs = useRef<number[]>([]);

  const check = useCallback(() => {
    // Not laid out (a hidden tab, a test without layout): nothing to measure.
    if (!row || row.clientWidth === 0) return;
    const at = level.current;
    let next = at;
    if (row.scrollWidth > row.clientWidth && at < most) {
      needs.current[at] = row.scrollWidth;
      next = at + 1;
    } else if (at > 0 && row.clientWidth >= (needs.current[at - 1] ?? Infinity)) {
      next = at - 1;
    }
    if (next === at) return;
    level.current = next;
    setFit(next);
  }, [row, most]);

  // Another set of buttons: from the full layout again, before it is drawn.
  useLayoutEffect(() => {
    needs.current = [];
    level.current = 0;
    setFit(0);
  }, [key]);

  // After each render, before it is drawn: a step that still overflows takes the next.
  useLayoutEffect(check);

  useEffect(() => {
    if (!row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(row);
    return () => observer.disconnect();
  }, [row, check]);

  return [fit, setRow];
}
