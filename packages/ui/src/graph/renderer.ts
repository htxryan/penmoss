/**
 * Draws the graph on a canvas (T17): one batched path for the edges, one per
 * colour for the nodes, labels only where they fit (busy nodes, the centre,
 * the hovered node's neighbours, or when zoomed in). Canvas 2D keeps 2,000
 * notes and 5,000 links at well over 30 fps without WebGL. Colours come from
 * the theme's tokens (`ThemeColors`), so light and dark both read well.
 */
import type { LayoutNode } from './layout';

export interface ThemeColors {
  readonly background: string;
  readonly edge: string;
  readonly edgeHighlight: string;
  readonly label: string;
  readonly labelHalo: string;
  readonly focus: string;
  readonly tag: string;
  /** Node colours by group, in order; the top level uses `ungrouped`. */
  readonly groups: readonly string[];
  readonly ungrouped: string;
  /** The label font family (the app's). */
  readonly font?: string;
}

export interface Transform {
  x: number;
  y: number;
  k: number;
}

export interface DrawState {
  readonly transform: Transform;
  readonly hovered: LayoutNode | null;
  readonly focused: LayoutNode | null;
  readonly centre: string | null;
  /** Ids next to the hovered or focused node (and it). */
  readonly neighbours: ReadonlySet<string> | null;
}

/** The part of CanvasRenderingContext2D the renderer uses (tests pass a recorder). */
export type Context2D = Pick<
  CanvasRenderingContext2D,
  | 'setTransform'
  | 'fillRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'arc'
  | 'rect'
  | 'stroke'
  | 'fill'
  | 'fillText'
  | 'strokeText'
  | 'measureText'
> & {
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  strokeStyle: CanvasRenderingContext2D['strokeStyle'];
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  lineJoin: CanvasLineJoin;
};

const LABEL_FONT = '500 11.5px system-ui, -apple-system, "Segoe UI", sans-serif';
const MAX_LABEL = 30;

/** Colour of a node: its group's, by the group's index in `groups` (stable order). */
export function colourOf(
  node: LayoutNode,
  groups: readonly (string | null)[],
  colors: ThemeColors,
): string {
  if (node.node.kind === 'tag') return colors.tag;
  if (node.node.group === null) return colors.ungrouped;
  const index = groups.indexOf(node.node.group);
  return colors.groups[index % colors.groups.length] ?? colors.ungrouped;
}

export function drawGraph(
  ctx: Context2D,
  size: { width: number; height: number; ratio: number },
  nodes: readonly LayoutNode[],
  links: readonly { source: LayoutNode; target: LayoutNode }[],
  groups: readonly (string | null)[],
  colors: ThemeColors,
  state: DrawState,
): void {
  const { width, height, ratio } = size;
  const { x, y, k } = state.transform;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(ratio * k, 0, 0, ratio * k, ratio * x, ratio * y);

  const near = state.neighbours;
  // Edges: everything in one path, then the highlighted ones on top.
  ctx.lineWidth = 1 / k;
  ctx.strokeStyle = colors.edge;
  ctx.globalAlpha = near ? 0.25 : 0.8;
  ctx.beginPath();
  for (const link of links) {
    ctx.moveTo(link.source.x, link.source.y);
    ctx.lineTo(link.target.x, link.target.y);
  }
  ctx.stroke();
  const active = state.hovered ?? state.focused;
  if (active) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.edgeHighlight;
    ctx.lineWidth = 1.6 / k;
    ctx.beginPath();
    for (const link of links) {
      if (link.source !== active && link.target !== active) continue;
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);
    }
    ctx.stroke();
  }

  // Nodes, batched by colour; dimmed when another node is highlighted.
  const byColour = new Map<string, LayoutNode[]>();
  for (const node of nodes) {
    const colour = colourOf(node, groups, colors);
    (byColour.get(colour) ?? byColour.set(colour, []).get(colour)!).push(node);
  }
  for (const pass of near ? ['dim', 'lit'] : ['all']) {
    for (const [colour, group] of byColour) {
      ctx.fillStyle = colour;
      ctx.globalAlpha = pass === 'dim' ? 0.2 : 1;
      ctx.beginPath();
      for (const node of group) {
        const lit = !near || near.has(node.node.id);
        if ((pass === 'dim' && lit) || (pass === 'lit' && !lit)) continue;
        if (node.node.kind === 'tag') {
          ctx.moveTo(node.x + node.radius, node.y);
          ctx.rect(node.x - node.radius, node.y - node.radius, node.radius * 2, node.radius * 2);
        } else {
          ctx.moveTo(node.x + node.radius, node.y);
          ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Rings: the centre of a local graph, and the keyboard focus.
  for (const [node, colour, width] of [
    [nodes.find((n) => n.node.id === state.centre) ?? null, colors.label, 2],
    [state.focused, colors.focus, 3],
  ] as const) {
    if (!node) continue;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width / k;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius + 3 / k, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Labels, at a constant size on screen: the highlighted nodes, and the busiest
  // nodes in view (more of them as you zoom in), so a big graph stays legible.
  ctx.font = colors.font ? `500 11.5px ${colors.font}` : LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  for (const node of labelled(nodes, state, width, height)) {
    const sx = node.x * k + x;
    const sy = (node.y + node.radius) * k + y + 3;
    const text =
      node.node.label.length > MAX_LABEL
        ? `${node.node.label.slice(0, MAX_LABEL - 1)}…`
        : node.node.label;
    ctx.globalAlpha = near && !near.has(node.node.id) ? 0.3 : 1;
    ctx.strokeStyle = colors.labelHalo;
    ctx.lineWidth = 3;
    ctx.strokeText(text, sx, sy);
    ctx.fillStyle = colors.label;
    ctx.fillText(text, sx, sy);
  }
  ctx.globalAlpha = 1;
}

/** Every node is labelled in a graph this small. */
const LABEL_ALL = 60;

/** The nodes to label, in drawing order. */
export function labelled(
  nodes: readonly LayoutNode[],
  state: DrawState,
  width: number,
  height: number,
): LayoutNode[] {
  const { x, y, k } = state.transform;
  const near = state.neighbours;
  const inView = (node: LayoutNode) => {
    const sx = node.x * k + x;
    const sy = node.y * k + y;
    return sx > -80 && sx < width + 80 && sy > -20 && sy < height + 20;
  };
  const must = (node: LayoutNode) =>
    node === state.focused || node === state.hovered || node.node.id === state.centre;
  const shown: LayoutNode[] = [];
  const others: LayoutNode[] = [];
  for (const node of nodes) {
    if (must(node)) shown.push(node);
    else if ((near ? near.has(node.node.id) : true) && inView(node)) others.push(node);
  }
  if (near || nodes.length <= LABEL_ALL) return [...others, ...shown];
  const cap = k >= 2.5 ? 400 : k >= 1.2 ? 120 : 40;
  others.sort((a, b) => b.node.degree - a.node.degree);
  return [...others.slice(0, cap), ...shown];
}

/** The node under a point in graph coordinates (within its radius plus `slop`), or null. */
export function nodeAt(
  nodes: readonly LayoutNode[],
  point: { x: number; y: number },
  slop: number,
): LayoutNode | null {
  let best: LayoutNode | null = null;
  let bestDistance = Infinity;
  for (const node of nodes) {
    const dx = node.x - point.x;
    const dy = node.y - point.y;
    const distance = Math.sqrt(dx * dx + dy * dy) - node.radius;
    if (distance <= slop && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

/** The nearest node from `from` in a direction (arrow keys), or null. */
export function nodeInDirection(
  nodes: readonly LayoutNode[],
  from: LayoutNode,
  direction: 'left' | 'right' | 'up' | 'down',
): LayoutNode | null {
  let best: LayoutNode | null = null;
  let bestScore = Infinity;
  for (const node of nodes) {
    if (node === from) continue;
    const dx = node.x - from.x;
    const dy = node.y - from.y;
    const along =
      direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    // Prefer nodes straight ahead: sideways distance counts double.
    const score = along + across * 2;
    if (score < bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

/** A transform that fits every node in the view, with padding. */
export function fitTransform(
  nodes: readonly LayoutNode[],
  width: number,
  height: number,
  padding = 60,
): Transform {
  if (nodes.length === 0) return { x: width / 2, y: height / 2, k: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
  }
  const k = Math.min(
    2.5,
    Math.max(
      0.05,
      Math.min(width / (maxX - minX + padding * 2), height / (maxY - minY + padding * 2)),
    ),
  );
  return { k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k };
}
