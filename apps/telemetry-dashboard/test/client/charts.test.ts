// @vitest-environment happy-dom
// A line chart keeps every series visible where two share values (PEN-170): earlier series are
// drawn wider, so a later one on top leaves an edge of each showing.
import { describe, expect, it } from 'vitest';
import { lineChart } from '../../src/client/charts';

describe('lineChart', () => {
  it('draws earlier series wider than later ones', () => {
    const chart = lineChart(
      {
        label: 'Weekly active installs',
        categories: ['2026-11-19', '2026-11-20'],
        series: [
          { key: 'mac', label: 'Mac', color: '#3b82f6', values: [0, 1] },
          { key: 'cli', label: 'CLI', color: '#f97316', values: [0, 1] },
        ],
      },
      600,
    );
    const widths = [...chart.querySelectorAll('path.line')].map((path) =>
      Number(path.getAttribute('stroke-width')),
    );
    expect(widths).toEqual([5, 2]);
  });
});
