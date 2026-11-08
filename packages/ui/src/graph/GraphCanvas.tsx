/**
 * The interactive graph canvas (T17): runs the force layout, draws each
 * frame while it moves, and handles the pointer (pan, zoom, drag a node,
 * click to open) and the keyboard (arrows move between nodes, Enter opens,
 * + − 0 zoom, letters jump to a title). Everything per frame lives in refs,
 * so React renders only when the data or the focused node's announcement
 * changes, and input only asks for a frame: one draw per frame however many
 * pointer events arrive.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createLayout, type Layout, type LayoutNode } from './layout';
import type { GraphData } from './model';
import {
  drawGraph,
  fitTransform,
  nodeAt,
  nodeInDirection,
  type ThemeColors,
  type Transform,
} from './renderer';
import { readTheme, watchTheme } from './theme';

export interface GraphCanvasProps {
  readonly data: GraphData;
  /** Top-level folder ids in colour order (null: the top level). */
  readonly groups: readonly (string | null)[];
  /** The local graph's note, drawn with a ring and kept in the middle. */
  readonly centre: string | null;
  /** A group's name, for the keyboard announcement. */
  readonly groupName?: (group: string | null) => string | null;
  readonly onOpen: (id: string, newTab: boolean) => void;
  readonly label: string;
}

/** What tests and the perf harness read from the canvas element (`penmossGraph`). */
export interface GraphInspector {
  /** A node's centre in CSS pixels from the canvas's top left, or null. */
  positionOf(id: string): { x: number; y: number } | null;
  /** Whether the layout has stopped moving. */
  readonly settled: boolean;
  /** Milliseconds of work (layout step plus drawing) for recent frames. */
  frameTimes(): number[];
  readonly nodeCount: number;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 6;
const CLICK_SLOP = 4;
const TYPEAHEAD_MS = 800;

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Drag =
  | { kind: 'pan'; startX: number; startY: number; origin: Transform; moved: boolean }
  | { kind: 'node'; node: LayoutNode; startX: number; startY: number; moved: boolean };

export function GraphCanvas({ data, groups, centre, groupName, onOpen, label }: GraphCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [announcement, setAnnouncement] = useState('');
  // Mutable view state, read by the frame loop.
  const view = useRef({
    layout: null as Layout | null,
    transform: { x: 0, y: 0, k: 1 },
    /** Keep fitting the graph to the view until the user pans or zooms. */
    autoFit: true,
    hovered: null as LayoutNode | null,
    focused: null as LayoutNode | null,
    hasFocus: false,
    size: { width: 0, height: 0, ratio: 1 },
    theme: null as ThemeColors | null,
    frame: 0,
    times: [] as number[],
    draw: () => {},
    schedule: () => {},
    typed: { text: '', at: 0 },
  });
  const latest = useRef({ onOpen, groups, centre, groupName });
  latest.current = { onOpen, groups, centre, groupName };

  // The frame loop, the theme and the canvas size: once per mount.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d');
    const state = view.current;
    state.theme = readTheme(canvas);

    // The keyboard focus shows (ring, neighbours) only while the canvas has focus.
    const focused = () => (state.hasFocus ? state.focused : null);
    const neighbours = () => {
      const active = state.hovered ?? focused();
      if (!active || !state.layout) return null;
      const ids = new Set([active.node.id]);
      for (const link of state.layout.links) {
        if (link.source === active) ids.add(link.target.node.id);
        else if (link.target === active) ids.add(link.source.node.id);
      }
      return ids;
    };
    state.draw = () => {
      const layout = state.layout;
      if (!ctx || !layout || !state.theme || state.size.width === 0) return;
      drawGraph(ctx, state.size, layout.nodes, layout.links, latest.current.groups, state.theme, {
        transform: state.transform,
        hovered: state.hovered,
        focused: focused(),
        centre: latest.current.centre,
        neighbours: neighbours(),
      });
    };
    const frame = () => {
      state.frame = 0;
      const layout = state.layout;
      if (!layout) return;
      const start = performance.now();
      const moving = layout.tick();
      if (moving && state.autoFit) {
        state.transform = fitTransform(layout.nodes, state.size.width, state.size.height);
      }
      state.draw();
      state.times.push(performance.now() - start);
      if (state.times.length > 240) state.times.splice(0, state.times.length - 240);
      if (moving) state.schedule();
    };
    state.schedule = () => {
      state.frame ||= requestAnimationFrame(frame);
    };

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      state.size = { width: rect.width, height: rect.height, ratio };
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      if (state.autoFit && state.layout) {
        state.transform = fitTransform(state.layout.nodes, rect.width, rect.height);
      }
      state.draw();
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(wrap);
    resize();
    const offTheme = watchTheme(() => {
      state.theme = readTheme(canvas);
      state.draw();
    });

    // Wheel zoom around the pointer (a non-passive listener, to keep the page still).
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0015));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const inspector: GraphInspector = {
      positionOf(id) {
        const node = state.layout?.nodes.find((candidate) => candidate.node.id === id);
        if (!node) return null;
        const { x, y, k } = state.transform;
        return { x: node.x * k + x, y: node.y * k + y };
      },
      get settled() {
        return !state.layout || state.layout.alpha < 0.001 || state.frame === 0;
      },
      frameTimes: () => [...state.times],
      get nodeCount() {
        return state.layout?.nodes.length ?? 0;
      },
    };
    Object.defineProperty(canvas, 'penmossGraph', { value: inspector, configurable: true });

    return () => {
      observer?.disconnect();
      offTheme();
      canvas.removeEventListener('wheel', onWheel);
      if (state.frame) cancelAnimationFrame(state.frame);
      state.frame = 0;
      state.layout?.stop();
    };
  }, []);

  // A new layout whenever the shown graph changes, starting from the old positions.
  useEffect(() => {
    const state = view.current;
    const previous = new Map(
      (state.layout?.nodes ?? []).map((node) => [node.node.id, { x: node.x, y: node.y }]),
    );
    state.layout?.stop();
    const layout = createLayout(data, centre, previous);
    state.layout = layout;
    const byId = new Map(layout.nodes.map((node) => [node.node.id, node]));
    state.hovered = null;
    state.focused = state.focused ? (byId.get(state.focused.node.id) ?? null) : null;
    // Small graphs open settled; big ones settle a little, then move into place.
    const small = layout.nodes.length <= 300;
    layout.settle(small || reducedMotion() ? 300 : 40);
    if (previous.size === 0) state.autoFit = true;
    if (state.autoFit) {
      state.transform = fitTransform(layout.nodes, state.size.width, state.size.height);
    }
    state.draw();
    state.schedule();
  }, [data, centre]);

  function zoomAt(px: number, py: number, factor: number) {
    const state = view.current;
    const { x, y, k } = state.transform;
    const next = clampZoom(k * factor);
    state.autoFit = false;
    state.transform = {
      k: next,
      x: px - ((px - x) / k) * next,
      y: py - ((py - y) / k) * next,
    };
    state.schedule();
  }

  function toGraph(clientX: number, clientY: number) {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { x, y, k } = view.current.transform;
    return { x: (clientX - rect.left - x) / k, y: (clientY - rect.top - y) / k };
  }

  function hit(clientX: number, clientY: number) {
    const state = view.current;
    if (!state.layout) return null;
    return nodeAt(state.layout.nodes, toGraph(clientX, clientY), 4 / state.transform.k);
  }

  const drag = useRef<Drag | null>(null);

  function announce(node: LayoutNode | null) {
    if (!node) {
      setAnnouncement('');
      return;
    }
    const links = node.node.degree === 1 ? '1 link' : `${node.node.degree} links`;
    const group =
      node.node.kind === 'tag' ? 'tag' : (latest.current.groupName?.(node.node.group) ?? null);
    setAnnouncement(
      `${node.node.label}, ${links}${group ? `, ${group}` : ''}. Enter opens${
        node.node.kind === 'tag' ? ' nothing' : ''
      }.`,
    );
  }

  function focusNode(node: LayoutNode | null) {
    const state = view.current;
    state.focused = node;
    if (node) {
      // Keep the focused node in view.
      const { x, y, k } = state.transform;
      const sx = node.x * k + x;
      const sy = node.y * k + y;
      const margin = 40;
      const { width, height } = state.size;
      if (sx < margin || sx > width - margin || sy < margin || sy > height - margin) {
        state.autoFit = false;
        state.transform = { k, x: width / 2 - node.x * k, y: height / 2 - node.y * k };
      }
    }
    announce(node);
    state.schedule();
  }

  function open(node: LayoutNode, newTab: boolean) {
    if (node.node.kind !== 'note') return;
    latest.current.onOpen(node.node.id, newTab);
  }

  function startNode(): LayoutNode | null {
    const nodes = view.current.layout?.nodes ?? [];
    const centreNode = nodes.find((node) => node.node.id === latest.current.centre);
    if (centreNode) return centreNode;
    return nodes.reduce<LayoutNode | null>(
      (best, node) => (!best || node.node.degree > best.node.degree ? node : best),
      null,
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    const state = view.current;
    const nodes = state.layout?.nodes ?? [];
    const { width, height } = state.size;
    const arrows: Record<string, 'left' | 'right' | 'up' | 'down'> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
    };
    const direction = arrows[event.key];
    if (direction) {
      event.preventDefault();
      if (!state.focused) focusNode(startNode());
      else focusNode(nodeInDirection(nodes, state.focused, direction) ?? state.focused);
      return;
    }
    if (event.key === 'Enter' && state.focused) {
      event.preventDefault();
      open(state.focused, event.metaKey || event.ctrlKey || event.shiftKey);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusNode(startNode());
      return;
    }
    if (event.key === 'Escape' && state.focused) {
      event.preventDefault();
      focusNode(null);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Type-ahead: letters jump to the busiest node whose title starts with them. Once a
    // title is being typed, spaces, digits and signs belong to it, not to the zoom keys.
    const now = Date.now();
    const typing = state.typed.text !== '' && now - state.typed.at < TYPEAHEAD_MS;
    if (event.key.length === 1 && (typing || /[\p{L}]/u.test(event.key))) {
      const typed = typing ? state.typed.text + event.key : event.key;
      state.typed = { text: typed, at: now };
      event.preventDefault();
      const wanted = typed.toLowerCase();
      const match = nodes
        .filter((node) => node.node.label.toLowerCase().startsWith(wanted))
        .sort((a, b) => b.node.degree - a.node.degree)[0];
      if (match) focusNode(match);
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomAt(width / 2, height / 2, 1.25);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomAt(width / 2, height / 2, 0.8);
    } else if (event.key === '0') {
      event.preventDefault();
      state.autoFit = true;
      state.transform = fitTransform(nodes, width, height);
      state.schedule();
    }
  }

  return (
    <div className="pm-graph-canvas" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        data-testid="graph-canvas"
        tabIndex={0}
        role="application"
        aria-roledescription="graph"
        aria-label={label}
        aria-describedby="pm-graph-help"
        onKeyDown={onKeyDown}
        onFocus={() => {
          view.current.hasFocus = true;
          if (view.current.focused) announce(view.current.focused);
          view.current.schedule();
        }}
        onBlur={() => {
          view.current.hasFocus = false;
          view.current.schedule();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const node = hit(event.clientX, event.clientY);
          event.currentTarget.setPointerCapture?.(event.pointerId);
          drag.current = node
            ? { kind: 'node', node, startX: event.clientX, startY: event.clientY, moved: false }
            : {
                kind: 'pan',
                startX: event.clientX,
                startY: event.clientY,
                origin: view.current.transform,
                moved: false,
              };
        }}
        onPointerMove={(event) => {
          const state = view.current;
          const current = drag.current;
          if (current) {
            const dx = event.clientX - current.startX;
            const dy = event.clientY - current.startY;
            if (!current.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
            current.moved = true;
            state.autoFit = false;
            if (current.kind === 'pan') {
              state.transform = {
                ...current.origin,
                x: current.origin.x + dx,
                y: current.origin.y + dy,
              };
              state.schedule();
            } else {
              state.layout?.pin(current.node, toGraph(event.clientX, event.clientY));
              state.layout?.reheat(0.2);
              state.schedule();
            }
            return;
          }
          const node = hit(event.clientX, event.clientY);
          if (node !== state.hovered) {
            state.hovered = node;
            event.currentTarget.style.cursor = node?.node.kind === 'note' ? 'pointer' : '';
            state.schedule();
          }
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          drag.current = null;
          if (!current) return;
          if (current.kind === 'node') {
            view.current.layout?.pin(current.node, null);
            if (!current.moved) {
              focusNode(current.node);
              open(current.node, event.metaKey || event.ctrlKey);
            }
          }
        }}
        onPointerCancel={() => {
          if (drag.current?.kind === 'node') view.current.layout?.pin(drag.current.node, null);
          drag.current = null;
        }}
        onPointerLeave={() => {
          const state = view.current;
          if (state.hovered && !drag.current) {
            state.hovered = null;
            state.schedule();
          }
        }}
      />
      <p id="pm-graph-help" className="pm-visually-hidden">
        Arrow keys move between notes, Enter opens the note, plus and minus zoom, 0 fits the graph,
        and typing jumps to a title.
      </p>
      <p className="pm-visually-hidden" aria-live="polite" data-testid="graph-announcement">
        {announcement}
      </p>
    </div>
  );
}
