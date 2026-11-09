import { describe, expect, it } from 'vitest';
import { createLayout, type LayoutNode } from '../src/graph/layout';
import { buildGraph, type GraphNoteInput } from '../src/graph/model';
import {
  colourOf,
  drawGraph,
  fitTransform,
  labelled,
  nodeAt,
  nodeInDirection,
} from '../src/graph/renderer';
import { FALLBACK_THEME } from '../src/graph/theme';
import { recorder, state } from './support/graph';

// The frame-time budget over 2,000 notes is graph-render.budget.test.ts (A1244).

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
