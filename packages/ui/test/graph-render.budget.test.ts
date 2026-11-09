// A wall-clock budget (A1244): `task budgets` runs it, never
// `task check`. What the layout and renderer draw is a unit test (graph-render.test.ts).
import { describe, expect, it } from 'vitest';
import { createLayout } from '../src/graph/layout';
import { buildGraph, syntheticGraph } from '../src/graph/model';
import { drawGraph, fitTransform } from '../src/graph/renderer';
import { FALLBACK_THEME } from '../src/graph/theme';
import { recorder, state } from './support/graph';

describe('performance (2,000 notes, 5,000 links)', () => {
  it('steps the layout and draws a frame within the 30 fps budget', () => {
    const data = buildGraph(syntheticGraph(2000, 5000, 3), { kind: 'global' });
    const layout = createLayout(data);
    layout.settle(5);
    const { ctx } = recorder();
    const groups = [...new Set(data.nodes.map((node) => node.group))];
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      layout.tick();
      const t = fitTransform(layout.nodes, 1200, 800);
      drawGraph(
        ctx,
        { width: 1200, height: 800, ratio: 1 },
        layout.nodes,
        layout.links,
        groups,
        FALLBACK_THEME,
        state({ transform: t }),
      );
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    // 33 ms per frame is 30 fps; the real canvas is measured in e2e (graph.spec.ts).
    expect(median).toBeLessThan(33);
  });
});
