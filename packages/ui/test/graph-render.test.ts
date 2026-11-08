import { describe, expect, it } from 'vitest';
import { createLayout, type LayoutNode } from '../src/graph/layout';
import { buildGraph, syntheticGraph, type GraphNoteInput } from '../src/graph/model';
import {
  colourOf,
  drawGraph,
  fitTransform,
  labelled,
  nodeAt,
  nodeInDirection,
  type Context2D,
  type DrawState,
} from '../src/graph/renderer';
import { FALLBACK_THEME } from '../src/graph/theme';

/** A 2D context that records calls (canvas is not available in Node). */
function recorder() {
  const calls: string[] = [];
  const texts: string[] = [];
  const props: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineJoin: 'miter',
  };
  const ctx = new Proxy(props, {
    get(target, key: string): unknown {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push(key);
        if (key === 'fillText') texts.push(String(args[0]));
        return key === 'measureText' ? { width: 10 } : undefined;
      };
    },
    set(target, key: string, value: unknown) {
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as Context2D, calls, texts };
}

const state = (over: Partial<DrawState> = {}): DrawState => ({
  transform: { x: 0, y: 0, k: 1 },
  hovered: null,
  focused: null,
  centre: null,
  neighbours: null,
  ...over,
});

const at = (id: string, x: number, y: number, degree = 1): LayoutNode => ({
  node: { id, label: id, kind: 'note', group: null, degree },
  radius: 5,
  x,
  y,
});

describe('layout', () => {
  const notes: GraphNoteInput[] = [
    { id: 'a', title: 'A', group: null, tags: [], links: ['b', 'c'] },
    { id: 'b', title: 'B', group: null, tags: [], links: ['c'] },
    { id: 'c', title: 'C', group: null, tags: [], links: [] },
    { id: 'd', title: 'D', group: null, tags: [], links: [] },
  ];

  it('settles, keeps linked notes closer than unlinked ones, and pins the centre', () => {
    const layout = createLayout(buildGraph(notes, { kind: 'global' }), 'a');
    layout.settle(400);
    expect(layout.tick()).toBe(false);
    const [a, b, , d] = layout.nodes;
    expect(a).toMatchObject({ x: 0, y: 0 });
    expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeLessThan(Math.hypot(a!.x - d!.x, a!.y - d!.y));
    for (const node of layout.nodes)
      expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
  });

  it('starts from previous positions', () => {
    const layout = createLayout(
      buildGraph(notes, { kind: 'global' }),
      null,
      new Map([['d', { x: 500, y: -300 }]]),
    );
    expect(layout.nodes.find((node) => node.node.id === 'd')).toMatchObject({ x: 500, y: -300 });
  });
});

describe('renderer', () => {
  it('colours nodes by top-level folder and draws labels for small graphs', () => {
    const nodes = [
      at('a', 0, 0),
      { ...at('b', 50, 0), node: { ...at('b', 0, 0).node, group: 'work' } },
    ];
    expect(colourOf(nodes[0]!, ['work'], FALLBACK_THEME)).toBe(FALLBACK_THEME.ungrouped);
    expect(colourOf(nodes[1]!, [null, 'work'], FALLBACK_THEME)).toBe(FALLBACK_THEME.groups[1]);
    const { ctx, texts } = recorder();
    drawGraph(
      ctx,
      { width: 200, height: 100, ratio: 1 },
      nodes,
      [{ source: nodes[0]!, target: nodes[1]! }],
      ['work'],
      FALLBACK_THEME,
      state(),
    );
    expect(texts.sort()).toEqual(['a', 'b']);
  });

  it('labels only the busiest nodes in view of a big graph, plus the focused one', () => {
    const nodes = Array.from({ length: 500 }, (_, i) =>
      at(`n${i}`, (i % 25) * 8, Math.floor(i / 25) * 8, i),
    );
    const quiet = nodes[3]!;
    const shown = labelled(nodes, state({ focused: quiet }), 400, 400);
    expect(shown.length).toBe(41);
    expect(shown).toContain(quiet);
    expect(shown[0]!.node.degree).toBe(499);
  });

  it('finds the node under a point and the nearest node in a direction', () => {
    const nodes = [
      at('a', 0, 0),
      at('b', 100, 5),
      at('c', 0, 100),
      at('d', -100, 0),
      at('e', 30, 80),
    ];
    expect(nodeAt(nodes, { x: 103, y: 4 }, 2)?.node.id).toBe('b');
    expect(nodeAt(nodes, { x: 50, y: 50 }, 2)).toBeNull();
    expect(nodeInDirection(nodes, nodes[0]!, 'right')?.node.id).toBe('b');
    expect(nodeInDirection(nodes, nodes[0]!, 'down')?.node.id).toBe('c');
    expect(nodeInDirection(nodes, nodes[0]!, 'left')?.node.id).toBe('d');
    expect(nodeInDirection(nodes, nodes[0]!, 'up')).toBeNull();
  });

  it('fits every node in the view', () => {
    const nodes = [at('a', -100, -50), at('b', 100, 50)];
    const t = fitTransform(nodes, 400, 300, 0);
    expect(t.k).toBe(2);
    expect(-100 * t.k + t.x).toBe(0);
    expect(100 * t.k + t.x).toBe(400);
  });
});

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
