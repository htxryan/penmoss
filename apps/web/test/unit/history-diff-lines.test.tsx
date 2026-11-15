// @vitest-environment happy-dom
import type { DiffOp } from '@penmoss/core/diff';
import { act, useCallback, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useFit } from '../../src/history/fit';
import { diffRows } from '../../src/history/diff-rows';
import { DiffLines } from '../../src/history/parts';

// History's docked preview (Ryan's review of #193): line numbers in a gutter (R2-13), and the
// actions shortened step by step to stay on one line (R2-12).

const same = (line: string): DiffOp => ({ op: 'same', line });

/** Twenty unchanged lines, line 11 replaced, and a line added at the end. */
const diff: DiffOp[] = [
  ...Array.from({ length: 10 }, (_, i) => same(`a${i + 1}`)),
  { op: 'del', line: 'old 11' },
  { op: 'add', line: 'new 11' },
  ...Array.from({ length: 9 }, (_, i) => same(`a${i + 12}`)),
  { op: 'add', line: 'last' },
];

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

describe('History’s diff numbers its lines (R2-13)', () => {
  it('numbers this version’s lines, a removed one by the version before, on across folds', () => {
    const rows = diffRows(diff);
    expect(
      rows.map((row) => (row.op === 'fold' ? `fold ${row.from}–${row.to}` : `${row.op} ${row.n}`)),
    ).toEqual([
      'fold 1–8',
      'same 9',
      'same 10',
      'del 11',
      'add 11',
      'same 12',
      'same 13',
      'fold 14–18',
      'same 19',
      'same 20',
      'add 21',
    ]);
  });

  it('draws the numbers from data-n, out of the text that is selected and copied', () => {
    const container = mount(<DiffLines diff={diff} numbered />);
    const pre = container.querySelector('pre')!;
    expect(pre.hasAttribute('data-numbered')).toBe(true);
    expect(pre.style.getPropertyValue('--diff-digits')).toBe('2');
    const gutters = [...pre.querySelectorAll<HTMLElement>('.diff-num')];
    expect(gutters.map((g) => g.dataset['n'])).toEqual([
      '9',
      '10',
      '11',
      '11',
      '12',
      '13',
      '19',
      '20',
      '21',
    ]);
    expect(
      gutters.every((g) => g.textContent === '' && g.getAttribute('aria-hidden') === 'true'),
    ).toBe(true);
    // The folds name the lines they hold, from data-n too.
    expect(
      [...pre.querySelectorAll<HTMLElement>('.diff-fold-lines')].map((f) => f.dataset['n']),
    ).toEqual(['1–8', '14–18']);
    // The text is the lines and their marks only.
    expect(pre.textContent).not.toMatch(/\b(9|19|21)\b/);
    expect(pre.querySelector('.diff-del')!.textContent).toBe('−old 11\n');
  });

  it('leaves the Time Machine’s diff unnumbered', () => {
    const container = mount(<DiffLines diff={diff} />);
    expect(container.querySelector('pre')!.hasAttribute('data-numbered')).toBe(false);
    expect(container.querySelector('.diff-num, .diff-fold-lines')).toBeNull();
  });
});

describe('useFit shortens a row step by step to keep it on one line (R2-12)', () => {
  /** A row whose content is `widths[step]` wide in a box `box.width` wide. */
  function Row({ widths, box }: { widths: number[]; box: { width: number } }) {
    const [fit, ref] = useFit(widths.length - 1, 'buttons');
    const [, rerender] = useState(0);
    const measured = useCallback(
      (row: HTMLDivElement | null) => {
        if (row) {
          Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => box.width });
          Object.defineProperty(row, 'scrollWidth', {
            configurable: true,
            get: () => Math.max(box.width, widths[Number(row.dataset['fit'])]!),
          });
        }
        ref(row);
      },
      [ref, box, widths],
    );
    // A click stands in for the observer's call: the row is laid out again.
    return <div data-fit={fit} ref={measured} onClick={() => rerender((n) => n + 1)} />;
  }

  it('takes the steps it needs, and steps back when there is room again', () => {
    const box = { width: 400 };
    const container = mount(<Row widths={[300, 220, 120]} box={box} />);
    const row = () => container.querySelector<HTMLElement>('[data-fit]')!;
    expect(row().dataset['fit']).toBe('0');
    box.width = 250;
    act(() => row().click());
    expect(row().dataset['fit']).toBe('1');
    box.width = 150;
    act(() => row().click());
    expect(row().dataset['fit']).toBe('2');
    // Wide enough for step 1 again, not yet for the full row.
    box.width = 260;
    act(() => row().click());
    expect(row().dataset['fit']).toBe('1');
    box.width = 320;
    act(() => row().click());
    expect(row().dataset['fit']).toBe('0');
  });
});
