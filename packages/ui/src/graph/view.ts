/**
 * The graph view's rules that the Mac's canvas (`GraphCanvas.tsx`, mouse and keys) and the
 * phone's page (`apps/android/editor/src/graph-host.ts`, touch) share (T17, A478): how far it
 * zooms and how a graph opens.
 */

/** The farthest out and in the view zooms. */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 6;

export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Whether the person asked for less motion (the system's Reduce Motion). */
const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Graphs this small open settled; larger ones settle a little, then move into place. */
export const SMALL_GRAPH = 300;

/** The layout ticks run before a graph's first frame: all of them for a small graph, or with less motion. */
export function openingTicks(nodeCount: number): number {
  return nodeCount <= SMALL_GRAPH || reducedMotion() ? 300 : 40;
}
