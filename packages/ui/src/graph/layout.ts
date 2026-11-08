/**
 * Force-directed layout (T17) with d3-force: Barnes–Hut many-body repulsion
 * (O(n log n), so 2,000 notes stay interactive), springs along links and a
 * gentle pull to the centre. Loaded with the graph view, never with the app
 * shell. The renderer reads node positions after each tick.
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { GraphData, GraphNode } from './model';

export interface LayoutNode extends SimulationNodeDatum {
  readonly node: GraphNode;
  /** Drawn radius, from the node's degree. */
  readonly radius: number;
  x: number;
  y: number;
}

type LayoutLink = SimulationLinkDatum<LayoutNode> & { readonly tag: boolean };

export interface Layout {
  readonly nodes: LayoutNode[];
  readonly links: Array<{ source: LayoutNode; target: LayoutNode; tag: boolean }>;
  /** Advances the simulation one step; false once it has settled. */
  tick(): boolean;
  /** Runs `count` steps at once (before the first frame). */
  settle(count: number): void;
  /** Pins a node (dragging) or releases it (null). */
  pin(node: LayoutNode, at: { x: number; y: number } | null): void;
  /** Wakes the simulation (after a drag). */
  reheat(alpha?: number): void;
  readonly alpha: number;
  stop(): void;
}

export const radiusOf = (node: GraphNode) =>
  node.kind === 'tag' ? 3.5 : 4 + Math.min(10, Math.sqrt(node.degree) * 2.2);

/**
 * @param previous where nodes were in the last layout (after a filter
 * change): they start there, so the graph shifts instead of starting over.
 */
export function createLayout(
  data: GraphData,
  centre: string | null = null,
  previous?: ReadonlyMap<string, { x: number; y: number }>,
): Layout {
  const count = data.nodes.length;
  let reused = 0;
  const nodes: LayoutNode[] = data.nodes.map((node, i) => {
    const before = previous?.get(node.id);
    if (before) reused++;
    // A sunflower spiral start: no overlaps, so the first ticks are calm.
    const angle = i * 2.399963;
    const r = 12 * Math.sqrt(i + 1);
    const at =
      node.id === centre
        ? { x: 0, y: 0 }
        : before
          ? { x: before.x, y: before.y }
          : { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    return { node, radius: radiusOf(node), ...at };
  });
  const byId = new Map(nodes.map((node) => [node.node.id, node]));
  const links: LayoutLink[] = data.edges.map((edge) => ({
    source: byId.get(edge.source)!,
    target: byId.get(edge.target)!,
    tag: edge.tag,
  }));
  const simulation: Simulation<LayoutNode, LayoutLink> = forceSimulation(nodes)
    .alphaDecay(count > 800 ? 0.035 : 0.025)
    .force(
      'charge',
      forceManyBody<LayoutNode>()
        .strength(count > 800 ? -45 : -90)
        .theta(0.9)
        .distanceMax(600),
    )
    .force(
      'link',
      forceLink<LayoutNode, LayoutLink>(links)
        .distance((link) => (link.tag ? 30 : 46))
        .strength(0.35),
    )
    .force('collide', forceCollide<LayoutNode>((node) => node.radius + 2).iterations(1))
    .force('x', forceX<LayoutNode>(0).strength(0.04))
    .force('y', forceY<LayoutNode>(0).strength(0.04))
    .stop();
  // Mostly known positions: a gentler start.
  if (count > 0 && reused / count > 0.5) simulation.alpha(0.4);
  if (centre && byId.has(centre)) {
    const node = byId.get(centre)!;
    node.fx = 0;
    node.fy = 0;
  }
  const settled = () => simulation.alpha() < simulation.alphaMin();
  return {
    nodes,
    links: links as Layout['links'],
    tick() {
      if (settled()) return false;
      simulation.tick();
      return true;
    },
    settle(steps) {
      for (let i = 0; i < steps && !settled(); i++) simulation.tick();
    },
    pin(node, at) {
      node.fx = at?.x ?? (node.node.id === centre ? 0 : null);
      node.fy = at?.y ?? (node.node.id === centre ? 0 : null);
    },
    reheat(alpha = 0.3) {
      simulation.alpha(Math.max(simulation.alpha(), alpha));
    },
    get alpha() {
      return simulation.alpha();
    },
    stop: () => simulation.stop(),
  };
}
